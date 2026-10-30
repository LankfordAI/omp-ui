import { describe, expect, it } from "vitest";
import { listBranchPullRequests, parsePullRequestLinks, type GhRunner } from "./pull-requests";
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
  it("drops malformed entries and keeps the record's valid links", () => {
    expect(
      parsePullRequestLinks([
        { number: 1, url: "https://x/1", state: "merged", checks: null },
        { number: "2", url: "https://x/2", state: "open", checks: null },
        { number: 3, url: "https://x/3", state: "weird", checks: null },
        { number: 4, url: "https://x/4", state: "draft" },
      ]),
    ).toEqual([
      { number: 1, url: "https://x/1", state: "merged", checks: null },
      { number: 4, url: "https://x/4", state: "draft", checks: null },
    ]);
    expect(parsePullRequestLinks("nope")).toEqual([]);
  });
});
