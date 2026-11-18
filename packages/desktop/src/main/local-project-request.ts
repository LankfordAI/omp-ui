import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  EXECUTABLE_CONFIG_PATHS,
  LOCAL_CLONE_TIMEOUT_MS,
  isWithin,
  parseCloneSource,
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
  opts: { cwd: string; timeout: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
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
  git?: LocalGitRunner;
  now?: () => Date;
}

/** execFile git, stdout as text; rejects with git's stderr in the message. */
export const execLocalGit: LocalGitRunner = (args, opts) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("git", args, { ...opts, maxBuffer: 1_048_576, encoding: "utf8" }, (err, stdout, stderr) => {
    if (err === null) resolve(stdout);
    else reject(new Error(stderr.trim() !== "" ? stderr.trim() : err.message));
  });
  return promise;
};

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
    if (fs.existsSync(dest)) return refused(`${dest} already exists`);
    try {
      await this.#git(["clone", "--", source.url, dest], {
        cwd: parentReal,
        timeout: LOCAL_CLONE_TIMEOUT_MS,
        signal: control.signal,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
        },
      });
    } catch (err) {
      // dest did not exist before the clone, so everything there is the clone's.
      await fs.promises.rm(dest, { recursive: true, force: true });
      const message = err instanceof Error ? err.message : String(err);
      return refused(`git clone failed: ${message.split("\n")[0]}`);
    }
    try {
      await this.deps.addProject(dest);
    } catch (err) {
      return refused(`cloned to ${dest} but registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.#accepted(dest);
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
