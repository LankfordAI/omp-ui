/**
 * Fleet exec ladder, node side (issue #901, ADR-0062 as amended): the owner
 * half. The controlled machine holds its own ceiling — every rung decision,
 * command run, project verb, and grant raise lands here, keyed on the
 * CLAIMED dispatcher identity in the request. Refusals are answers: they ride
 * the outcome's `reason`, never a transport error.
 */
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FLEET_CLONE_TIMEOUT_MS,
  FLEET_EXEC_OUTPUT_MAX,
  FLEET_EXEC_TIMEOUT_MIN_MS,
  FLEET_EXEC_TIMEOUT_MS,
  fleetEffectiveRung,
  fleetRungAtLeast,
  fleetRungRank,
  type AppUpdateState,
  type FleetAuditEntry,
  type FleetDetachedExecRequest,
  type FleetDetachedExecStartOutcome,
  type FleetExecOutcome,
  type FleetExecPollOutcome,
  type FleetExecPollRequest,
  type FleetExecRequest,
  type FleetGrantRaiseOutcome,
  type FleetGrantRaiseRequest,
  type FleetGrantRecord,
  type FleetProjectManageOutcome,
  type FleetProjectManageRequest,
  type FleetProviderKeysOutcome,
  type FleetProviderKeysRequest,
  type FleetRequester,
  type FleetRung,
  type FleetSendOutcome,
  type FleetSendRequest,
  type FleetFinishOutcome,
  type FleetFinishRequest,
  type FleetUpdateAck,
  type FleetUpdateMemberRequest,
  type FleetUpdatePollOutcome,
  type FleetUpdatePollRequest,
  Registry,
  checkOmpUpdate as coreCheckOmpUpdate,
  downloadOmp,
  fetchLatestOmpVersion,
  managedOmpPath,
  readInstalledOmpVersion,
} from "@omp-ui/core";
import { passwordSessionCredential, tokenMatches, verifyRemotePassword } from "@omp-ui/server";
import { FleetDetachedExecs } from "./fleet-detached-exec";
import { FleetMaintenance } from "./fleet-maintenance";
import { launchFleetShell, messageOf, resolveFleetCwd, type FleetCommandDeps, type FleetCommandSpec } from "./fleet-shell";
import { isAutoUpdateFormat } from "./app-update";
import { appendMainLog } from "./main-log";

const AUDIT_RING_CAPACITY = 200;
const AUDIT_DETAIL_LIMIT = 200;

/**
 * Run one bounded command: fresh child, no PTY, no stdin, byte-capped output,
 * hard timeout with a tree kill. Inherits the node user's environment; the
 * caller can never override env or argv shape.
 */
export function runFleetCommand(spec: FleetCommandSpec, deps: FleetCommandDeps = {}): Promise<FleetExecOutcome> {
  const timeoutMs =
    spec.timeoutMs === null
      ? FLEET_EXEC_TIMEOUT_MS
      : Math.min(FLEET_EXEC_TIMEOUT_MS, Math.max(FLEET_EXEC_TIMEOUT_MIN_MS, Math.floor(spec.timeoutMs)));
  const resolved = resolveFleetCwd(spec.cwd, deps.homeDir ?? os.homedir);
  if (!resolved.ok) return Promise.resolve({ status: "refused", reason: resolved.reason });
  const sinks = { stdout: { chunks: [] as Buffer[], length: 0 }, stderr: { chunks: [] as Buffer[], length: 0 } };
  let truncated = false;
  let timedOut = false;
  const handle = launchFleetShell(spec.command, resolved.cwd, deps, (stream, data) => {
    const sink = sinks[stream];
    const room = FLEET_EXEC_OUTPUT_MAX - sink.length;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const keep = data.subarray(0, room);
    sink.chunks.push(keep);
    sink.length += keep.length;
    if (keep.length < data.length) truncated = true;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    handle.kill();
  }, timeoutMs);
  // A kill race: the child exits between the timeout and the signal — keep
  // its exit code and output, timedOut stays true.
  return handle.done.then(
    ({ exitCode, spawnError }): FleetExecOutcome => {
      clearTimeout(timer);
      // Byte caps land before decode; a split multibyte tail decodes to one
      // replacement character — acceptable, never a crash. A spawn error keeps
      // timedOut as observed but reports no exit code.
      return {
        status: "accepted",
        exitCode,
        stdout: Buffer.concat(sinks.stdout.chunks).toString("utf8"),
        stderr: spawnError === null ? Buffer.concat(sinks.stderr.chunks).toString("utf8") : spawnError,
        truncated,
        timedOut,
      };
    },
    (err: unknown): FleetExecOutcome => {
      clearTimeout(timer);
      return { status: "refused", reason: `could not start the shell: ${messageOf(err)}` };
    },
  );
}

export interface FleetServerDeps {
  registry: Registry;
  logDir: string;
  broadcast: () => void;
  /** The backend's shared registration path (project:add's body, issue #904); rejects with a user-facing reason. */
  addProject: (dir: string) => Promise<void>;
  /** ProviderKeys.setKey on this machine; throws a user-facing reason. */
  installProviderKey: (envName: string, value: string) => void;
  /** Fleet remote version update (issue #901 fleet family): this machine's omp install.
   *  null when no binary resolves (fresh machine); the managed path is where a
   *  fleet-staged omp installs regardless. */
  ompInstallPath: () => string | null;
  /** Fires only after a fleet-staged omp install succeeded, so the backend
   *  re-resolves the binary and restarts nothing that pinned the old one. */
  onOmpApplied: (version: string) => void;
  /** AppUpdater's live state — `app / check` reads it, never a new network call. */
  appUpdateState: () => AppUpdateState;
  /** AppUpdater staging (download-and-verify only; NEVER an install). */
  stageAppUpdate: () => Promise<"staged" | "up-to-date" | "unavailable" | "failed">;
  /** AppUpdater.setInstallOnQuit(true) equivalent; false when the updater declined. */
  armAppUpdateOnQuit: () => boolean;
  /** Sessions running on this machine right now (apply safety). */
  liveSessions: () => number;
  /** Core's pin rule: OMP_UI_OMP_PATH names an existing file. */
  pinned: () => boolean;
  /** SessionManager.fleetSend on this machine (issue #959): stage, then deliver or resume. */
  deliverSend: (req: FleetSendRequest) => Promise<FleetSendOutcome>;
  /** SessionManager.fleetFinish on this machine (issue #978): settle, then release an already-landed worktree. */
  deliverFinish: (req: FleetFinishRequest) => Promise<FleetFinishOutcome>;
  /** Test seams. */
  commandDeps?: FleetCommandDeps;
  execGit?: (file: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<{ stdout: Buffer }>;
}

export class FleetServer {
  readonly #deps: FleetServerDeps;
  readonly #ring: FleetAuditEntry[] = [];
  readonly #detached: FleetDetachedExecs;
  readonly #maintenance: FleetMaintenance;
  /** jobId → the omp version an accepted stage was about to install; consumed
   *  by the registry's onFinish so onOmpApplied never fires for revoked work. */
  readonly #ompJobVersions = new Map<string, string>();

  constructor(deps: FleetServerDeps) {
    this.#deps = deps;
    this.#detached = new FleetDetachedExecs({
      commandDeps: deps.commandDeps,
      onFinish: (rec) =>
        this.#audit("exec-detached", rec.requester, rec.rung, true, `${rec.execId.slice(0, 8)} ${rec.state}`, rec.exitCode),
    });
    this.#maintenance = new FleetMaintenance({
      broadcast: deps.broadcast,
      onFinish: (rec) => {
        this.#audit("update", rec.requester, rec.rung, true, `${rec.kind} ${rec.state}${rec.detail === null ? "" : `: ${rec.detail}`}`, null);
        // A succeeded omp install changed the binary on disk; the backend
        // re-resolves it. Only on success — revoked/failed jobs installed
        // nothing, and dispose() never earns a callback.
        const version = this.#ompJobVersions.get(rec.jobId);
        this.#ompJobVersions.delete(rec.jobId);
        if (rec.kind === "omp" && rec.state === "succeeded" && version !== undefined) this.#deps.onOmpApplied(version);
      },
    });
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

  /** `fleet:execDetach`: same ladder as exec; the member keeps the process running past the call. */
  execDetach(req: FleetDetachedExecRequest): FleetDetachedExecStartOutcome {
    const gate = this.check(req.requester, "full");
    if (!gate.ok) {
      this.#audit("exec-detached", req.requester, "full", false, req.command, null);
      return { status: "refused", reason: gate.reason };
    }
    const outcome = this.#detached.start(req.requester, gate.rung, { command: req.command, cwd: req.cwd, timeoutMs: req.timeoutMs });
    if (outcome.status === "accepted") {
      this.#audit("exec-detached", req.requester, gate.rung, true, `${outcome.execId.slice(0, 8)} ${req.command}`, null);
    } else {
      this.#audit("exec-detached", req.requester, gate.rung, false, req.command, null);
    }
    return outcome;
  }

  /** `fleet:execPoll`: no ladder check — only the dispatcher that started the exec can see it. Never audited. */
  execPoll(req: FleetExecPollRequest): Promise<FleetExecPollOutcome> {
    this.#recordFirstSight(req.requester);
    return this.#detached.poll(req.requester, req.execId, req.waitMs, req.cancel);
  }

  /**
   * `fleet:send` (issue #959): a foreign instance needs the Dispatch rung; the
   * own instance skips the ladder. SessionManager re-checks the dispatcher.
   * The message text never enters the audit log.
   */
  async send(req: FleetSendRequest): Promise<FleetSendOutcome> {
    const own = req.requester.instanceId === this.#deps.registry.getSetting("instanceId");
    let rung: FleetRung = "dispatch";
    if (!own) {
      const gate = this.check(req.requester, "dispatch");
      if (!gate.ok) {
        this.#audit("send", req.requester, "dispatch", false, req.dispatchId.slice(0, 8), null);
        return { status: "refused", reason: gate.reason };
      }
      rung = gate.rung;
    }
    const outcome = await this.#deps.deliverSend(req);
    this.#audit("send", req.requester, rung, outcome.status !== "refused", `${req.dispatchId.slice(0, 8)} ${outcome.status}`, null);
    return outcome;
  }

  /**
   * `fleet:finish` (issue #978): the same gate as send — a foreign instance
   * needs the Dispatch rung, the own instance skips the ladder, and
   * SessionManager re-checks the dispatcher before touching anything.
   */
  async finish(req: FleetFinishRequest): Promise<FleetFinishOutcome> {
    const own = req.requester.instanceId === this.#deps.registry.getSetting("instanceId");
    let rung: FleetRung = "dispatch";
    if (!own) {
      const gate = this.check(req.requester, "dispatch");
      if (!gate.ok) {
        this.#audit("finish", req.requester, "dispatch", false, req.dispatchId.slice(0, 8), null);
        return { status: "refused", reason: gate.reason };
      }
      rung = gate.rung;
    }
    const outcome = await this.#deps.deliverFinish(req);
    this.#audit("finish", req.requester, rung, outcome.status === "finished", `${req.dispatchId.slice(0, 8)} ${outcome.status}`, null);
    return outcome;
  }

  /**
   * `fleet:providerKeys` (Provider key rollout): rung 4 + master switch, then
   * each key into this machine's own credential store. The audit names env
   * names only; a key value never reaches a log, the ring, or a reason.
   */
  providerKeys(req: FleetProviderKeysRequest): FleetProviderKeysOutcome {
    const names = req.keys.map((k) => k.envName).join(", ");
    const gate = this.check(req.requester, "full");
    if (!gate.ok) {
      this.#audit("keys", req.requester, "full", false, names, null);
      return { status: "refused", reason: gate.reason };
    }
    const installed: string[] = [];
    const failed: Array<{ envName: string; reason: string }> = [];
    for (const { envName, value } of req.keys) {
      try {
        this.#deps.installProviderKey(envName, value);
        installed.push(envName);
      } catch (err) {
        failed.push({ envName, reason: messageOf(err) });
      }
    }
    this.#audit(
      "keys",
      req.requester,
      gate.rung,
      failed.length === 0,
      `installed ${installed.join(", ") || "none"}${failed.length > 0 ? `; failed ${failed.map((f) => f.envName).join(", ")}` : ""}`,
      null,
    );
    return { status: "accepted", installed, failed };
  }

  /**
   * `fleet:updateMember` (Fleet remote version update): rung 4 + master switch,
   * then the member acts on ITS OWN versions. `omp / check` reads this machine's
   * install plus the npm registry; `omp / stage` downloads into the managed path
   * as a maintenance job (the binary installs as it downloads — there is no
   * separate apply). `app / check` reads the updater state without any new
   * network call; `app / stage` downloads-and-verifies through the app's own
   * updater; `app / apply` only arms the install-on-quit hook. Nothing here can
   * restart the app or call quitAndInstall: apply is always deferred to the
   * owner quitting this machine by hand.
   */
  async updateMember(req: FleetUpdateMemberRequest): Promise<FleetUpdateAck> {
    const gate = this.check(req.requester, "full");
    if (!gate.ok) {
      this.#audit("update", req.requester, "full", false, `${req.target} ${req.action}`, null);
      return { status: "refused", reason: gate.reason };
    }
    if (req.target === "omp") {
      if (req.action === "apply") {
        // The parser refuses this combination; the member stays defensive.
        const reason = "the omp binary installs as it downloads; there is no separate apply for it";
        this.#audit("update", req.requester, gate.rung, false, `omp ${req.action}`, null);
        return { status: "refused", reason };
      }
      if (req.action === "check") {
        const info = await coreCheckOmpUpdate({ installPath: this.#deps.ompInstallPath() });
        this.#audit(
          "update",
          req.requester,
          gate.rung,
          true,
          `omp check ${info.installedVersion ?? "none"}→${info.latestVersion ?? "none"}`,
          null,
        );
        return {
          status: "accepted",
          check: {
            target: "omp",
            installedVersion: info.installedVersion,
            installPath: info.installPath,
            latestVersion: info.latestVersion,
            updateAvailable: info.updateAvailable,
            belowMinimum: info.belowMinimum,
            pinned: this.#deps.pinned(),
          },
        };
      }
      if (this.#deps.pinned()) {
        // A dev pin outranks the managed copy, so installing there would be
        // silently ignored. The reason names the variable, never a path.
        this.#audit("update", req.requester, gate.rung, false, `omp ${req.action}`, null);
        return {
          status: "refused",
          reason: "omp is pinned by OMP_UI_OMP_PATH on this machine; install into the managed path or clear the pin",
        };
      }
      const version = req.version ?? (await fetchLatestOmpVersion());
      if (version === null) {
        this.#audit("update", req.requester, gate.rung, false, `omp ${req.action}`, null);
        return { status: "refused", reason: "no omp release is available for this machine" };
      }
      const installPath = this.#deps.ompInstallPath();
      const outcome = this.#maintenance.start(req.requester, gate.rung, "omp", async (ctx) => {
        const targetPath = managedOmpPath();
        const from = await readInstalledOmpVersion(installPath ?? targetPath);
        await downloadOmp({
          version,
          targetPath,
          shouldCommit: ctx.shouldCommit,
          onProgress: (percent) => ctx.report({ percent, phase: "downloading" }),
        });
        return { detail: `omp ${from ?? "none"} → ${version} at ${targetPath}` };
      });
      if (outcome.status === "refused") {
        this.#audit("update", req.requester, gate.rung, false, `omp ${req.action}`, null);
        return outcome;
      }
      this.#ompJobVersions.set(outcome.jobId, version);
      this.#audit("update", req.requester, gate.rung, true, `omp → ${version} (job ${outcome.jobId.slice(0, 8)})`, null);
      return { status: "accepted", jobId: outcome.jobId };
    }
    const st = this.#deps.appUpdateState();
    if (req.action === "check") {
      // No new network call, no audit line: the updater's own state is the answer.
      return {
        status: "accepted",
        check: {
          target: "app",
          currentVersion: st.currentVersion,
          latestVersion: st.latestVersion,
          format: st.format,
          staged: st.status === "downloaded",
          installOnQuit: st.installOnQuit,
          liveSessions: this.#deps.liveSessions(),
        },
      };
    }
    if (req.action === "stage") {
      const disabled = "omp-ui auto-update is off in this install (Settings → Updates)";
      if (st.status === "disabled") {
        this.#audit("update", req.requester, gate.rung, false, `app ${req.action}`, null);
        return { status: "refused", reason: disabled };
      }
      if (!isAutoUpdateFormat(st.format)) {
        this.#audit("update", req.requester, gate.rung, false, `app ${req.action}`, null);
        return {
          status: "refused",
          reason:
            st.format === "deb" || st.format === "rpm" || st.format === "flatpak"
              ? `this machine installs omp-ui as a ${st.format} package; update it with its package manager`
              : "omp-ui does not know how this machine's omp-ui was installed; update it manually",
        };
      }
      const outcome = this.#maintenance.start(req.requester, gate.rung, "app", async (ctx) => {
        ctx.report({ percent: null, phase: "staging" });
        const stagedAt = st.latestVersion ?? this.#deps.appUpdateState().latestVersion;
        const result = await this.#deps.stageAppUpdate();
        if (result === "staged") return { detail: `app staged ${stagedAt ?? ""}`.trim() };
        // A stale check costs one round trip and keeps `app / check` cheap: an
        // up-to-date train FAILS the job so the dispatcher reads the reason.
        if (result === "up-to-date") throw new Error("no omp-ui release is available for this machine's train");
        if (result === "unavailable") throw new Error(disabled);
        throw new Error("the omp-ui update could not be staged on this machine");
      });
      if (outcome.status === "refused") {
        this.#audit("update", req.requester, gate.rung, false, `app ${req.action}`, null);
        return outcome;
      }
      this.#audit(
        "update",
        req.requester,
        gate.rung,
        true,
        `app → ${st.latestVersion ?? "unknown"} (job ${outcome.jobId.slice(0, 8)})`,
        null,
      );
      return { status: "accepted", jobId: outcome.jobId };
    }
    // app / apply: arm only. Re-check the ladder; this machine restarts when
    // its owner quits it — never here.
    const applyGate = this.check(req.requester, "full");
    if (!applyGate.ok) {
      this.#audit("update", req.requester, "full", false, `app ${req.action}`, null);
      return { status: "refused", reason: applyGate.reason };
    }
    const live = this.#deps.liveSessions();
    if (live > 0 && !req.allowLiveSessions) {
      this.#audit("update", req.requester, applyGate.rung, false, `app ${req.action}`, null);
      return { status: "refused", reason: `${live} live session(s) run on this machine; stop them or choose Install when I quit` };
    }
    if (this.#deps.appUpdateState().status !== "downloaded") {
      this.#audit("update", req.requester, applyGate.rung, false, `app ${req.action}`, null);
      return { status: "refused", reason: "no omp-ui update is staged on this machine" };
    }
    if (!this.#deps.armAppUpdateOnQuit()) {
      this.#audit("update", req.requester, applyGate.rung, false, `app ${req.action}`, null);
      return { status: "refused", reason: "this machine's updater declined to arm the install" };
    }
    this.#audit("update", req.requester, gate.rung, true, "app apply arm-on-quit", null);
    return { status: "accepted", detail: "arm-on-quit" };
  }

  /** `fleet:updatePoll`: no ladder check — only the dispatcher that started the job can see it. Never audited. */
  updatePoll(req: FleetUpdatePollRequest): Promise<FleetUpdatePollOutcome> {
    this.#recordFirstSight(req.requester);
    return this.#maintenance.poll(req.requester, req.jobId, req.waitMs);
  }

  /** Revoke every running detached exec or maintenance job whose starter no longer holds Full control here. */
  enforceDetached(): void {
    const registry = this.#deps.registry;
    const stillAllowed = (id: string) =>
      registry.getSetting("fleetExecEnabled") &&
      fleetRungAtLeast(fleetEffectiveRung(registry.getSetting("fleetGrants")[id], registry.getSetting("fleetExecCeiling")), "full");
    this.#detached.revokeWhere(stillAllowed);
    this.#maintenance.revokeWhere(stillAllowed);
  }

  /** Quit path: kill every running detached exec, revoke every maintenance job (never install on the way out). */
  dispose(): void {
    this.#detached.dispose();
    this.#maintenance.dispose();
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
    // A "raise" may name a lower rung: a dispatcher it drops below Full loses its running detached execs.
    this.enforceDetached();
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
    this.enforceDetached();
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
