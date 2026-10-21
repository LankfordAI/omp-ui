/**
 * Fleet exec ladder, node side (issue #901, ADR-0062 as amended): the owner
 * half. The controlled machine holds its own ceiling — every rung decision,
 * command run, project verb, and grant raise lands here, keyed on the
 * CLAIMED dispatcher identity in the request. Refusals are answers: they ride
 * the outcome's `reason`, never a transport error.
 */
import { execFile as execFileCb, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  FLEET_CLONE_TIMEOUT_MS,
  FLEET_EXEC_OUTPUT_MAX,
  FLEET_EXEC_TIMEOUT_MIN_MS,
  FLEET_EXEC_TIMEOUT_MS,
  fleetEffectiveRung,
  fleetRungAtLeast,
  fleetRungRank,
  type FleetAuditEntry,
  type FleetExecOutcome,
  type FleetExecRequest,
  type FleetGrantRaiseOutcome,
  type FleetGrantRaiseRequest,
  type FleetGrantRecord,
  type FleetProjectManageOutcome,
  type FleetProjectManageRequest,
  type FleetRequester,
  type FleetRung,
  Registry,
} from "@omp-ui/core";
import { passwordSessionCredential, tokenMatches, verifyRemotePassword } from "@omp-ui/server";
import { appendMainLog } from "./main-log";

const AUDIT_RING_CAPACITY = 200;
const AUDIT_DETAIL_LIMIT = 200;

export interface FleetCommandSpec {
  command: string;
  cwd: string | null;
  timeoutMs: number | null;
}

export interface FleetSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
}

export interface FleetCommandDeps {
  platform?: NodeJS.Platform;
  homeDir?: () => string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: the argv triple is handed to this spawner verbatim. */
  spawnFn?: (command: string, args: string[], opts: FleetSpawnOptions) => ChildProcess;
}

interface ShellChoice {
  file: string;
  args: string[];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The shells, fixed per platform (deterministic across members, never $SHELL). */
function shellPlan(platform: NodeJS.Platform, command: string): ShellChoice[] {
  if (platform === "win32") {
    return [
      { file: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", command] },
      { file: process.env["COMSPEC"] ?? "cmd.exe", args: ["/d", "/c", command] },
    ];
  }
  return [{ file: "/bin/sh", args: ["-c", command] }];
}

/** Group kill on POSIX (the child leads its own group), taskkill tree on win32. */
function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  if (child.pid === undefined) return;
  if (platform === "win32") {
    try {
      spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      // A dead child or missing taskkill changes nothing about the outcome.
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (err) {
    // ESRCH: the tree already exited between the timeout and the kill.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/**
 * Run one bounded command: fresh child, no PTY, no stdin, byte-capped output,
 * hard timeout with a tree kill. Inherits the node user's environment; the
 * caller can never override env or argv shape.
 */
export function runFleetCommand(spec: FleetCommandSpec, deps: FleetCommandDeps = {}): Promise<FleetExecOutcome> {
  const platform = deps.platform ?? process.platform;
  const homeDir = deps.homeDir ?? os.homedir;
  const env = deps.env ?? process.env;
  const timeoutMs =
    spec.timeoutMs === null
      ? FLEET_EXEC_TIMEOUT_MS
      : Math.min(FLEET_EXEC_TIMEOUT_MS, Math.max(FLEET_EXEC_TIMEOUT_MIN_MS, Math.floor(spec.timeoutMs)));
  let cwd: string;
  if (spec.cwd === null) {
    cwd = homeDir();
  } else {
    try {
      if (!fs.statSync(spec.cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      return Promise.resolve({ status: "refused", reason: `cwd ${spec.cwd} is not a directory on this machine` });
    }
    cwd = spec.cwd;
  }
  const plan = shellPlan(platform, spec.command);
  const spawner = deps.spawnFn ?? defaultSpawn;
  return attempt(0);

  function attempt(index: number): Promise<FleetExecOutcome> {
    const choice = plan[index]!;
    let child: ChildProcess;
    try {
      child = spawner(choice.file, choice.args, { cwd, env, detached: platform !== "win32" });
    } catch (err) {
      return Promise.resolve({ status: "refused", reason: `could not start the shell: ${messageOf(err)}` });
    }
    const { promise, resolve } = Promise.withResolvers<FleetExecOutcome>();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const absorb = (sink: Buffer[], length: () => number, grow: (n: number) => void) => (data: Buffer): void => {
      const room = FLEET_EXEC_OUTPUT_MAX - length();
      if (room <= 0) {
        truncated = true;
        return;
      }
      const keep = data.subarray(0, room);
      sink.push(keep);
      grow(keep.length);
      if (keep.length < data.length) truncated = true;
    };
    child.stdout?.on("data", absorb(out, () => outLen, (n) => (outLen += n)));
    child.stderr?.on("data", absorb(err, () => errLen, (n) => (errLen += n)));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, platform);
    }, timeoutMs);
    const finish = (exitCode: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Byte caps land before decode; a split multibyte tail decodes to one
      // replacement character — acceptable, never a crash. A spawn error keeps
      // timedOut as observed but reports no exit code.
      resolve({
        status: "accepted",
        exitCode: spawnError === null ? exitCode : null,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: spawnError === null ? Buffer.concat(err).toString("utf8") : spawnError,
        truncated,
        timedOut,
      });
    };
    child.on("error", (e) => {
      // Win32: a missing pwsh (ENOENT on spawn error) retries once on cmd.exe.
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && index + 1 < plan.length) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(attempt(index + 1));
        return;
      }
      finish(null, messageOf(e));
    });
    child.on("close", (code) => finish(code, null));
    // A kill race: the child exits between the timeout and the signal — keep
    // its exit code and output, timedOut stays true.
    return promise;
  }
}

function defaultSpawn(command: string, args: string[], opts: FleetSpawnOptions): ChildProcess {
  return spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: opts.detached, stdio: ["ignore", "pipe", "pipe"] });
}

export interface FleetServerDeps {
  registry: Registry;
  logDir: string;
  broadcast: () => void;
  /** The backend's shared registration path (project:add's body, issue #904); rejects with a user-facing reason. */
  addProject: (dir: string) => Promise<void>;
  /** Test seams. */
  commandDeps?: FleetCommandDeps;
  execGit?: (file: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<{ stdout: Buffer }>;
}

export class FleetServer {
  readonly #deps: FleetServerDeps;
  readonly #ring: FleetAuditEntry[] = [];

  constructor(deps: FleetServerDeps) {
    this.#deps = deps;
  }

  /**
   * The ladder check: effective rung = min(grant ?? "dispatch", ceiling);
   * rung 4 additionally requires the host master switch. First sight of a
   * dispatcher records it (label only) so the Fleet-access UI can name it.
   */
  check(requester: FleetRequester, need: FleetRung): { ok: true; rung: FleetRung } | { ok: false; reason: string } {
    this.#recordFirstSight(requester);
    const registry = this.#deps.registry;
    const ceiling = registry.getSetting("fleetExecCeiling");
    const rung = fleetEffectiveRung(registry.getSetting("fleetGrants")[requester.instanceId], ceiling);
    if (!fleetRungAtLeast(rung, need)) {
      return { ok: false, reason: `${requester.label} holds fleet access "${rung}" on this machine; this call needs "${need}"` };
    }
    if (fleetRungRank(need) === 4 && !registry.getSetting("fleetExecEnabled")) {
      return { ok: false, reason: "fleet exec is off on this machine (Settings → Remote instances → Fleet access)" };
    }
    return { ok: true, rung };
  }

  /** `fleet:grantRung`: the dispatcher's effective rung here (observe floor — never refused). */
  grantRung(requester: FleetRequester): { rung: FleetRung; ceiling: FleetRung; execEnabled: boolean } {
    this.#recordFirstSight(requester);
    const registry = this.#deps.registry;
    return {
      rung: fleetEffectiveRung(registry.getSetting("fleetGrants")[requester.instanceId], registry.getSetting("fleetExecCeiling")),
      ceiling: registry.getSetting("fleetExecCeiling"),
      execEnabled: registry.getSetting("fleetExecEnabled"),
    };
  }

  /** `fleet:exec`: ladder (rung 4 + master switch), then the bounded runner. */
  async exec(req: FleetExecRequest): Promise<FleetExecOutcome> {
    const gate = this.check(req.requester, "full");
    if (!gate.ok) {
      this.#audit("exec", req.requester, "full", false, req.command, null);
      return { status: "refused", reason: gate.reason };
    }
    const outcome = await runFleetCommand({ command: req.command, cwd: req.cwd, timeoutMs: req.timeoutMs }, this.#deps.commandDeps);
    this.#audit(
      "exec",
      req.requester,
      gate.rung,
      outcome.status === "accepted",
      req.command,
      outcome.status === "accepted" ? outcome.exitCode : null,
    );
    return outcome;
  }

  /** `fleet:projectManage`: rung 3 + declared roots; the fixed clone/register verbs. */
  async projectManage(req: FleetProjectManageRequest): Promise<FleetProjectManageOutcome> {
    const gate = this.check(req.requester, "manage");
    if (!gate.ok) {
      this.#audit("manage", req.requester, "manage", false, req.verb, null);
      return { status: "refused", reason: gate.reason };
    }
    const roots = this.#deps.registry.getSetting("fleetProjectRoots");
    if (roots.length === 0) {
      this.#audit("manage", req.requester, gate.rung, false, req.verb, null);
      return { status: "refused", reason: "no project roots are declared on this machine" };
    }
    const outcome = req.verb === "clone" ? await this.#clone(req.repositoryUrl, roots) : await this.#register(req.path, roots);
    this.#audit(
      "manage",
      req.requester,
      gate.rung,
      outcome.status === "accepted",
      `${req.verb} ${outcome.status === "accepted" ? outcome.path : ""}`.trim(),
      null,
    );
    return outcome;
  }

  async #clone(repositoryUrl: string, roots: string[]): Promise<FleetProjectManageOutcome> {
    let url: URL;
    try {
      url = new URL(repositoryUrl);
    } catch {
      return { status: "refused", reason: "repositoryUrl must be a valid URL" };
    }
    if (url.protocol !== "https:") return { status: "refused", reason: "clone accepts https URLs only" };
    if (url.username !== "" || url.password !== "") return { status: "refused", reason: "repositoryUrl must not carry credentials" };
    const segments = url.pathname.split("/").filter((s) => s !== "");
    const name = (segments[segments.length - 1] ?? "").replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "");
    if (name === "" || name === "." || name === "..") return { status: "refused", reason: "repositoryUrl has no usable repository name" };
    let dest: string | null = null;
    for (const root of roots) {
      const candidate = path.join(root, name);
      if (!fs.existsSync(candidate)) {
        dest = candidate;
        break;
      }
    }
    if (dest === null) return { status: "refused", reason: `every project root already holds a directory named ${name}` };
    try {
      await this.#git(["clone", "--", url.toString(), dest], { cwd: path.dirname(dest), timeout: FLEET_CLONE_TIMEOUT_MS });
    } catch (err) {
      const message = messageOf(err);
      if (/timed out|ETIMEDOUT/i.test(message)) {
        return { status: "refused", reason: "clone timed out — use fleet.exec for long-running setup" };
      }
      return { status: "refused", reason: `git clone failed: ${message.split("\n")[0]}` };
    }
    try {
      await this.#deps.addProject(dest);
    } catch (err) {
      return { status: "refused", reason: `cloned to ${dest} but registration failed: ${messageOf(err)}` };
    }
    return { status: "accepted", path: dest, headCommit: await this.#headCommit(dest) };
  }

  async #register(rawPath: string, roots: string[]): Promise<FleetProjectManageOutcome> {
    let real: string;
    try {
      real = fs.realpathSync(rawPath);
    } catch {
      return { status: "refused", reason: `${rawPath} does not exist on this machine` };
    }
    const underRoot = roots.some((root) => {
      let realRoot: string;
      try {
        realRoot = fs.realpathSync(root);
      } catch {
        return false;
      }
      return real === realRoot || real.startsWith(realRoot + path.sep);
    });
    if (!underRoot) return { status: "refused", reason: `${real} is not under a declared project root` };
    if (!fs.existsSync(path.join(real, ".git"))) return { status: "refused", reason: `${real} is not a git checkout (no .git)` };
    try {
      await this.#deps.addProject(real);
    } catch (err) {
      return { status: "refused", reason: `registration failed: ${messageOf(err)}` };
    }
    return { status: "accepted", path: real, headCommit: await this.#headCommit(real) };
  }

  async #headCommit(dir: string): Promise<string | null> {
    try {
      const { stdout } = await this.#git(["rev-parse", "HEAD"], { cwd: dir, timeout: 5_000 });
      const head = stdout.toString("utf8").trim();
      return head === "" ? null : head;
    } catch {
      return null;
    }
  }

  #git(args: string[], opts: { cwd: string; timeout: number }): Promise<{ stdout: Buffer }> {
    const injected = this.#deps.execGit;
    if (injected !== undefined) return injected("git", args, opts);
    const { promise, resolve, reject } = Promise.withResolvers<{ stdout: Buffer }>();
    execFileCb("git", args, { ...opts, maxBuffer: 1_048_576 }, (err, stdout) => {
      if (err !== null) reject(err);
      else resolve({ stdout: Buffer.from(stdout) });
    });
    return promise;
  }

  /**
   * `fleet:grantRaise`: the manager re-presents the node's join credential;
   * this node verifies it against its OWN settings before writing any grant.
   * The credential never enters a log or the audit ring.
   */
  grantRaise(req: FleetGrantRaiseRequest): FleetGrantRaiseOutcome {
    const registry = this.#deps.registry;
    if (!this.#credentialMatches(req.credential)) {
      this.#audit("grant-raise", req.requester, "raise", false, `target ${req.targetRung}: wrong credential`, null);
      return { ok: false, reason: "the token or password does not match this machine" };
    }
    const ceiling = registry.getSetting("fleetExecCeiling");
    if (fleetRungRank(req.targetRung) > fleetRungRank(ceiling)) {
      this.#audit("grant-raise", req.requester, "raise", false, `target ${req.targetRung}: above ceiling ${ceiling}`, null);
      return { ok: false, reason: `this machine's ceiling is "${ceiling}"; a grant above it never takes effect` };
    }
    const grants = { ...registry.getSetting("fleetGrants") };
    grants[req.requester.instanceId] = { rung: req.targetRung, label: req.requester.label, updatedAt: new Date().toISOString() };
    registry.setSetting("fleetGrants", grants);
    this.#deps.broadcast();
    this.#audit("grant-raise", req.requester, "raise", true, `raised to ${req.targetRung}`, null);
    return { ok: true, rung: req.targetRung };
  }

  /**
   * Node-local grant edit (Settings → Fleet access). null resets to the join
   * default: the label-only record stays so the dispatcher keeps its row.
   */
  setGrant(dispatcherId: string, rung: FleetRung | null): void {
    const registry = this.#deps.registry;
    const grants = { ...registry.getSetting("fleetGrants") };
    const label = grants[dispatcherId]?.label ?? "";
    if (rung === null && grants[dispatcherId]?.rung === undefined) return;
    grants[dispatcherId] = { ...(rung === null ? {} : { rung }), label, updatedAt: new Date().toISOString() };
    registry.setSetting("fleetGrants", grants);
    this.#audit(
      "grant-set",
      { instanceId: dispatcherId, label, kind: "user", sourceTabId: null },
      "set",
      true,
      rung === null ? "reset to default" : `set ${rung}`,
      null,
    );
  }

  #credentialMatches(credential: string): boolean {
    const registry = this.#deps.registry;
    if (credential === "") return false;
    if (tokenMatches(registry.getSetting("remoteToken"), credential)) return true;
    const hash = registry.getSetting("remotePasswordHash");
    if (hash === "") return false;
    // A password holder's browser session credential is the same secret they
    // could type; accept it too (same rule as the transport's cookie path).
    if (tokenMatches(passwordSessionCredential(hash), credential)) return true;
    return verifyRemotePassword(credential, registry.getSetting("remotePasswordSalt"), hash);
  }

  #recordFirstSight(requester: FleetRequester): void {
    const registry = this.#deps.registry;
    const grants = registry.getSetting("fleetGrants");
    if (requester.instanceId in grants) return;
    // Label-only record: the default rung stays in force (rung omitted).
    const next: Record<string, FleetGrantRecord> = {
      ...grants,
      [requester.instanceId]: { label: requester.label, updatedAt: new Date().toISOString() },
    };
    registry.setSetting("fleetGrants", next);
  }

  /** Newest last, ring-capped (the breadcrumbs idiom; fleet-audit.log on disk). */
  auditEntries(): FleetAuditEntry[] {
    return [...this.#ring];
  }

  #audit(
    action: FleetAuditEntry["action"],
    requester: FleetRequester,
    rung: FleetAuditEntry["rung"],
    accepted: boolean,
    detail: string,
    exitCode: number | null,
  ): void {
    const entry: FleetAuditEntry = {
      at: new Date().toISOString(),
      dispatcherId: requester.instanceId,
      dispatcherLabel: requester.label,
      sourceTabId: requester.sourceTabId,
      action,
      rung,
      accepted,
      detail: detail.length > AUDIT_DETAIL_LIMIT ? `${detail.slice(0, AUDIT_DETAIL_LIMIT - 1)}…` : detail,
      exitCode,
    };
    this.#ring.push(entry);
    if (this.#ring.length > AUDIT_RING_CAPACITY) this.#ring.shift();
    appendMainLog(this.#deps.logDir, "fleet-audit.log", JSON.stringify(entry));
  }
}
