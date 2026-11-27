import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  EXECUTABLE_CONFIG_PATHS,
  LOCAL_CLONE_INACTIVITY_MS,
  LOCAL_CLONE_TIMEOUT_MS,
  isWithin,
  parseCloneSource,
  withoutProviderKeys,
  type FleetProjectManageOutcome,
  type FleetToolProjectArgs,
  type OwnedSessionRecord,
  type ProjectRecord,
  type ProjectRequestPrompt,
} from "@omp-ui/core";
import type { HostCallControl } from "./host-bridge";
import type { ProjectRequestOutcome } from "./project-request-gate";

export type LocalGitRunner = (
  args: string[],
  opts: {
    cwd: string;
    timeout: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    /** Streamed stderr chunks; only the streaming runner emits them. */
    onStderr?: (chunk: string) => void;
    /** Kill the child after this much silence on stderr; default: timeout. */
    inactivityMs?: number;
  },
) => Promise<string>;

export interface LocalProjectRequestDeps {
  /** SessionManager.projectRequestEligibility: null when the tab may ask. */
  eligibility(tabId: string): string | null;
  record(tabId: string): OwnedSessionRecord | undefined;
  projects(): readonly ProjectRecord[];
  /** omp-ui's and omp's own data roots: userData, agent dir, sessions, archive, chats, worktrees. */
  protectedRoots(): string[];
  homedir(): string;
  /** ProjectRequestGate.request */
  ask(tabId: string, prompt: ProjectRequestPrompt, signal: AbortSignal): Promise<ProjectRequestOutcome>;
  /** Backend.addProjectPath */
  addProject(dir: string): Promise<unknown>;
  /** Backend.reportCloneProgress: the live git progress line, or null to clear. */
  reportCloneProgress?(tabId: string, line: string | null): void;
  git?: LocalGitRunner;
  now?: () => Date;
}

/**
 * git as a spawned child: stdout accumulates as text, stderr streams through
 * `opts.onStderr` (resetting the inactivity timer), and the child is killed on
 * abort, on `opts.timeout` of wall clock, or on `opts.inactivityMs` of stderr
 * silence. Rejects with git's stderr, trimmed, in the message.
 */
export const execLocalGit: LocalGitRunner = (args, opts) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn("git", args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const kill = (why: string) => {
    if (settled) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!settled && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }, 5_000).unref();
    reject(new Error(why));
  };
  const wallTimer = setTimeout(() => {
    const minutes = Math.max(1, Math.round(opts.timeout / 60_000));
    kill(`git did not finish within ${minutes}m — killed`);
  }, opts.timeout);
  wallTimer.unref();
  let inactivityTimer: NodeJS.Timeout | undefined = undefined;
  const disarmInactivity = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  };
  const armInactivity = () => {
    const window = opts.inactivityMs ?? opts.timeout;
    disarmInactivity();
    inactivityTimer = setTimeout(() => {
      kill(`git produced no stderr output for ${Math.round(window / 1000)}s — killed (stalled transport, not a slow clone)`);
    }, window);
    inactivityTimer.unref();
  };
  armInactivity();
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    if (stderr.length > 256 * 1024) stderr = `…${stderr.slice(-256 * 1024)}`;
    opts.onStderr?.(text);
    armInactivity();
  });
  const onAbort = () => kill("git was cancelled");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  child.on("error", (err) => {
    settled = true;
    disarmInactivity();
    clearTimeout(wallTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    reject(new Error(stderr.trim() !== "" ? stderr.trim() : err.message));
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    disarmInactivity();
    clearTimeout(wallTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    if (code === 0) resolve(stdout);
    else reject(new Error(stderr.trim() !== "" ? stderr.trim() : `git exited with code ${code ?? "null"}`));
  });
  return promise;
};

/**
 * The one progress line a git stderr chunk leaves on screen: ANSI stripped,
 * the last non-empty `\r`/`\n` segment. Null when the chunk carries no text.
 */
export function lastProgressLine(chunk: string): string | null {
  const segments = chunk
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split(/[\r\n]+/)
    .filter((segment) => segment.trim() !== "");
  const last = segments.at(-1);
  return last === undefined ? null : last.trim();
}

/**
 * Full clone stderr, tail-capped, with the resume hint when the partial
 * checkout was kept.
 */
function cloneFailureReason(message: string, kept: boolean, dest: string): string {
  const capped = message.length > 2000 ? `…${message.slice(-2000)}` : message;
  return kept
    ? `git clone failed: ${capped} — the partial checkout was kept at ${dest}; retrying the same clone will resume it`
    : `git clone failed: ${capped}`;
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

const refused = (reason: string): FleetProjectManageOutcome => ({ status: "refused", reason });

/**
 * Agents add projects on this computer through a confirmation card (#1228,
 * ADR-0099). Only an Allow on the card registers or clones; every other
 * ending (deny, cancel, exit, stale answer) has no side effect. Every check
 * that guards the add runs again after the answer, because state may change
 * while the card is open.
 */
export class LocalProjectRequests {
  readonly #git: LocalGitRunner;
  readonly #now: () => Date;

  constructor(private readonly deps: LocalProjectRequestDeps) {
    this.#git = deps.git ?? execLocalGit;
    this.#now = deps.now ?? (() => new Date());
  }

  async request(tabId: string, args: FleetToolProjectArgs, control: HostCallControl): Promise<FleetProjectManageOutcome> {
    const ineligible = this.deps.eligibility(tabId);
    if (ineligible !== null) return refused(ineligible);
    const record = this.deps.record(tabId);
    if (record === undefined) return refused("this session is not a live native session");
    return args.verb === "register" ? this.#register(tabId, args.path, control) : this.#clone(tabId, record, args.repositoryUrl, control);
  }

  async #register(tabId: string, rawPath: string | null, control: HostCallControl): Promise<FleetProjectManageOutcome> {
    const checked = this.#checkRegister(rawPath);
    if (checked.kind === "refused") return refused(checked.reason);
    if (checked.kind === "registered") return this.#accepted(checked.path);
    const real = checked.real;
    const origin = await this.#gitLine(["remote", "get-url", "origin"], real);
    const prompt: ProjectRequestPrompt = {
      promptId: randomUUID(),
      verb: "register",
      source: real,
      name: null,
      defaultParent: null,
      origin,
      executableConfig: EXECUTABLE_CONFIG_PATHS.filter((rel) => fs.existsSync(path.join(real, rel))),
      requestedAt: this.#now().toISOString(),
    };
    const answer = await this.#hold(tabId, prompt, control);
    if ("status" in answer) return answer;
    control.rearmWatchdog(60_000);
    const again = this.#checkRegister(real);
    if (again.kind === "refused") return refused(again.reason);
    if (again.kind === "registered") return this.#accepted(again.path);
    try {
      await this.deps.addProject(again.real);
    } catch (err) {
      return refused(`registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.#accepted(again.real);
  }

  async #clone(
    tabId: string,
    record: OwnedSessionRecord,
    rawUrl: string | null,
    control: HostCallControl,
  ): Promise<FleetProjectManageOutcome> {
    const source = parseCloneSource(rawUrl ?? "");
    if (!source.ok) return refused(source.reason);
    const prompt: ProjectRequestPrompt = {
      promptId: randomUUID(),
      verb: "clone",
      source: source.url,
      name: source.name,
      defaultParent: record.chat ? this.deps.homedir() : path.dirname(record.projectCwd),
      origin: null,
      executableConfig: [],
      requestedAt: this.#now().toISOString(),
    };
    const answer = await this.#hold(tabId, prompt, control);
    if ("status" in answer) return answer;
    // The card's root refusals apply to the destination, not the parent: a chat's default parent is the home folder.
    const parentChoice = answer.parent ?? prompt.defaultParent ?? this.deps.homedir();
    control.rearmWatchdog(LOCAL_CLONE_TIMEOUT_MS + 15_000);
    const parentReal = realpathOrNull(parentChoice);
    if (parentReal === null || !fs.statSync(parentReal).isDirectory()) {
      return refused(`${parentChoice} is not an existing folder on this computer`);
    }
    const dest = path.join(parentReal, source.name);
    const blocked = this.#blockedLocation(dest);
    if (blocked !== null) return refused(blocked);
    const cloneEnv: NodeJS.ProcessEnv = {
      // Provider keys never ride a git child (finding 9): a repo's
      // credential helper or hook runs with this env.
      ...withoutProviderKeys(process.env),
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    };
    const onStderr = (chunk: string) => {
      const line = lastProgressLine(chunk);
      if (line !== null) this.deps.reportCloneProgress?.(tabId, line);
    };
    const resumeReady =
      fs.existsSync(dest) && fs.existsSync(path.join(dest, ".git"))
        ? (await this.#gitLine(["-C", dest, "remote", "get-url", "origin"], parentReal)) === source.url
        : false;
    if (fs.existsSync(dest) && !resumeReady) return refused(`${dest} already exists`);
    try {
      if (resumeReady) {
        await this.#resumeClone(dest, onStderr, cloneEnv, control);
      } else {
        await this.#git(
          ["clone", "--filter=blob:none", "--progress", "--", source.url, dest],
          {
            cwd: parentReal,
            timeout: LOCAL_CLONE_TIMEOUT_MS,
            inactivityMs: LOCAL_CLONE_INACTIVITY_MS,
            onStderr,
            signal: control.signal,
            env: cloneEnv,
          },
        );
      }
    } catch (err) {
      // The clone's own directory is the only thing there: keep it when git
      // wrote `.git` (the resumable state), remove it otherwise.
      const kept = fs.existsSync(path.join(dest, ".git"));
      if (!kept) await fs.promises.rm(dest, { recursive: true, force: true });
      return refused(cloneFailureReason(err instanceof Error ? err.message : String(err), kept, dest));
    } finally {
      this.deps.reportCloneProgress?.(tabId, null);
    }
    try {
      await this.deps.addProject(dest);
    } catch (err) {
      return refused(`cloned to ${dest} but registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.#accepted(dest);
  }

  /**
   * Completes a kept partial clone in `dest` whose origin already matches
   * `url`: fetch (the partial-clone config reapplies the filter and git
   * reuses the already-downloaded pack), re-resolve the remote head, then
   * force-checkout the working tree.
   */
  async #resumeClone(
    dest: string,
    onStderr: (chunk: string) => void,
    env: NodeJS.ProcessEnv,
    control: HostCallControl,
  ): Promise<void> {
    await this.#git(
      ["-C", dest, "fetch", "--progress", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      {
        cwd: dest,
        timeout: LOCAL_CLONE_TIMEOUT_MS,
        inactivityMs: LOCAL_CLONE_INACTIVITY_MS,
        onStderr,
        signal: control.signal,
        env,
      },
    );
    await this.#git(["-C", dest, "remote", "set-head", "origin", "--auto"], { cwd: dest, timeout: 5_000, env });
    const head = await this.#gitLine(["-C", dest, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dest);
    const branch = head?.replace(/^origin\//, "") ?? "main";
    await this.#git(["-C", dest, "checkout", "-f", "-B", branch, `origin/${branch}`], { cwd: dest, timeout: 5_000, env });
  }

  /** Suspends the watchdog and waits on the card: the refusal, or Allow with the picked clone parent. */
  async #hold(
    tabId: string,
    prompt: ProjectRequestPrompt,
    control: HostCallControl,
  ): Promise<FleetProjectManageOutcome | { parent: string | null }> {
    control.suspendWatchdog();
    const outcome = await this.deps.ask(tabId, prompt, control.signal);
    if (outcome === "cancelled") return refused("the request was cancelled");
    if (outcome.kind === "refused") return refused(outcome.reason);
    if (outcome.kind === "deny") return refused("the user declined");
    return { parent: outcome.parent };
  }

  async #accepted(dir: string): Promise<FleetProjectManageOutcome> {
    return { status: "accepted", path: dir, headCommit: await this.#gitLine(["rev-parse", "HEAD"], dir) };
  }

  /** One trimmed line of git output, or null on failure or empty output. */
  async #gitLine(args: string[], cwd: string): Promise<string | null> {
    try {
      return (await this.#git(args, { cwd, timeout: 5_000 })).trim() || null;
    } catch {
      return null;
    }
  }

  #checkRegister(
    rawPath: string | null,
  ): { kind: "refused"; reason: string } | { kind: "registered"; path: string } | { kind: "new"; real: string } {
    if (rawPath === null || rawPath === "") return { kind: "refused", reason: "register needs a path" };
    if (!path.isAbsolute(rawPath)) return { kind: "refused", reason: "register needs an absolute path" };
    const real = realpathOrNull(rawPath);
    if (real === null) return { kind: "refused", reason: `${rawPath} does not exist on this computer` };
    for (const project of this.deps.projects()) {
      if (realpathOrNull(project.path) === real) return { kind: "registered", path: project.path };
    }
    const blocked = this.#blockedLocation(real);
    if (blocked !== null) return { kind: "refused", reason: blocked };
    if (!fs.existsSync(path.join(real, ".git"))) return { kind: "refused", reason: `${real} is not a git checkout (no .git)` };
    return { kind: "new", real };
  }

  /**
   * Why `target` may never become a project: the filesystem root, the home
   * folder or an ancestor of it, anything equal to, inside, or above omp-ui's
   * or omp's own data roots, or a folder inside a registered project.
   */
  #blockedLocation(target: string): string | null {
    if (target === path.parse(target).root) return `${target} is the filesystem root`;
    const home = realpathOrNull(this.deps.homedir()) ?? this.deps.homedir();
    if (target === home || isWithin(target, home)) return `${target} is your home folder or contains it`;
    for (const root of this.deps.protectedRoots()) {
      const realRoot = realpathOrNull(root);
      if (realRoot === null) continue;
      if (target === realRoot || isWithin(realRoot, target) || isWithin(target, realRoot)) {
        return `${target} overlaps omp-ui's or omp's own data folder ${realRoot}`;
      }
    }
    for (const project of this.deps.projects()) {
      const realProject = realpathOrNull(project.path);
      if (realProject !== null && isWithin(realProject, target)) return `${target} is inside the registered project ${project.path}`;
    }
    return null;
  }
}
