import { execFile } from "node:child_process";
import { withoutAppImageRuntime } from "./appimage-env";
import { git } from "./git";
import { branchPushRepository } from "./pr-url";
import type { GitRunner } from "./branches";
import type { PullRequestChecks, PullRequestLink, PullRequestState } from "./types";

/**
 * Pull requests linked to sessions (issue #985). omp-ui still holds no token
 * (the #414 rule): the lookup shells out to the user's own `gh`, which owns
 * authentication, host selection (github.com or a GitHub Enterprise host the
 * user logged into) and base-repository resolution. One GraphQL call answers
 * every branch of one repository; a branch with no PR answers an empty list.
 */

/** Branches per GraphQL call; one alias each. */
export const PR_BRANCHES_PER_QUERY = 40;
/** Newest PRs kept per branch. */
const PRS_PER_BRANCH = 10;
const GH_TIMEOUT_MS = 20_000;

/**
 * Why a repository yielded no answer. `unauthenticated`: gh has no login for
 * the host (gh exits 4). `not-github`: no remote points at a host gh knows —
 * GitLab, a bare path, a host never logged into. `missing`: gh is not
 * installed. `failed`: anything else (a GitHub 5xx, a timeout, a bad answer),
 * which the next poll may not repeat.
 */
export type PullRequestLookupFailure = "unauthenticated" | "not-github" | "missing" | "failed";

export type PullRequestLookup =
  | { ok: true; byBranch: Map<string, PullRequestLink[]> }
  | { ok: false; reason: PullRequestLookupFailure; detail: string };

export interface GhResult {
  /** Exit code; null when the process never ran or was killed. */
  code: number | null;
  /** gh is not installed (spawn ENOENT). */
  missing?: boolean;
  stdout: string;
  stderr: string;
}

export type GhRunner = (cwd: string, args: string[]) => Promise<GhResult>;

/** Runs the user's `gh` in `cwd`, never prompting and never rejecting. Executor
 *  form: core's lib target predates `Promise.withResolvers`. */
export const runGh: GhRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "gh",
      args,
      {
        cwd,
        env: { ...withoutAppImageRuntime(), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        // A numeric code is the exit status; ENOENT and kills carry none.
        const code = "code" in error && typeof error.code === "number" ? error.code : null;
        const missing = "code" in error && error.code === "ENOENT";
        resolve({ code, missing, stdout: stdout ?? "", stderr: stderr || error.message });
      },
    );
  });

function isPullRequestState(value: unknown): value is PullRequestState {
  return value === "open" || value === "draft" || value === "merged" || value === "closed";
}

function isPullRequestChecks(value: unknown): value is PullRequestChecks {
  return value === null || value === "passing" || value === "failing" || value === "pending";
}

/** Persisted links: a malformed entry drops only itself; a non-array is []. */
export function parsePullRequestLinks(raw: unknown): PullRequestLink[] {
  if (!Array.isArray(raw)) return [];
  const links: PullRequestLink[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const { number, url, state } = entry;
    const checks = entry.checks ?? null;
    if (typeof number !== "number" || !Number.isInteger(number) || typeof url !== "string") continue;
    if (!isPullRequestState(state) || !isPullRequestChecks(checks)) continue;
    links.push({ number, url, state, checks });
  }
  return links;
}

function query(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `,$h${i}:String!`).join("");
  const fields = Array.from(
    { length: count },
    (_, i) =>
      `b${i}:pullRequests(headRefName:$h${i},first:${PRS_PER_BRANCH},orderBy:{field:CREATED_AT,direction:DESC})` +
      "{nodes{number url state isDraft headRepository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}",
  ).join(" ");
  return `query($owner:String!,$name:String!${vars}){repository(owner:$owner,name:$name){${fields}}}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GitHub's rollup state to the chip's three answers; null = no checks reported. */
function checksOf(node: Record<string, unknown>): PullRequestChecks {
  const commits = isObject(node.commits) && Array.isArray(node.commits.nodes) ? node.commits.nodes : [];
  const last = commits.at(-1);
  const commit = isObject(last) && isObject(last.commit) ? last.commit : null;
  const rollup = commit !== null && isObject(commit.statusCheckRollup) ? commit.statusCheckRollup.state : null;
  switch (rollup) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

function stateOf(node: Record<string, unknown>): PullRequestState | null {
  switch (node.state) {
    case "OPEN":
      return node.isDraft === true ? "draft" : "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return null;
  }
}

/**
 * One alias's nodes to links. `headRepo` (lowercased `owner/repo`) drops a
 * same-named branch from someone else's fork; null keeps every node.
 */
export function parsePullRequestNodes(nodes: unknown, headRepo: string | null): PullRequestLink[] {
  if (!Array.isArray(nodes)) return [];
  const links: PullRequestLink[] = [];
  for (const node of nodes) {
    if (!isObject(node)) continue;
    const state = stateOf(node);
    if (state === null || typeof node.number !== "number" || typeof node.url !== "string") continue;
    if (!/^https?:\/\//.test(node.url)) continue;
    if (headRepo !== null) {
      const owner = isObject(node.headRepository) ? node.headRepository.nameWithOwner : null;
      if (typeof owner !== "string" || owner.toLowerCase() !== headRepo) continue;
    }
    links.push({ number: node.number, url: node.url, state, checks: checksOf(node) });
  }
  return links;
}

function classify(result: GhResult): { reason: PullRequestLookupFailure; detail: string } {
  const detail = result.stderr.trim().split("\n")[0] ?? "";
  if (result.missing === true) return { reason: "missing", detail };
  if (result.code === 4) return { reason: "unauthenticated", detail };
  if (/known GitHub host|no git remotes|not a git repository/i.test(result.stderr)) return { reason: "not-github", detail };
  return { reason: "failed", detail };
}

/**
 * Every PR whose head is one of `branches` in the repository checked out at
 * `cwd`, newest first per branch. A branch absent from the answer has none.
 */
export async function listBranchPullRequests(
  cwd: string,
  branches: readonly string[],
  deps: { runGh?: GhRunner; runGit?: GitRunner } = {},
): Promise<PullRequestLookup> {
  const gh = deps.runGh ?? runGh;
  const runGit = deps.runGit ?? git;
  const byBranch = new Map<string, PullRequestLink[]>();
  const unique = [...new Set(branches)];
  for (let start = 0; start < unique.length; start += PR_BRANCHES_PER_QUERY) {
    const chunk = unique.slice(start, start + PR_BRANCHES_PER_QUERY);
    const args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}"];
    chunk.forEach((branch, i) => args.push("-f", `h${i}=${branch}`));
    args.push("-f", `query=${query(chunk.length)}`);
    const result = await gh(cwd, args);
    if (result.code !== 0) return { ok: false, ...classify(result) };
    let repository: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      const data = isObject(parsed) && isObject(parsed.data) ? parsed.data : null;
      if (data === null || !isObject(data.repository)) throw new Error("no repository in the answer");
      repository = data.repository;
    } catch (err) {
      return { ok: false, reason: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
    const heads = await Promise.all(chunk.map((branch) => branchPushRepository(cwd, branch, runGit)));
    chunk.forEach((branch, i) => {
      const alias = repository[`b${i}`];
      const links = parsePullRequestNodes(isObject(alias) ? alias.nodes : null, heads[i] ?? null);
      if (links.length > 0) byBranch.set(branch, links);
    });
  }
  return { ok: true, byBranch };
}
