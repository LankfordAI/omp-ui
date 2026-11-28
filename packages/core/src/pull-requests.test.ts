import { describe, expect, it } from "vitest";
import { allPullRequestsMerged, listBranchPullRequests, parsePullRequestLinks, type GhRunner } from "./pull-requests";
import type { GitRunner } from "./branches";

const node = (patch: Record<string, unknown> = {}) => ({
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  state: "OPEN",
  isDraft: false,
  headRepository: { nameWithOwner: "acme/app" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  ...patch,
});

// origin is the only remote and pushes to acme/app.
const runGit: GitRunner = async (_cwd, args) => {
  if (args[0] === "rev-parse") return "/repo\n";
  if (args[0] === "config") return "";
  if (args[0] === "remote" && args[1] === "get-url") return "git@github.com:acme/app.git\n";
  if (args[0] === "remote") return "origin\n";
  throw new Error(`unexpected git ${args.join(" ")}`);
};

describe("listBranchPullRequests (issue #985)", () => {
  it("maps each branch alias to links, drops same-named fork heads, and reads checks", async () => {
    const gh: GhRunner = async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: {
          repository: {
            b0: { nodes: [node(), node({ number: 9, headRepository: { nameWithOwner: "someone/app" } })] },
            b1: { nodes: [node({ number: 3, state: "MERGED", commits: { nodes: [] } })] },
            b2: { nodes: [] },
          },
        },
      }),
    });
    const answer = await listBranchPullRequests("/repo", ["feat", "done", "none"], { runGh: gh, runGit });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.byBranch.get("feat")).toEqual([
      { number: 7, url: "https://github.com/acme/app/pull/7", state: "open", checks: "failing" },
    ]);
    expect(answer.byBranch.get("done")).toEqual([
      { number: 3, url: "https://github.com/acme/app/pull/7", state: "merged", checks: null },
    ]);
    expect(answer.byBranch.has("none")).toBe(false);
  });

  it("extracts lowercased headRefOid and omits absent or malformed values", async () => {
    const upperSha = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    let capturedQuery = "";
    const gh: GhRunner = async (_cwd, args) => {
      capturedQuery = args.find((a) => a.startsWith("query=")) ?? "";
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          data: {
            repository: {
              b0: {
                nodes: [
                  node({ number: 10, state: "MERGED", headRefOid: upperSha }),
                  node({ number: 11, state: "MERGED", headRefOid: "not-a-sha" }),
                  node({ number: 12, state: "MERGED" }),
                ],
              },
            },
          },
        }),
      };
    };
    const answer = await listBranchPullRequests("/repo", ["feat"], { runGh: gh, runGit });
    expect(capturedQuery).toContain("headRefOid");
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.byBranch.get("feat")).toEqual([
      { number: 10, url: "https://github.com/acme/app/pull/7", state: "merged", checks: "failing", headRefOid: upperSha.toLowerCase() },
      { number: 11, url: "https://github.com/acme/app/pull/7", state: "merged", checks: "failing" },
      { number: 12, url: "https://github.com/acme/app/pull/7", state: "merged", checks: "failing" },
    ]);
  });

  it("reports a logged-out gh and a non-GitHub remote as distinct failures", async () => {
    const loggedOut: GhRunner = async () => ({ code: 4, stdout: "", stderr: "gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.\n" });
    expect(await listBranchPullRequests("/repo", ["a"], { runGh: loggedOut, runGit })).toMatchObject({ ok: false, reason: "unauthenticated" });
    const gitlab: GhRunner = async () => ({
      code: 1,
      stdout: "",
      stderr: "none of the git remotes configured for this repository point to a known GitHub host.",
    });
    expect(await listBranchPullRequests("/repo", ["a"], { runGh: gitlab, runGit })).toMatchObject({ ok: false, reason: "not-github" });
  });
});

describe("parsePullRequestLinks", () => {
  it("drops malformed entries, preserves valid headRefOid, and drops malformed headRefOid without dropping the link", () => {
    const validSha = "0123456789ABCDEF0123456789abcdef01234567";
    expect(
      parsePullRequestLinks([
        { number: 1, url: "https://x/1", state: "merged", checks: null, headRefOid: validSha },
        { number: "2", url: "https://x/2", state: "open", checks: null },
        { number: 3, url: "https://x/3", state: "weird", checks: null },
        { number: 4, url: "https://x/4", state: "draft", headRefOid: "short" },
      ]),
    ).toEqual([
      { number: 1, url: "https://x/1", state: "merged", checks: null, headRefOid: validSha.toLowerCase() },
      { number: 4, url: "https://x/4", state: "draft", checks: null },
    ]);
    expect(parsePullRequestLinks("nope")).toEqual([]);
  });
});

describe("allPullRequestsMerged", () => {
  it("is true only when non-empty and every link is merged", () => {
    const merged = { number: 1, url: "https://x/1", state: "merged" as const, checks: null };
    const open = { number: 2, url: "https://x/2", state: "open" as const, checks: null };
    expect(allPullRequestsMerged([])).toBe(false);
    expect(allPullRequestsMerged([merged])).toBe(true);
    expect(allPullRequestsMerged([merged, open])).toBe(false);
  });
});
