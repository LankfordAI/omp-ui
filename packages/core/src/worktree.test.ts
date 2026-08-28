import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git";
import {
  addWorktree,
  isWithin,
  linkProjectOmpDir,
  mergeWorktreeBranch,
  mintWorktreeBranch,
  mintWorktreePath,
  readMergeBackStatus,
  removeWorktree,
  removeWorktreeBranch,
  resolveMergeDestination,
  sweepOrphanWorktrees,
} from "./worktree";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway git repo with one committed seed file, like branch-diff.test.ts. */
async function tmpRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
  cleanups.push(dir);
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  // Windows runners default to core.autocrlf=true, which checks files out as
  // CRLF and breaks assertions on committed LF content (issue #291).
  await git(dir, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(dir, ".seed"), "seed\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** Writes `file` with `content` in `dir` and commits it. */
async function commitFile(
  dir: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  fs.writeFileSync(path.join(dir, file), content);
  await git(dir, ["add", file]);
  await git(dir, ["commit", "-q", "-m", message]);
}

describe("mintWorktreeBranch", () => {
  it("mints an omp-ui-prefixed 8-hex name, distinct per call", () => {
    const a = mintWorktreeBranch();
    const b = mintWorktreeBranch();
    expect(a).toMatch(/^omp-ui\/[0-9a-f]{8}$/);
    expect(b).toMatch(/^omp-ui\/[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe("isWithin", () => {
  const root = "/state/worktrees";

  it("accepts strict descendants and rejects the root, prefix siblings, and escapes", () => {
    expect(isWithin(root, "/state/worktrees/proj--abc/checkout")).toBe(true);
    expect(isWithin(root, "/state/worktrees/..feature/checkout")).toBe(true);
    expect(isWithin(root, "/state/worktrees")).toBe(false);
    expect(isWithin(root, "/state/worktrees-evil/checkout")).toBe(false);
    expect(isWithin(root, "/state/worktrees/../other")).toBe(false);
    expect(isWithin(root, "/other")).toBe(false);
  });
});

describe("mintWorktreePath", () => {
  const root = "/state/omp-ui/worktrees";

  it("is stable per project and branch, keyed to the resolved project cwd", () => {
    const a = mintWorktreePath(root, "/abs/projects/my repo", "omp-ui/abcd1234");
    const b = mintWorktreePath(root, "/abs/projects/my repo", "omp-ui/abcd1234");
    expect(a).toBe(b);
    expect(path.basename(path.dirname(a))).toMatch(/^my-repo--[0-9a-f]{8}$/);
    expect(path.basename(a)).toBe("omp-ui-abcd1234");
  });

  it("stays distinct for same-named projects at different paths", () => {
    const a = mintWorktreePath(root, "/a/proj", "omp-ui/abcd1234");
    const b = mintWorktreePath(root, "/b/proj", "omp-ui/abcd1234");
    expect(a).not.toBe(b);
    // Same slug, different hash8: the distinction is the resolved-cwd digest.
    expect(path.basename(path.dirname(a))).not.toBe(path.basename(path.dirname(b)));
    expect(path.basename(path.dirname(a))).toMatch(/^proj--[0-9a-f]{8}$/);
    expect(path.basename(path.dirname(b))).toMatch(/^proj--[0-9a-f]{8}$/);
  });

  it("slugs branch separators into the checkout name", () => {
    expect(path.basename(mintWorktreePath(root, "/abs/proj", "a/b"))).toBe("a-b");
  });

  it("slugs degenerate branch names to a trimmed, capped, or fallback name", () => {
    expect(path.basename(mintWorktreePath(root, "/abs/proj", "///"))).toBe("branch");
    expect(path.basename(mintWorktreePath(root, "/abs/proj", "-a-"))).toBe("a");
    expect(path.basename(mintWorktreePath(root, "/abs/proj", "x".repeat(100)))).toHaveLength(64);
  });
});

describe("addWorktree", () => {
  it("checks out the new branch at the given base ref", async () => {
    const dir = await tmpRepo();
    // A commit lands after the base ref: a checkout rooted at the base must
    // not contain it, which also discriminates an ignored baseRef argument.
    fs.writeFileSync(path.join(dir, "marker.txt"), "marker\n");
    await git(dir, ["add", "marker.txt"]);
    await git(dir, ["commit", "-q", "-m", "marker"]);
    const baseSha = (await git(dir, ["rev-parse", "HEAD~1"])).trim();

    const branch = mintWorktreeBranch();
    const wtPath = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wtPath, branch, baseSha);
    expect((await git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(branch);
    expect((await git(wtPath, ["rev-parse", "HEAD"])).trim()).toBe(baseSha);
    expect(fs.existsSync(path.join(wtPath, "marker.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "marker.txt"))).toBe(true);
  });

  it("resolves to the baseRef verbatim when one is given", async () => {
    const dir = await tmpRepo();
    const base = await addWorktree(dir, path.join(dir, "wt", "checkout"), mintWorktreeBranch(), "main");
    expect(base).toBe("main");
  });

  it("resolves to the project's branch name when baseRef is null", async () => {
    const dir = await tmpRepo();
    const base = await addWorktree(dir, path.join(dir, "wt", "checkout"), mintWorktreeBranch(), null);
    expect(base).toBe("main");
  });

  it("resolves to the project HEAD SHA when baseRef is null and the checkout is detached", async () => {
    const dir = await tmpRepo();
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["checkout", "--detach"]);
    const base = await addWorktree(dir, path.join(dir, "wt", "checkout"), mintWorktreeBranch(), null);
    expect(base).toBe(head);
  });

  it("rejects with git's own message when the branch already exists", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    await addWorktree(dir, path.join(dir, "wt", "one"), branch, "main");
    await expect(
      addWorktree(dir, path.join(dir, "wt", "two"), branch, "main"),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects outside a repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
    cleanups.push(dir);
    await expect(
      addWorktree(dir, path.join(dir, "wt", "checkout"), mintWorktreeBranch(), null),
    ).rejects.toThrow(/not a git repository/);
  });
});

describe("readMergeBackStatus", () => {
  it("reports a mergeable branch base checked out in the project", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await commitFile(wt, "two.txt", "two\n", "two");
    const status = await readMergeBackStatus(dir, branch, "main");
    expect(status).toEqual({
      destination: "main",
      reason: null,
      destinationCheckedOut: true,
      branchExists: true,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 2,
    });
  });

  it("marks a branch base on another project branch as not checked out", async () => {
    const dir = await tmpRepo();
    await git(dir, ["branch", "feature"]);
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "feature");
    await commitFile(wt, "one.txt", "one\n", "one");
    const status = await readMergeBackStatus(dir, branch, "feature");
    expect(status.destination).toBe("feature");
    expect(status.destinationCheckedOut).toBe(false);
    expect(status.branchExists).toBe(true);
    expect(status.alreadyMerged).toBe(false);
    expect(status.ahead).toBe(1);
    expect(status.mergeInProgress).toBe(false);
    expect(status.reason).toBeNull();
  });

  it("resolves to base-gone when the base branch has been deleted", async () => {
    const dir = await tmpRepo();
    await git(dir, ["branch", "feature"]);
    const branch = mintWorktreeBranch();
    await addWorktree(dir, path.join(dir, "wt", "checkout"), branch, "feature");
    await git(dir, ["branch", "-D", "feature"]);
    const status = await readMergeBackStatus(dir, branch, "feature");
    expect(status).toEqual({
      destination: null,
      reason: "base-gone",
      destinationCheckedOut: false,
      branchExists: true,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 0,
    });
  });

  it("resolves a SHA base to the local branch still at that tip", async () => {
    const dir = await tmpRepo();
    const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    // A branch-side commit, so main is the unique branch still at the SHA.
    await commitFile(wt, "one.txt", "one\n", "one");
    const status = await readMergeBackStatus(dir, branch, sha);
    expect(status.destination).toBe("main");
    expect(status.destinationCheckedOut).toBe(true);
    expect(status.branchExists).toBe(true);
    expect(status.alreadyMerged).toBe(false);
    expect(status.ahead).toBe(1);
    expect(status.reason).toBeNull();
  });

  it("resolves a moved-on SHA base to the project's current branch that contains it", async () => {
    const dir = await tmpRepo();
    const cut = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    // main moves past the cut point, so no branch points at it anymore.
    await commitFile(dir, "two.txt", "two\n", "two");
    const status = await readMergeBackStatus(dir, branch, cut);
    expect(status.destination).toBe("main");
    expect(status.destinationCheckedOut).toBe(true);
    expect(status.branchExists).toBe(true);
    expect(status.alreadyMerged).toBe(false);
    expect(status.ahead).toBe(1);
    expect(status.reason).toBeNull();
  });

  it("resolves to no-branch-match when a detached project matches no branch", async () => {
    const dir = await tmpRepo();
    const cut = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await commitFile(dir, "two.txt", "two\n", "two");
    await git(dir, ["checkout", "--detach"]);
    const status = await readMergeBackStatus(dir, branch, cut);
    expect(status).toEqual({
      destination: null,
      reason: "no-branch-match",
      destinationCheckedOut: false,
      branchExists: true,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 0,
    });
  });

  it("reports an already-merged branch as ahead 0", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "fold", branch]);
    const status = await readMergeBackStatus(dir, branch, "main");
    expect(status).toEqual({
      destination: "main",
      reason: null,
      destinationCheckedOut: true,
      branchExists: true,
      mergeInProgress: false,
      alreadyMerged: true,
      ahead: 0,
    });
  });

  it("reports mergeInProgress when a conflicted merge is left in the project", async () => {
    const dir = await tmpRepo();
    await commitFile(dir, "conflict.txt", "line\n", "seed");
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "conflict.txt", "B\n", "B");
    await commitFile(dir, "conflict.txt", "main\n", "main edit");
    await expect(git(dir, ["merge", "--no-edit", branch])).rejects.toThrow();
    const status = await readMergeBackStatus(dir, branch, "main");
    expect(status.destination).toBe("main");
    expect(status.destinationCheckedOut).toBe(true);
    expect(status.branchExists).toBe(true);
    expect(status.alreadyMerged).toBe(false);
    expect(status.mergeInProgress).toBe(true);
    expect(status.reason).toBeNull();
  });

  it("reports branchExists false when the worktree branch was deleted", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    await addWorktree(dir, path.join(dir, "wt", "checkout"), branch, "main");
    await git(dir, ["update-ref", "-d", `refs/heads/${branch}`]);
    const status = await readMergeBackStatus(dir, branch, "main");
    expect(status).toEqual({
      destination: "main",
      reason: null,
      destinationCheckedOut: true,
      branchExists: false,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 0,
    });
  });

  it("resolves to no-repo for a directory that is not a git repo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
    cleanups.push(dir);
    const status = await readMergeBackStatus(dir, mintWorktreeBranch(), "main");
    expect(status).toEqual({
      destination: null,
      reason: "no-repo",
      destinationCheckedOut: false,
      branchExists: false,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 0,
    });
  });
});

describe("mergeWorktreeBranch", () => {
  it("fast-forwards when the destination is an ancestor of the branch", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await commitFile(wt, "two.txt", "two\n", "two");
    const tip = (await git(wt, ["rev-parse", "HEAD"])).trim();
    const result = await mergeWorktreeBranch(dir, branch, "main");
    expect(result).toEqual({ kind: "ff", destination: "main", commits: 2, files: [] });
    expect((await git(dir, ["rev-parse", "main"])).trim()).toBe(tip);
    // A fast-forward has no merge commit: the tip has a single parent.
    expect((await git(dir, ["log", "--format=%P", "-1", "main"])).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it("creates a two-parent merge commit when the histories have diverged", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await commitFile(dir, "two.txt", "two\n", "two");
    const result = await mergeWorktreeBranch(dir, branch, "main");
    expect(result).toEqual({ kind: "merged", destination: "main", commits: 1, files: [] });
    const parents = (await git(dir, ["log", "--format=%P", "-1", "main"])).trim().split(" ");
    expect(parents).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, "one.txt"), "utf8")).toBe("one\n");
    expect(fs.readFileSync(path.join(dir, "two.txt"), "utf8")).toBe("two\n");
  });

  it("leaves a conflicted merge in the project with the file list", async () => {
    const dir = await tmpRepo();
    await commitFile(dir, "conflict.txt", "line\n", "seed");
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "conflict.txt", "B1\n", "B1");
    await commitFile(wt, "conflict.txt", "B2\n", "B2");
    await commitFile(dir, "conflict.txt", "main\n", "main edit");
    const before = (await git(dir, ["rev-parse", "main"])).trim();
    const result = await mergeWorktreeBranch(dir, branch, "main");
    expect(result).toEqual({
      kind: "conflicts",
      destination: "main",
      commits: 2,
      files: ["conflict.txt"],
    });
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);
    expect((await git(dir, ["rev-parse", "main"])).trim()).toBe(before);
  });

  it("reports already-merged without touching the destination", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "fold", branch]);
    const before = (await git(dir, ["rev-parse", "main"])).trim();
    const result = await mergeWorktreeBranch(dir, branch, "main");
    expect(result).toEqual({ kind: "already-merged", destination: "main", commits: 0, files: [] });
    expect((await git(dir, ["rev-parse", "main"])).trim()).toBe(before);
  });

  it("rejects when the branch no longer exists", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    await addWorktree(dir, path.join(dir, "wt", "checkout"), branch, "main");
    await git(dir, ["update-ref", "-d", `refs/heads/${branch}`]);
    await expect(mergeWorktreeBranch(dir, branch, "main")).rejects.toThrow(/no longer exists/);
  });

  it("rejects when the destination is not the project's current branch", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["checkout", "-q", "-b", "elsewhere"]);
    await expect(mergeWorktreeBranch(dir, branch, "main")).rejects.toThrow(
      /check out main in the project before merging/,
    );
  });

  it("rejects with git's message when a dirty file would be overwritten", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "dirty.txt", "committed in branch\n", "dirty");
    const before = (await git(dir, ["rev-parse", "main"])).trim();
    fs.writeFileSync(path.join(dir, "dirty.txt"), "local edit\n");
    await expect(mergeWorktreeBranch(dir, branch, "main")).rejects.toThrow(
      /would be overwritten/,
    );
    expect(fs.readFileSync(path.join(dir, "dirty.txt"), "utf8")).toBe("local edit\n");
    expect((await git(dir, ["rev-parse", "main"])).trim()).toBe(before);
  });
});


describe("resolveMergeDestination", () => {
  it("resolves a branch base to that branch name", async () => {
    const dir = await tmpRepo();
    await git(dir, ["branch", "feature"]);
    expect(await resolveMergeDestination(dir, "feature")).toEqual({
      destination: "feature",
      reason: null,
    });
  });

  it("resolves a SHA base to the local branch still at that tip", async () => {
    const dir = await tmpRepo();
    const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    // A branch-side commit, so main is the unique branch still at the SHA.
    await commitFile(wt, "one.txt", "one\n", "one");
    expect(await resolveMergeDestination(dir, sha)).toEqual({
      destination: "main",
      reason: null,
    });
  });

  it("resolves a moved-on SHA base to the project's current branch that contains it", async () => {
    const dir = await tmpRepo();
    const cut = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    // main moves past the cut point, so no branch points at it anymore.
    await commitFile(dir, "two.txt", "two\n", "two");
    expect(await resolveMergeDestination(dir, cut)).toEqual({
      destination: "main",
      reason: null,
    });
  });

  it("resolves to no-branch-match when a detached project matches no branch", async () => {
    const dir = await tmpRepo();
    const cut = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await commitFile(dir, "two.txt", "two\n", "two");
    await git(dir, ["checkout", "--detach"]);
    expect(await resolveMergeDestination(dir, cut)).toEqual({
      destination: null,
      reason: "no-branch-match",
    });
  });

  it("resolves to base-gone for a deleted name and for a null base", async () => {
    const dir = await tmpRepo();
    await git(dir, ["branch", "feature"]);
    await git(dir, ["branch", "-D", "feature"]);
    expect(await resolveMergeDestination(dir, "feature")).toEqual({
      destination: null,
      reason: "base-gone",
    });
    expect(await resolveMergeDestination(dir, null)).toEqual({
      destination: null,
      reason: "base-gone",
    });
  });
});

describe("removeWorktreeBranch", () => {
  it("removes a branch verified merged into the resolved destination", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "fold", branch]);
    // The delete path runs after the checkout is gone — mirror that order.
    await removeWorktree(dir, wt);
    const result = await removeWorktreeBranch(dir, branch, "main");
    expect(result).toEqual({ kind: "removed" });
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe("");
  });

  it("keeps an unmerged branch with the kept-unmerged outcome", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await removeWorktree(dir, wt);
    const result = await removeWorktreeBranch(dir, branch, "main");
    expect(result).toEqual({ kind: "kept-unmerged" });
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe(branch);
  });

  it("keeps the branch when the recorded base no longer resolves", async () => {
    const dir = await tmpRepo();
    await git(dir, ["branch", "feature"]);
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "feature");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["branch", "-D", "feature"]);
    await removeWorktree(dir, wt);
    const result = await removeWorktreeBranch(dir, branch, "feature");
    expect(result).toEqual({ kind: "kept-no-destination" });
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe(branch);
  });

  it("reports already-gone when the branch ref no longer exists", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    await addWorktree(dir, path.join(dir, "wt", "checkout"), branch, "main");
    await git(dir, ["update-ref", "-d", `refs/heads/${branch}`]);
    expect(await removeWorktreeBranch(dir, branch, "main")).toEqual({ kind: "already-gone" });
  });

  it("keeps a merged branch when the project sits on another branch (git -d refusal)", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "fold", branch]);
    await removeWorktree(dir, wt);
    // The project moves off main to a branch that does not contain the
    // branch's commit: `git branch -d` verifies against HEAD.
    await git(dir, ["checkout", "-q", "-b", "elsewhere", "HEAD~1"]);
    const result = await removeWorktreeBranch(dir, branch, "main");
    expect(result.kind).toBe("kept-refused");
    expect(result.detail).toBeTruthy();
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe(branch);
  });
});

describe("removeWorktree", () => {
  it("removes a dirty checkout, keeping the branch", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wtPath = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wtPath, branch, "main");
    fs.writeFileSync(path.join(wtPath, "untracked.txt"), "dirty\n");
    await removeWorktree(dir, wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe(branch);
  });

  it("falls back to fs removal and prune when the checkout dir is already gone", async () => {
    const dir = await tmpRepo();
    const branch = mintWorktreeBranch();
    const wtPath = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wtPath, branch, "main");
    fs.rmSync(wtPath, { recursive: true, force: true });
    await removeWorktree(dir, wtPath);
    const list = await git(dir, ["worktree", "list", "--porcelain"]);
    // git emits porcelain paths in forward-slash form on every platform,
    // but fs.realpathSync.native carries the platform separator — normalize
    // both sides so the comparison holds on Windows too (issue #230).
    expect(
      list.split("\n").filter((l) => l.startsWith("worktree ")).map(path.normalize),
    ).toEqual([path.normalize(`worktree ${fs.realpathSync.native(dir)}`)]);
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe(branch);
  });

  it("unlinks a linked project .omp instead of deleting through it (issue #325)", async () => {
    const dir = await tmpRepo();
    const wtPath = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wtPath, mintWorktreeBranch(), "main");
    fs.mkdirSync(path.join(dir, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".omp", "mcp.json"), "{}\n");
    await linkProjectOmpDir(dir, wtPath);
    // Break the checkout's git metadata so `git worktree remove` fails and the
    // recursive-rm fallback runs with the symlink still in place — the branch
    // that would delete the user's project config if it ever traversed.
    fs.rmSync(path.join(wtPath, ".git"), { force: true });

    await removeWorktree(dir, wtPath);

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.readFileSync(path.join(dir, ".omp", "mcp.json"), "utf8")).toBe("{}\n");
  });
});

describe("sweepOrphanWorktrees", () => {
  /** A bare temp dir standing in for the worktrees root — the sweep is pure fs. */
  function tmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-sweep-"));
    cleanups.push(dir);
    return dir;
  }

  it("removes unreferenced leaves while a referenced sibling keeps its project dir", async () => {
    const root = tmpRoot();
    const kept = path.join(root, "proj--aaaa1111", "kept");
    const orphan = path.join(root, "proj--aaaa1111", "orphan");
    fs.mkdirSync(kept, { recursive: true });
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "file.txt"), "x\n");

    const removed = await sweepOrphanWorktrees(root, new Set([path.resolve(kept)]));
    expect(removed).toEqual([path.join(path.resolve(root), "proj--aaaa1111", "orphan")]);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.join(root, "proj--aaaa1111"))).toBe(true);
  });

  it("prunes a project dir emptied by the sweep", async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "gone--bbbb2222", "leaf"), { recursive: true });

    const removed = await sweepOrphanWorktrees(root, new Set());
    expect(removed).toEqual([path.join(path.resolve(root), "gone--bbbb2222", "leaf")]);
    expect(fs.existsSync(path.join(root, "gone--bbbb2222"))).toBe(false);
  });

  it("removes a stray non-directory entry at the project level", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "stray.txt"), "junk\n");

    const removed = await sweepOrphanWorktrees(root, new Set());
    expect(removed).toEqual([path.join(path.resolve(root), "stray.txt")]);
    expect(fs.existsSync(path.join(root, "stray.txt"))).toBe(false);
  });

  it("resolves to [] when the root does not exist", async () => {
    const root = path.join(tmpRoot(), "never-created");
    expect(await sweepOrphanWorktrees(root, new Set())).toEqual([]);
  });

  it("unlinks a linked project .omp instead of deleting through it (issue #325)", async () => {
    const root = tmpRoot();
    const project = tmpRoot();
    const leaf = path.join(root, "proj--cccc3333", "leaf");
    fs.mkdirSync(leaf, { recursive: true });
    fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(project, ".omp", "mcp.json"), "{}\n");
    await linkProjectOmpDir(project, leaf);

    const removed = await sweepOrphanWorktrees(root, new Set());

    expect(removed).toEqual([path.join(path.resolve(root), "proj--cccc3333", "leaf")]);
    expect(fs.readFileSync(path.join(project, ".omp", "mcp.json"), "utf8")).toBe("{}\n");
  });
});

describe("linkProjectOmpDir", () => {
  /** A project dir and a checkout dir outside it — the link is pure fs. */
  function pair(): { project: string; checkout: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-omp-link-"));
    cleanups.push(dir);
    const project = path.join(dir, "project");
    const checkout = path.join(dir, "worktrees", "proj--aaaa1111", "branch");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(checkout, { recursive: true });
    return { project, checkout };
  }

  it("links the project's .omp into the checkout, so a write there lands on the project file", async () => {
    const { project, checkout } = pair();
    fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(project, ".omp", "mcp.json"), '{"mcpServers":{}}\n');

    await linkProjectOmpDir(project, checkout);

    const link = path.join(checkout, ".omp");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // One source of truth: omp reads the project's file in the checkout, and a
    // write through the link is the project's own file, not a drifting copy.
    expect(fs.readFileSync(path.join(link, "mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
    fs.writeFileSync(path.join(link, "mcp.json"), '{"mcpServers":{"a":{}}}\n');
    expect(fs.readFileSync(path.join(project, ".omp", "mcp.json"), "utf8")).toBe(
      '{"mcpServers":{"a":{}}}\n',
    );
  });

  it("leaves a checkout that already owns a real .omp alone", async () => {
    const { project, checkout } = pair();
    fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(project, ".omp", "mcp.json"), "project\n");
    // A repo that tracks `.omp/` checks its own copy out; the branch's config
    // is what omp reads there, so the link must not shadow it.
    fs.mkdirSync(path.join(checkout, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(checkout, ".omp", "mcp.json"), "tracked\n");

    await linkProjectOmpDir(project, checkout);

    expect(fs.lstatSync(path.join(checkout, ".omp")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(checkout, ".omp", "mcp.json"), "utf8")).toBe("tracked\n");
  });

  it("is a no-op without a project .omp, and idempotent when there is one", async () => {
    const { project, checkout } = pair();

    await linkProjectOmpDir(project, checkout);
    expect(fs.existsSync(path.join(checkout, ".omp"))).toBe(false);

    fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
    await linkProjectOmpDir(project, checkout);
    await linkProjectOmpDir(project, checkout);
    expect(fs.lstatSync(path.join(checkout, ".omp")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(checkout, ".omp"))).toBe(path.join(project, ".omp"));
  });

  it("skips a project .omp that is a file rather than a directory", async () => {
    const { project, checkout } = pair();
    fs.writeFileSync(path.join(project, ".omp"), "not a directory\n");

    await linkProjectOmpDir(project, checkout);

    expect(fs.existsSync(path.join(checkout, ".omp"))).toBe(false);
  });
});
