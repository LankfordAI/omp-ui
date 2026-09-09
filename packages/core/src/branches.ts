import * as path from "node:path";
import { git, type GitOptions } from "./git";
import type { BranchList, BranchListOptions, PushResult } from "./types";

const FETCH_TIMEOUT_MS = 5_000;
const PULL_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;
const FETCH_FRESH_MS = 15_000;
const FAILURE_COOLDOWN_MS = 30_000;
const MAX_FAILURE_COOLDOWN_MS = 15 * 60_000;
const MAX_IDLE_CACHE_ENTRIES = 2_048;

export type GitRunner = (
  cwd: string,
  args: string[],
  options?: GitOptions,
) => Promise<string>;

export type BranchClock = () => number;

export interface ParsedBranchStatus {
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface BranchService {
  listBranches(projectCwd: string, options?: BranchListOptions): Promise<BranchList>;
  pullBranch(projectCwd: string): Promise<void>;
  pushBranch(projectCwd: string, branch: string, remote?: string | null): Promise<PushResult>;
}

interface ConfiguredUpstream {
  ref: string;
  remote: string | null;
}

interface CachedCounts {
  identity: string;
  ahead: number;
  behind: number;
}

interface FetchCacheEntry {
  fetchedAt: number | null;
  refreshError: string | null;
  failures: number;
  retryAt: number;
  inFlight: Promise<boolean> | null;
  counts: CachedCounts | null;
  lastUsed: number;
  generation: number;
}

type RefreshResult = "none" | "fresh" | "fetched" | "failed" | "cooldown";

function parseCount(token: string | undefined, prefix: "+" | "-"): number {
  if (token === undefined || token[0] !== prefix || !/^\d+$/.test(token.slice(1))) return 0;
  const count = Number(token.slice(1));
  return Number.isSafeInteger(count) ? count : 0;
}

/** Parses only the stable branch headers from `status --porcelain=v2 --branch`. */
export function parseBranchStatus(output: string): ParsedBranchStatus {
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      head = value.startsWith("(") && value.endsWith(")") ? null : value || null;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
    } else if (line.startsWith("# branch.ab ")) {
      const tokens = line.slice("# branch.ab ".length).trim().split(/\s+/);
      ahead = parseCount(tokens.find((token) => token.startsWith("+")), "+");
      behind = parseCount(tokens.find((token) => token.startsWith("-")), "-");
    }
  }

  return { head, upstream, ahead, behind };
}

function emptyBranchList(): BranchList {
  return {
    repoRoot: null,
    current: null,
    branches: [],
    defaultBranch: null,
    upstreamRef: null,
    upstreamRemote: null,
    hasUpstream: false,
    ahead: 0,
    behind: 0,
    upstreamFetchedAt: null,
    upstreamRefreshError: null,
    defaultRemote: null,
  };
}

function networkOptions(timeoutMs: number): GitOptions {
  return {
    timeoutMs,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A remote name that can address a real remote: not null, not empty, not the `.` local-upstream marker. */
export function isNamedRemote(remote: string | null): remote is string {
  return remote !== null && remote !== "" && remote !== ".";
}
/**
 * The remote a push targets when the branch carries no usable configured
 * upstream: `origin` when it exists, else the repo's single remote, else
 * null. Two local reads; no network (issue #414).
 */
export async function resolveDefaultRemote(
  root: string,
  runGit: GitRunner = git,
): Promise<string | null> {
  try {
    await runGit(root, ["remote", "get-url", "origin"]);
    return "origin";
  } catch {
    // No origin: the sole-remote rule below is the answer.
  }
  let names: string[];
  try {
    names = await listRemoteNames(root, runGit);
  } catch {
    return null;
  }
  return names.length === 1 ? names[0]! : null;
}

/** Every configured remote name, in git's order. */
export async function listRemoteNames(root: string, runGit: GitRunner = git): Promise<string[]> {
  const out = await runGit(root, ["remote"]);
  return out
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** One git config value; null when unset. Absence is an answer, not a failure. */
async function readConfigValue(
  root: string,
  key: string,
  runGit: GitRunner,
): Promise<string | null> {
  try {
    const value = (await runGit(root, ["config", "--get", key], { allowExit: [1] })).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Git's own words for "the remote has moved"; anything else is a transport/auth failure. */
const NON_FAST_FORWARD_RE = /(?:rejected|non-fast-forward|fetch first|stale info)/i;

/**
 * Git's refusal of a non-fast-forward is actionable — pull, then push again —
 * so it becomes `rejected`; auth, transport, and TLS failures become `failed`.
 * Both carry stderr verbatim (the runner rethrows it as the Error message).
 */
function classifyPushFailure(error: unknown, remote: string | null): PushResult {
  const detail = errorMessage(error);
  return NON_FAST_FORWARD_RE.test(detail)
    ? { kind: "rejected", remote, detail }
    : { kind: "failed", detail };
}

/** Creates an isolated, injectable branch service; production delegates live below. */
export function createBranchService(
  runGit: GitRunner = git,
  now: BranchClock = Date.now,
): BranchService {
  const fetchCache = new Map<string, FetchCacheEntry>();
  let useSequence = 0;

  const touch = (entry: FetchCacheEntry): void => {
    entry.lastUsed = ++useSequence;
  };

  const evictOldestIdleEntries = (): void => {
    const idle = [...fetchCache.entries()].filter(([, entry]) => entry.inFlight === null);
    if (idle.length <= MAX_IDLE_CACHE_ENTRIES) return;
    idle.sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (let index = 0; index < idle.length - MAX_IDLE_CACHE_ENTRIES; index += 1) {
      fetchCache.delete(idle[index]![0]);
    }
  };

  const cacheEntry = (key: string): FetchCacheEntry => {
    const existing = fetchCache.get(key);
    if (existing !== undefined) {
      touch(existing);
      return existing;
    }

    const entry: FetchCacheEntry = {
      fetchedAt: null,
      refreshError: null,
      failures: 0,
      retryAt: 0,
      inFlight: null,
      counts: null,
      lastUsed: 0,
      generation: 0,
    };
    touch(entry);
    fetchCache.set(key, entry);
    evictOldestIdleEntries();
    return entry;
  };

  const resolveRepoRoot = async (projectCwd: string): Promise<string> =>
    path.resolve((await runGit(projectCwd, ["rev-parse", "--show-toplevel"])).trim());

  const readStatus = async (root: string): Promise<ParsedBranchStatus> =>
    parseBranchStatus(await runGit(root, ["status", "--porcelain=v2", "--branch"]));

  const readLocalBranches = async (root: string): Promise<string[]> =>
    (await runGit(root, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]))
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name !== "");

  // The module-level readDefaultBranch (below) reads its own branch
  // listing; the extra local for-each-ref is cheap and keeps one signature
  // (issue #390).

  const readConfiguredUpstream = async (
    root: string,
    current: string,
  ): Promise<ConfiguredUpstream | null> => {
    const localRef = `refs/heads/${current}`;
    const output = await runGit(root, [
      "for-each-ref",
      "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)",
      localRef,
    ]);
    for (const row of output.split("\n")) {
      const [refname, upstreamRef, remote] = row.trimEnd().split("\0");
      if (refname !== localRef || !upstreamRef) continue;
      return { ref: upstreamRef, remote: remote || null };
    }
    return null;
  };

  const verifyUpstream = async (root: string, source = "@{upstream}"): Promise<boolean> => {
    try {
      await runGit(root, ["rev-parse", "--verify", "--quiet", source]);
      return true;
    } catch {
      return false;
    }
  };

  const fetchCacheKey = async (root: string, remote: string): Promise<string> => {
    const commonDir = (await runGit(root, ["rev-parse", "--git-common-dir"])).trim();
    return `${path.normalize(path.resolve(root, commonDir))}\0${remote}`;
  };

  const refreshRemote = async (
    root: string,
    remote: string,
    entry: FetchCacheEntry,
  ): Promise<RefreshResult> => {
    touch(entry);
    if (entry.inFlight !== null) return (await entry.inFlight) ? "fetched" : "failed";

    const startedAt = now();
    if (entry.fetchedAt !== null && startedAt - entry.fetchedAt < FETCH_FRESH_MS) return "fresh";
    if (startedAt < entry.retryAt) return "cooldown";

    const generation = entry.generation;
    const operation: Promise<boolean> = runGit(
      root,
      ["fetch", "--quiet", "--no-tags", remote],
      networkOptions(FETCH_TIMEOUT_MS),
    )
      .then(() => {
        if (entry.generation === generation) {
          entry.fetchedAt = now();
          entry.refreshError = null;
          entry.failures = 0;
          entry.retryAt = 0;
        }
        return true;
      })
      .catch((error: unknown) => {
        if (entry.generation === generation) {
          entry.refreshError = errorMessage(error);
          entry.failures += 1;
          const exponent = Math.min(entry.failures - 1, 5);
          const cooldown = Math.min(
            FAILURE_COOLDOWN_MS * 2 ** exponent,
            MAX_FAILURE_COOLDOWN_MS,
          );
          entry.retryAt = now() + cooldown;
        }
        return false;
      })
      .finally(() => {
        if (entry.inFlight === operation) entry.inFlight = null;
        touch(entry);
        evictOldestIdleEntries();
      });

    entry.inFlight = operation;
    evictOldestIdleEntries();
    return (await operation) ? "fetched" : "failed";
  };

  const listBranchesImpl = async (
    projectCwd: string,
    options?: BranchListOptions,
  ): Promise<BranchList> => {
    let root: string;
    try {
      root = await resolveRepoRoot(projectCwd);
    } catch {
      return emptyBranchList();
    }

    let status = await readStatus(root);
    const current = status.head;
    const branches = await readLocalBranches(root);
    const defaultBranch = await readDefaultBranch(root, runGit);
    const configured = current === null ? null : await readConfiguredUpstream(root, current);
    const remote = configured?.remote ?? null;
    let entry: FetchCacheEntry | null = null;

    if (configured !== null && isNamedRemote(remote)) {
      entry = cacheEntry(await fetchCacheKey(root, remote));
      if (options?.fetchUpstream === true) {
        const refreshResult = await refreshRemote(root, remote, entry);
        if (refreshResult === "fetched") status = await readStatus(root);
      }
    }

    const upstreamAvailable = configured !== null && (await verifyUpstream(root));
    const defaultRemote = await resolveDefaultRemote(root, runGit);
    const identity =
      configured === null || current === null ? null : `${root}\0${current}\0${configured.ref}`;
    let ahead = upstreamAvailable ? status.ahead : 0;
    let behind = upstreamAvailable ? status.behind : 0;

    if (entry !== null && identity !== null) {
      if (entry.refreshError !== null && entry.counts?.identity === identity) {
        ahead = entry.counts.ahead;
        behind = entry.counts.behind;
      } else {
        entry.counts = { identity, ahead, behind };
      }
      touch(entry);
    }

    const rest = branches
      .filter((name) => name !== defaultBranch)
      .sort((left, right) => left.localeCompare(right));
    return {
      repoRoot: root,
      current,
      branches: defaultBranch === null ? rest : [defaultBranch, ...rest],
      defaultBranch,
      upstreamRef: configured?.ref ?? null,
      upstreamRemote: remote,
      hasUpstream: upstreamAvailable,
      ahead,
      behind,
      upstreamFetchedAt: entry?.fetchedAt ?? null,
      upstreamRefreshError: entry?.refreshError ?? null,
      defaultRemote,
    };
  };

  const pullBranchImpl = async (projectCwd: string): Promise<void> => {
    let root: string;
    try {
      root = await resolveRepoRoot(projectCwd);
    } catch {
      throw new Error("Cannot pull: project is not inside a Git repository.");
    }

    let status = await readStatus(root);
    const current = status.head;
    if (current === null) throw new Error("Cannot pull: HEAD is detached.");

    const configured = await readConfiguredUpstream(root, current);
    if (configured === null) throw new Error("Cannot pull: current branch has no configured upstream.");

    let entry: FetchCacheEntry | null = null;
    if (isNamedRemote(configured.remote)) {
      entry = cacheEntry(await fetchCacheKey(root, configured.remote));
      if (entry.inFlight !== null) {
        await entry.inFlight;
        status = await readStatus(root);
      }
    }

    if (!(await verifyUpstream(root))) {
      throw new Error("Cannot pull: configured upstream is unavailable.");
    }
    if (status.ahead > 0 && status.behind > 0) {
      throw new Error("Cannot pull: branch has diverged; merge or rebase manually.");
    }

    await runGit(root, ["pull", "--ff-only"], networkOptions(PULL_TIMEOUT_MS));

    if (entry !== null) {
      entry.generation += 1;
      entry.fetchedAt = now();
      entry.refreshError = null;
      entry.failures = 0;
      entry.retryAt = 0;
      entry.counts = {
        identity: `${root}\0${current}\0${configured.ref}`,
        ahead: status.ahead,
        behind: 0,
      };
      touch(entry);
      evictOldestIdleEntries();
    }
  };

  /** Commits in `to` that `from` lacks; null when either side is unreadable. */
  const countBetween = async (root: string, from: string, to: string): Promise<number | null> => {
    try {
      const count = Number((await runGit(root, ["rev-list", "--count", `${from}..${to}`])).trim());
      return Number.isSafeInteger(count) ? count : null;
    } catch {
      return null;
    }
  };

  /**
   * A push advanced the remote-tracking ref, so the fetch cache's freshness
   * window restarts here and its counts follow a local status read: the next
   * listing shows the true zero-ahead state without reaching the network.
   * Same block pullBranch applies after its own success.
   */
  const invalidateAfterPush = async (
    root: string,
    remote: string,
    branch: string,
    upstreamRef: string,
  ): Promise<void> => {
    const entry = cacheEntry(await fetchCacheKey(root, remote));
    entry.generation += 1;
    entry.fetchedAt = now();
    entry.refreshError = null;
    entry.failures = 0;
    entry.retryAt = 0;
    // The status read only decorates the cache; a failure leaves the counts
    // untouched rather than costing the push its result.
    const status = await readStatus(root).catch(() => null);
    if (status !== null && status.head === branch) {
      entry.counts = { identity: `${root}\0${branch}\0${upstreamRef}`, ahead: 0, behind: status.behind };
    }
    touch(entry);
    evictOldestIdleEntries();
  };

  const pushBranchImpl = async (
    projectCwd: string,
    branch: string,
    remoteArgument?: string | null,
  ): Promise<PushResult> => {
    let root: string;
    try {
      root = await resolveRepoRoot(projectCwd);
    } catch {
      return { kind: "failed", detail: "Cannot push: project is not inside a Git repository." };
    }

    try {
      await runGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    } catch {
      return { kind: "failed", detail: `Cannot push: branch ${branch} does not exist.` };
    }

    const configuredRemote = await readConfigValue(root, `branch.${branch}.remote`, runGit);
    const configuredMerge = await readConfigValue(root, `branch.${branch}.merge`, runGit);
    const mergeRef =
      configuredMerge !== null && configuredMerge.startsWith("refs/heads/")
        ? configuredMerge.slice("refs/heads/".length)
        : configuredMerge;
    const remotes = await listRemoteNames(root, runGit).catch((): string[] => []);

    // Remote chain (issue #414): the branch's configured remote when it is a
    // real named remote, else the caller's, else origin/sole remote.
    const configuredUsable =
      configuredRemote !== null &&
      isNamedRemote(configuredRemote) &&
      remotes.includes(configuredRemote);
    let remote: string | null = configuredUsable ? configuredRemote : null;
    if (remote === null && isNamedRemote(remoteArgument ?? null)) remote = remoteArgument ?? null;
    if (remote === null) remote = await resolveDefaultRemote(root, runGit);
    if (remote === null) return { kind: "failed", detail: "Cannot push: no remote configured." };

    const upstreamRef =
      configuredUsable && mergeRef !== null && (await verifyUpstream(root, `${branch}@{upstream}`))
        ? `${remote}/${mergeRef}`
        : null;

    if (upstreamRef !== null && mergeRef !== null) {
      const ahead = await countBetween(root, upstreamRef, branch);
      // Nothing to send: git would answer "Everything up-to-date" for free,
      // so the network is not touched at all.
      if (ahead === 0) return { kind: "up-to-date", remote, upstreamRef };
      try {
        await runGit(
          root,
          ["push", remote, `${branch}:${mergeRef}`],
          networkOptions(PUSH_TIMEOUT_MS),
        );
      } catch (error) {
        return classifyPushFailure(error, remote);
      }
      await invalidateAfterPush(root, remote, branch, upstreamRef);
      return { kind: "pushed", remote, upstreamRef, commits: ahead ?? 0 };
    }

    // First push: create the branch on the remote and bind the upstream.
    const trackingRef = `${remote}/${branch}`;
    let commits = await countBetween(root, trackingRef, branch);
    if (commits === null) {
      // No local tracking ref for it yet: the whole branch is what ships.
      try {
        const total = Number((await runGit(root, ["rev-list", "--count", branch])).trim());
        commits = Number.isSafeInteger(total) ? total : 0;
      } catch {
        commits = 0;
      }
    }
    try {
      await runGit(root, ["push", "-u", remote, branch], networkOptions(PUSH_TIMEOUT_MS));
    } catch (error) {
      return classifyPushFailure(error, remote);
    }
    await invalidateAfterPush(root, remote, branch, trackingRef);
    return { kind: "published", remote, upstreamRef: trackingRef, commits };
  };

  return {
    listBranches: listBranchesImpl,
    pullBranch: pullBranchImpl,
    pushBranch: pushBranchImpl,
  };
}

const productionBranchService = createBranchService();

/** Returns local branches and optional upstream state for a project. */
export function listBranches(
  projectCwd: string,
  options?: BranchListOptions,
): Promise<BranchList> {
  return productionBranchService.listBranches(projectCwd, options);
}

/** Fast-forwards the current branch from its configured, resolvable upstream. */
export function pullBranch(projectCwd: string): Promise<void> {
  return productionBranchService.pullBranch(projectCwd);
}

/**
 * Pushes `branch` to its upstream, or publishes it to `remote` — or to the
 * repo's default remote when none is given (issue #414). Resolves a
 * structured PushResult: git refusing a non-fast-forward is an answer, not a
 * rejection. No force flag exists here; a `rejected` result means pull first.
 */
export function pushBranch(
  projectCwd: string,
  branch: string,
  remote?: string | null,
): Promise<PushResult> {
  return productionBranchService.pushBranch(projectCwd, branch, remote);
}

/**
 * Switches the repo to `name`, creating it (`checkout -b`) when opts.create.
 * Git remains the authority on branch names and dirty-tree safety.
 */
export async function checkoutBranch(
  projectCwd: string,
  name: string,
  opts?: { create?: boolean },
): Promise<void> {
  await git(projectCwd, opts?.create ? ["checkout", "-b", name] : ["checkout", name]);
}

/**
 * The branch `refs/remotes/origin/HEAD` names, validated: null when the
 * symref is absent, prints empty, or points at a ref git no longer has
 * (issue #399 — `symbolic-ref --short` exits 0 on a dangling target, so
 * the read alone is not an existence proof). The probe verifies the short
 * name as printed (`origin/trunk`), not the stripped tail: tail resolution
 * answers from a same-named local branch and would re-admit the pruned
 * remote-tracking ref the symref no longer reaches.
 */
async function resolveOriginHeadBranch(
  projectCwd: string,
  runGit: GitRunner,
): Promise<string | null> {
  let head: string;
  try {
    head = (
      await runGit(projectCwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    ).trim();
  } catch {
    return null;
  }
  if (head === "") return null;
  try {
    await runGit(projectCwd, ["rev-parse", "--verify", "--quiet", head]);
  } catch {
    return null;
  }
  return head.startsWith("origin/") ? head.slice("origin/".length) : head;
}

/**
 * The repo's default branch: `origin/HEAD` when it resolves to a ref that
 * exists, else a local `main`, else a local `master`, else null (issue
 * #390: the base recorded for an existing-branch worktree; issue #399:
 * a dangling symref does not count as resolving). Local reads only;
 * `runGit` is the test seam the branch service shares.
 */
export async function readDefaultBranch(
  projectCwd: string,
  runGit: GitRunner = git,
): Promise<string | null> {
  const originHead = await resolveOriginHeadBranch(projectCwd, runGit);
  if (originHead !== null) return originHead;
  let branches: string[];
  try {
    branches = (
      await runGit(projectCwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)"])
    )
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name !== "");
  } catch {
    branches = [];
  }
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return null;
}

/**
 * Creates `name` at `startPoint` without checking it out (issue #385: the
 * finish dialog's new-branch destination). No checkout, no validation —
 * git's stderr is the validation, same stance as checkoutBranch.
 */
export async function createBranch(
  projectCwd: string,
  name: string,
  startPoint: string,
): Promise<void> {
  await git(projectCwd, ["branch", name, startPoint]);
}
