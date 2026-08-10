import * as path from "node:path";
import { git, type GitOptions } from "./git";
import type { BranchList, BranchListOptions } from "./types";

const FETCH_TIMEOUT_MS = 5_000;
const PULL_TIMEOUT_MS = 30_000;
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

function isNamedRemote(remote: string | null): remote is string {
  return remote !== null && remote !== "" && remote !== ".";
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

  const readDefaultBranch = async (root: string, branches: string[]): Promise<string | null> => {
    try {
      const head = (
        await runGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
      ).trim();
      return head.startsWith("origin/") ? head.slice("origin/".length) : head;
    } catch {
      if (branches.includes("main")) return "main";
      if (branches.includes("master")) return "master";
      return null;
    }
  };

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

  const verifyUpstream = async (root: string): Promise<boolean> => {
    try {
      await runGit(root, ["rev-parse", "--verify", "--quiet", "@{upstream}"]);
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
    const defaultBranch = await readDefaultBranch(root, branches);
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

  return { listBranches: listBranchesImpl, pullBranch: pullBranchImpl };
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
