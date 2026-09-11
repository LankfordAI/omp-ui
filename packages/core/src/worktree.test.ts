import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git";
import {
  addWorktree,
  addWorktreeForBranch,
  addWorktreeFromNewBase,
  finalizeMintBranch,
  isWithin,
  linkProjectOmpDir,
  mergeWorktreeBranch,
  mintBranchHash,
  mintWorktreePath,
  previewMerge,
  readDestinationCheckout,
  readMergeBackStatus,
  readWorktreeDirty,
  removeWorktree,
  removeWorktreeBranch,
  renameWorktreeBranch,
  resolveMergeDestination,
  sweepOrphanWorktrees,
  syncWorktree,
} from "./worktree";
import { composeWorktreeBranch } from "./worktree-branch";
import { reclaimCheckouts } from "./worktree-lifecycle";

const cleanups: string[] = [];
afterEach(() => {
  // A git child spawned in the temp repo can still hold a handle on it when the
  // test returns, and Windows then refuses the removal with EBUSY even though
  // every assertion passed. git.test.ts already rides out the same lock
  // (issue #291); the worktree harness now matches it (issue #402).
  for (const dir of cleanups.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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

/**
 * A throwaway repo whose directory slug is exactly `name` — the fixture
 * tmpRepo's mkdtemp basename would make the branch prefix random, and
 * finalizeMintBranch derives the prefix from the project path (issue #482).
 */
async function namedRepo(name: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-mint-"));
  cleanups.push(root);
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
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

/**
 * A bare remote added as `origin` with `branch` pushed and tracked (issue #414):
 * the destination needs an upstream of its own for its push facts to read.
 */
async function trackOrigin(dir: string, branch = "main"): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-remote-"));
  cleanups.push(root);
  const bare = path.join(root, "origin.git");
  await git(root, ["init", "-q", "--bare", "origin.git"]);
  await git(dir, ["remote", "add", "origin", bare]);
  await git(dir, ["push", "-q", "-u", "origin", `${branch}:refs/heads/${branch}`]);
  return bare;
}

/** A minted branch for the fixture repo; the git tests only need a valid, unique name. */
const mint = (segment: string | null = null): string =>
  composeWorktreeBranch("proj", segment, mintBranchHash());

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
    const long = mintWorktreePath(root, "/abs/proj", "x".repeat(100));
    // Deterministic (a rename reuses its slot) and bounded, with a distinct
    // tail so over-long branches never collide (issue #405).
    expect(long).toBe(mintWorktreePath(root, "/abs/proj", "x".repeat(100)));
    expect(path.basename(long).length).toBeLessThanOrEqual(66);
  });

  it("keeps the mint visible past 64 chars and separates two sessions", () => {
    const stem = "omp-ui/base-branch-whose-name-runs-on-and-on-and-on-and-on-for-miles-";
    const a = mintWorktreePath(root, "/abs/proj", `${stem}abcd1234`);
    const b = mintWorktreePath(root, "/abs/proj", `${stem}eeee5678`);
    expect(path.basename(a).endsWith("abcd1234")).toBe(true);
    expect(a).not.toBe(b);
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

    const branch = mint();
    const wtPath = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wtPath, branch, baseSha);
    expect((await git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(branch);
    expect((await git(wtPath, ["rev-parse", "HEAD"])).trim()).toBe(baseSha);
    expect(fs.existsSync(path.join(wtPath, "marker.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "marker.txt"))).toBe(true);
  });

  it("resolves to the baseRef verbatim when one is given", async () => {
    const dir = await tmpRepo();
    const base = await addWorktree(dir, path.join(dir, "wt", "checkout"), mint(), "main");
    expect(base).toBe("main");
  });

  it("resolves to the project's branch name when baseRef is null", async () => {
    const dir = await tmpRepo();
    const base = await addWorktree(dir, path.join(dir, "wt", "checkout"), mint(), null);
    expect(base).toBe("main");
  });

  it("resolves to the project HEAD SHA when baseRef is null and the checkout is detached", async () => {
    const dir = await tmpRepo();
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["checkout", "--detach"]);
    const base = await addWorktree(dir, path.join(dir, "wt", "checkout"), mint(), null);
    expect(base).toBe(head);
  });

  it("rejects with git's own message when the branch already exists", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    await addWorktree(dir, path.join(dir, "wt", "one"), branch, "main");
    await expect(
      addWorktree(dir, path.join(dir, "wt", "two"), branch, "main"),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects outside a repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
    cleanups.push(dir);
    await expect(
      addWorktree(dir, path.join(dir, "wt", "checkout"), mint(), null),
    ).rejects.toThrow(/not a git repository/);
  });
});

describe("finalizeMintBranch (issue #482)", () => {
  it("adds the base segment to a base-blind mint and pins the branch as start point", async () => {
    const dir = await namedRepo("proj");
    const [branch, baseRef] = await finalizeMintBranch(dir, "proj/abcd1234", null, null);
    expect(branch).toBe("proj/main/abcd1234");
    expect(baseRef).toBe("main");
  });

  it("roots the checkout cut with the resolved ref at the base tip and records the base", async () => {
    const dir = await namedRepo("proj");
    const mainTip = (await git(dir, ["rev-parse", "main"])).trim();
    const [branch, baseRef] = await finalizeMintBranch(dir, "proj/abcd1234", null, null);
    const wtPath = path.join(dir, "wt", "checkout");
    const base = await addWorktree(dir, wtPath, branch, baseRef);
    expect(base).toBe("main");
    expect((await git(wtPath, ["rev-parse", "HEAD"])).trim()).toBe(mainTip);
  });

  it("passes a mint through untouched and HEAD-relative on a detached checkout", async () => {
    const dir = await namedRepo("proj");
    await git(dir, ["checkout", "--detach"]);
    const [branch, baseRef] = await finalizeMintBranch(dir, "proj/abcd1234", null, null);
    expect(branch).toBe("proj/abcd1234");
    expect(baseRef).toBeNull();
  });

  it("never renames a hand-typed branch and still pins the start point", async () => {
    const dir = await namedRepo("proj");
    const [branch, baseRef] = await finalizeMintBranch(dir, "feature/mine", null, null);
    expect(branch).toBe("feature/mine");
    expect(baseRef).toBe("main");
  });

  it("leaves a mint under another project's prefix untouched (#438 per-project rule)", async () => {
    const dir = await namedRepo("proj");
    const [branch, baseRef] = await finalizeMintBranch(dir, "other/abcd1234", null, null);
    expect(branch).toBe("other/abcd1234");
    expect(baseRef).toBe("main");
  });

  it("keeps a three-segment mint and its hash when the name already carries the base", async () => {
    const dir = await namedRepo("proj");
    const [branch, baseRef] = await finalizeMintBranch(dir, "proj/main/abcd1234", null, null);
    expect(branch).toBe("proj/main/abcd1234");
    expect(baseRef).toBe("main");
  });

  it("passes the #405 new-base selection through with its explicit baseRef", async () => {
    const dir = await namedRepo("proj");
    const [branch, baseRef] = await finalizeMintBranch(
      dir,
      "proj/TECH-123/abcd1234",
      "TECH-123",
      "main",
    );
    expect(branch).toBe("proj/TECH-123/abcd1234");
    // The payload's ref wins: the new base branch's own start point.
    expect(baseRef).toBe("main");
  });
});

describe("readMergeBackStatus", () => {
  it("reports a mergeable branch against its destination in the project checkout", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await commitFile(wt, "two.txt", "two\n", "two");
    const status = await readMergeBackStatus(dir, branch, "main", wt);
    expect(status).toEqual({
      destination: "main",
      destinationExists: true,
      destinationCheckout: "project",
      branchExists: true,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 2,
      behind: 0,
      worktreeDirty: false,
      destinationUpstream: null,
      destinationAhead: null,
      preview: { kind: "clean" },
    });
  });

  it("reports a destination checked out in another worktree as other", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["worktree", "add", "-q", "-b", "held", path.join(dir, "wt", "held"), "main"]);
    const status = await readMergeBackStatus(dir, branch, "held", wt);
    expect(status.destinationCheckout).toBe("other");
    expect(status.destinationExists).toBe(true);
    expect(status.ahead).toBe(1);
  });

  it("reports a destination checked out nowhere as none", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["branch", "loose", "main"]);
    expect((await readMergeBackStatus(dir, branch, "loose", wt)).destinationCheckout).toBe("none");
  });

  it("counts behind as the commits on destination that branch lacks", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "branch.txt", "b\n", "branch work");
    await commitFile(dir, "a.txt", "a\n", "main one");
    await commitFile(dir, "b.txt", "b\n", "main two");
    const status = await readMergeBackStatus(dir, branch, "main", wt);
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(2);
  });

  it("reads the worktree checkout's dirtiness, and null without a path", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    expect((await readMergeBackStatus(dir, branch, "main", wt)).worktreeDirty).toBe(false);
    fs.writeFileSync(path.join(wt, "scratch.txt"), "uncommitted\n");
    expect((await readMergeBackStatus(dir, branch, "main", wt)).worktreeDirty).toBe(true);
    expect((await readMergeBackStatus(dir, branch, "main", null)).worktreeDirty).toBeNull();
  });

  it("previews conflicts when both sides edit the same line", async () => {
    const dir = await tmpRepo();
    await commitFile(dir, "conflict.txt", "line\n", "seed");
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "conflict.txt", "worktree side\n", "branch edit");
    await commitFile(dir, "conflict.txt", "main side\n", "main edit");
    const status = await readMergeBackStatus(dir, branch, "main", wt);
    expect(status.preview).toEqual({ kind: "conflicts", files: ["conflict.txt"] });
  });

  it("previews clean when the sides touch different files", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "branch.txt", "b\n", "branch edit");
    await commitFile(dir, "main.txt", "m\n", "main edit");
    expect((await readMergeBackStatus(dir, branch, "main", wt)).preview).toEqual({
      kind: "clean",
    });
  });

  it("reports an already-merged branch ahead 0 with a clean preview", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "fold", branch]);
    const status = await readMergeBackStatus(dir, branch, "main", wt);
    expect(status.alreadyMerged).toBe(true);
    expect(status.ahead).toBe(0);
    expect(status.preview).toEqual({ kind: "clean" });
  });

  it("reports mergeInProgress when the project checkout is mid-merge", async () => {
    const dir = await tmpRepo();
    await commitFile(dir, "conflict.txt", "line\n", "seed");
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "conflict.txt", "B\n", "B");
    await commitFile(dir, "conflict.txt", "main\n", "main edit");
    await expect(git(dir, ["merge", "--no-edit", branch])).rejects.toThrow();
    const status = await readMergeBackStatus(dir, branch, "main", wt);
    expect(status.mergeInProgress).toBe(true);
  });

  it("answers a missing destination ref with destinationExists false and unknown preview", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    const status = await readMergeBackStatus(dir, branch, "ghost", wt);
    expect(status).toEqual({
      destination: "ghost",
      destinationExists: false,
      destinationCheckout: "none",
      branchExists: true,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 0,
      behind: 0,
      worktreeDirty: false,
      destinationUpstream: null,
      destinationAhead: null,
      preview: { kind: "unknown" },
    });
  });

  it("answers a missing branch ref with branchExists false", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    await addWorktree(dir, path.join(dir, "wt", "checkout"), branch, "main");
    await git(dir, ["update-ref", "-d", `refs/heads/${branch}`]);
    const status = await readMergeBackStatus(dir, branch, "main", null);
    expect(status.branchExists).toBe(false);
    expect(status.destinationExists).toBe(true);
    expect(status.preview).toEqual({ kind: "unknown" });
  });

  it("answers all-false for a directory that is not a git repo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
    cleanups.push(dir);
    const status = await readMergeBackStatus(dir, mint(), "main", null);
    expect(status).toEqual({
      destination: "main",
      destinationExists: false,
      destinationCheckout: "none",
      branchExists: false,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 0,
      behind: 0,
      worktreeDirty: null,
      destinationUpstream: null,
      destinationAhead: null,
      preview: { kind: "unknown" },
    });
  });

  it("reads destination push facts from the destination's own upstream", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "branch.txt", "b\n", "branch work");
    await trackOrigin(dir);

    const tracked = await readMergeBackStatus(dir, branch, "main", wt);
    expect(tracked.destinationUpstream).toBe("origin/main");
    // 0, not null: main sits exactly on origin/main even while the branch is ahead.
    expect(tracked.destinationAhead).toBe(0);
    expect(tracked.ahead).toBe(1);

    await commitFile(dir, "main.txt", "m\n", "main work");
    const ahead = await readMergeBackStatus(dir, branch, "main", wt);
    expect(ahead.destinationUpstream).toBe("origin/main");
    expect(ahead.destinationAhead).toBe(1);
    expect(ahead.behind).toBe(1);
  });

  it("answers null destination push facts without an upstream, and never throws", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");

    // No remote configured at all.
    const noRemote = await readMergeBackStatus(dir, branch, "main", wt);
    expect([noRemote.destinationUpstream, noRemote.destinationAhead]).toEqual([null, null]);

    // Upstream configured but its tracking ref deleted: unverifiable (issue #399).
    await trackOrigin(dir);
    await git(dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
    const unresolvable = await readMergeBackStatus(dir, branch, "main", wt);
    expect([unresolvable.destinationUpstream, unresolvable.destinationAhead]).toEqual([null, null]);
  });

  it("keeps destination work visible after the branch itself is merged", async () => {
    // `ahead` compares branch to destination, so it reads 0 once the merge
    // lands; destinationAhead is what still tells the finish dialog that
    // destination carries unpushed commits (issue #414).
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "branch.txt", "b\n", "branch work");
    await trackOrigin(dir);
    await commitFile(dir, "main.txt", "m\n", "main work");

    const before = await readMergeBackStatus(dir, branch, "main", wt);
    expect([before.ahead, before.destinationAhead]).toEqual([1, 1]);

    const merged = await mergeWorktreeBranch(dir, branch, "main", {
      scratchRoot: path.join(dir, "scratch"),
    });
    expect(merged.kind).toBe("merged");

    const after = await readMergeBackStatus(dir, branch, "main", wt);
    expect(after.alreadyMerged).toBe(true);
    expect(after.ahead).toBe(0);
    // origin/main still lacks all three: main's own commit, the branch's, and
    // the merge commit that joined them.
    expect([after.destinationUpstream, after.destinationAhead]).toEqual(["origin/main", 3]);
  });
});

describe("readWorktreeDirty", () => {
  it("reads untracked files, clean trees, and unreadable paths", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    expect(await readWorktreeDirty(dir, wt)).toBe(false);
    fs.writeFileSync(path.join(wt, "draft.txt"), "work in progress\n");
    expect(await readWorktreeDirty(dir, wt)).toBe(true);
    expect(await readWorktreeDirty(dir, path.join(dir, "nowhere"))).toBeNull();
  });

  it("ignores the generated project .omp link", async () => {
    const dir = await tmpRepo();
    await commitFile(dir, ".gitignore", ".omp/\n", "ignore project config");
    fs.mkdirSync(path.join(dir, ".omp"));
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await linkProjectOmpDir(dir, wt);

    expect(await readWorktreeDirty(dir, wt)).toBe(false);
    expect((await readMergeBackStatus(dir, branch, "main", wt)).worktreeDirty).toBe(false);
    fs.writeFileSync(path.join(wt, "draft.txt"), "work in progress\n");
    expect(await readWorktreeDirty(dir, wt)).toBe(true);
  });

  it("counts a different .omp link as the user's own work", async () => {
    // Nothing ignores `.omp` here, so git reports the link itself: the lone
    // symlink entry `?? .omp` on POSIX, and the Windows junction's directory
    // form `?? .omp/` (issue #423). Both are excused only while they resolve to
    // the project's own `.omp`.
    const dir = await tmpRepo();
    fs.mkdirSync(path.join(dir, ".omp"));
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await linkProjectOmpDir(dir, wt);
    expect(await readWorktreeDirty(dir, wt)).toBe(false);

    const elsewhere = path.join(dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "notes.md"), "mine\n");
    fs.rmSync(path.join(wt, ".omp"));
    fs.symlinkSync(elsewhere, path.join(wt, ".omp"), "junction");
    expect(await readWorktreeDirty(dir, wt)).toBe(true);
  });

  it("counts the checkout's own .omp directory as dirty work", async () => {
    // The directory form must not excuse a real `.omp` the checkout owns —
    // resolution, not the entry text, decides (issue #423).
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    fs.mkdirSync(path.join(wt, ".omp"));
    fs.writeFileSync(path.join(wt, ".omp", "notes.md"), "mine\n");
    expect(await readWorktreeDirty(dir, wt)).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "reads a junction behind a .omp/ ignore as clean, for git hides it there",
    async () => {
      // A junction is a directory to git, so the `.omp/` rule matches it and
      // status reports nothing at all — the probe has no entry to excuse, and
      // the different-link case above is why that case ignores nothing.
      const dir = await tmpRepo();
      await commitFile(dir, ".gitignore", ".omp/\n", "ignore project config");
      fs.mkdirSync(path.join(dir, ".omp"));
      const branch = mint();
      const wt = path.join(dir, "wt", "checkout");
      await addWorktree(dir, wt, branch, "main");
      const elsewhere = path.join(dir, "elsewhere");
      fs.mkdirSync(elsewhere);
      fs.writeFileSync(path.join(elsewhere, "notes.md"), "mine\n");
      fs.symlinkSync(elsewhere, path.join(wt, ".omp"), "junction");
      expect(await readWorktreeDirty(dir, wt)).toBe(false);
    },
  );
});

describe("readDestinationCheckout", () => {
  it("locates the destination across project, other worktree, and nowhere", async () => {
    const dir = await tmpRepo();
    expect(await readDestinationCheckout(dir, "main")).toBe("project");
    await git(dir, ["worktree", "add", "-q", "-b", "held", path.join(dir, "wt", "held"), "main"]);
    expect(await readDestinationCheckout(dir, "held")).toBe("other");
    expect(await readDestinationCheckout(dir, "ghost")).toBe("none");
  });

  it("answers none outside a repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
    cleanups.push(dir);
    expect(await readDestinationCheckout(dir, "main")).toBe("none");
  });
});

describe("mergeWorktreeBranch", () => {
  it("writes a merge commit even when the destination is an ancestor", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await commitFile(wt, "two.txt", "two\n", "two (Fixes #7)");
    const before = (await git(dir, ["rev-parse", "main"])).trim();
    const tip = (await git(wt, ["rev-parse", "HEAD"])).trim();

    const result = await mergeWorktreeBranch(dir, branch, "main", {
      scratchRoot: path.join(dir, "scratch"),
    });

    expect(result).toEqual({
      kind: "merged",
      destination: "main",
      commits: 2,
      files: [],
      conflictsLeftIn: null,
    });
    // No fast-forward: two parents, the old destination first.
    const parents = (await git(dir, ["log", "--format=%P", "-1", "main"])).trim().split(" ");
    expect(parents).toEqual([before, tip]);
    expect((await git(dir, ["log", "--format=%B", "-1", "main"])).trim()).toBe(
      `Merge work into main (2 commits)\n\n- one\n- two (Fixes #7)\n\nFixes #7`,
    );
  });

  it("borrows the subject of a single folded commit", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "only.txt", "only\n", "fix: only change\n\nCloses #12\n");

    const result = await mergeWorktreeBranch(dir, branch, "main", {
      scratchRoot: path.join(dir, "scratch"),
    });

    expect(result).toEqual({
      kind: "merged",
      destination: "main",
      commits: 1,
      files: [],
      conflictsLeftIn: null,
    });
    expect((await git(dir, ["log", "--format=%B", "-1", "main"])).trim()).toBe(
      `fix: only change\n\nFixes #12`,
    );
  });

  it("excludes merge commits on the branch from the message", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await commitFile(dir, "two.txt", "two\n", "two");
    // The session syncs main in: that merge commit is not its own work.
    await git(wt, ["merge", "-q", "--no-ff", "-m", "sync main", "main"]);

    const result = await mergeWorktreeBranch(dir, branch, "main", {
      scratchRoot: path.join(dir, "scratch"),
    });

    expect(result.kind).toBe("merged");
    expect((await git(dir, ["log", "--format=%B", "-1", "main"])).trim()).toBe(
      "one",
    );
  });

  it("creates a two-parent merge commit when the histories have diverged", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await commitFile(dir, "two.txt", "two\n", "two");
    const result = await mergeWorktreeBranch(dir, branch, "main", {
      scratchRoot: path.join(dir, "scratch"),
    });
    expect(result).toEqual({
      kind: "merged",
      destination: "main",
      commits: 1,
      files: [],
      conflictsLeftIn: null,
    });
    const parents = (await git(dir, ["log", "--format=%P", "-1", "main"])).trim().split(" ");
    expect(parents).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, "one.txt"), "utf8")).toBe("one\n");
    expect(fs.readFileSync(path.join(dir, "two.txt"), "utf8")).toBe("two\n");
  });

  it("leaves a conflicted merge in the project with the file list", async () => {
    const dir = await tmpRepo();
    await commitFile(dir, "conflict.txt", "line\n", "seed");
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "conflict.txt", "B1\n", "B1");
    await commitFile(wt, "conflict.txt", "B2\n", "B2");
    await commitFile(dir, "conflict.txt", "main\n", "main edit");
    const before = (await git(dir, ["rev-parse", "main"])).trim();
    const result = await mergeWorktreeBranch(dir, branch, "main", {
      scratchRoot: path.join(dir, "scratch"),
    });
    expect(result).toEqual({
      kind: "conflicts",
      destination: "main",
      commits: 2,
      files: ["conflict.txt"],
      conflictsLeftIn: "project",
    });
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);
    expect((await git(dir, ["rev-parse", "main"])).trim()).toBe(before);
    // The generated message waits for the user's `git merge --continue`.
    expect(fs.readFileSync(path.join(dir, ".git", "MERGE_MSG"), "utf8")).toContain(
      `Merge work into main (2 commits)`,
    );
  });

  it("reports already-merged without touching the destination", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "fold", branch]);
    const before = (await git(dir, ["rev-parse", "main"])).trim();
    const result = await mergeWorktreeBranch(dir, branch, "main", {
      scratchRoot: path.join(dir, "scratch"),
    });
    expect(result).toEqual({
      kind: "already-merged",
      destination: "main",
      commits: 0,
      files: [],
      conflictsLeftIn: null,
    });
    expect((await git(dir, ["rev-parse", "main"])).trim()).toBe(before);
  });

  it("rejects when the branch no longer exists", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    await addWorktree(dir, path.join(dir, "wt", "checkout"), branch, "main");
    await git(dir, ["update-ref", "-d", `refs/heads/${branch}`]);
    await expect(
      mergeWorktreeBranch(dir, branch, "main", { scratchRoot: path.join(dir, "scratch") }),
    ).rejects.toThrow(/no longer exists/);
  });

  it("merges in a scratch worktree when the destination is checked out nowhere", async () => {
    const dir = await tmpRepo();
    const scratchRoot = path.join(dir, "scratch");
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["branch", "loose", "main"]);
    const before = (await git(dir, ["rev-parse", "loose"])).trim();
    const tip = (await git(wt, ["rev-parse", "HEAD"])).trim();

    const result = await mergeWorktreeBranch(dir, branch, "loose", { scratchRoot });

    expect(result).toEqual({
      kind: "merged",
      destination: "loose",
      commits: 1,
      files: [],
      conflictsLeftIn: null,
    });
    // The destination advances to a merge commit whose first parent is the
    // old destination tip.
    const parents = (await git(dir, ["log", "--format=%P", "-1", "loose"])).trim().split(" ");
    expect(parents).toEqual([before, tip]);
    // The scratch checkout is gone from disk and from git's ledger; the
    // project checkout never moved.
    expect(fs.readdirSync(scratchRoot)).toEqual([]);
    expect(await git(dir, ["worktree", "list", "--porcelain"])).not.toContain("scratch");
    expect((await git(dir, ["branch", "--show-current"])).trim()).toBe("main");
  });

  it("aborts a conflicted scratch merge and leaves nothing behind", async () => {
    const dir = await tmpRepo();
    const scratchRoot = path.join(dir, "scratch");
    await commitFile(dir, "conflict.txt", "line\n", "seed");
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "conflict.txt", "worktree side\n", "branch edit");
    await git(dir, ["branch", "loose", "main"]);
    // Diverge loose without leaving it checked out anywhere.
    const tmp = path.join(dir, "wt", "tmp");
    await git(dir, ["worktree", "add", "-q", tmp, "loose"]);
    await commitFile(tmp, "conflict.txt", "loose side\n", "loose edit");
    await git(dir, ["worktree", "remove", "--force", tmp]);
    const before = (await git(dir, ["rev-parse", "loose"])).trim();

    const result = await mergeWorktreeBranch(dir, branch, "loose", { scratchRoot });

    expect(result).toEqual({
      kind: "conflicts",
      destination: "loose",
      commits: 1,
      files: ["conflict.txt"],
      conflictsLeftIn: null,
    });
    expect((await git(dir, ["rev-parse", "loose"])).trim()).toBe(before);
    await expect(git(dir, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).rejects.toThrow();
    expect(fs.readdirSync(scratchRoot)).toEqual([]);
  });

  it("rejects when the destination is checked out in another worktree", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["worktree", "add", "-q", "-b", "held", path.join(dir, "wt", "held"), "main"]);
    await expect(
      mergeWorktreeBranch(dir, branch, "held", { scratchRoot: path.join(dir, "scratch") }),
    ).rejects.toThrow(/checked out in another worktree — pick another destination/);
  });

  it("rejects with git's message when a dirty file would be overwritten", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "dirty.txt", "committed in branch\n", "dirty");
    const before = (await git(dir, ["rev-parse", "main"])).trim();
    fs.writeFileSync(path.join(dir, "dirty.txt"), "local edit\n");
    await expect(
      mergeWorktreeBranch(dir, branch, "main", { scratchRoot: path.join(dir, "scratch") }),
    ).rejects.toThrow(/would be overwritten/);
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
    const branch = mint();
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
    const branch = mint();
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
    const branch = mint();
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

  it("resolves to no-repo instead of throwing outside a repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
    cleanups.push(dir);
    expect(await resolveMergeDestination(dir, "main")).toEqual({
      destination: null,
      reason: "no-repo",
    });
  });
});

describe("addWorktreeForBranch", () => {
  it("checks out an existing branch and records the default branch as base", async () => {
    const dir = await tmpRepo();
    await git(dir, ["branch", "topic"]);
    const tmp = path.join(dir, "wt", "tmp");
    await git(dir, ["worktree", "add", "-q", tmp, "topic"]);
    await commitFile(tmp, "topic.txt", "t\n", "topic work");
    await git(dir, ["worktree", "remove", "--force", tmp]);

    const wtPath = path.join(dir, "wt", "topic");
    const base = await addWorktreeForBranch(dir, wtPath, "topic");

    expect(base).toBe("main");
    expect((await git(wtPath, ["branch", "--show-current"])).trim()).toBe("topic");
    // The branch's prior work is present in the checkout.
    expect(fs.readFileSync(path.join(wtPath, "topic.txt"), "utf8")).toBe("t\n");
  });

  it("rejects when the branch is held by another worktree", async () => {
    const dir = await tmpRepo();
    await git(dir, ["branch", "topic"]);
    await addWorktreeForBranch(dir, path.join(dir, "wt", "one"), "topic");
    await expect(
      addWorktreeForBranch(dir, path.join(dir, "wt", "two"), "topic"),
    ).rejects.toThrow(/already used by worktree|already checked out/);
  });

  it("rejects for a branch that does not exist", async () => {
    const dir = await tmpRepo();
    await expect(
      addWorktreeForBranch(dir, path.join(dir, "wt", "ghost"), "ghost"),
    ).rejects.toThrow(/ghost/);
  });
});

describe("addWorktreeFromNewBase (issue #405)", () => {
  const listBranches = async (dir: string): Promise<string[]> =>
    (await git(dir, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

  it("creates both branches, cuts the session from the base, records the base", async () => {
    const dir = await tmpRepo();
    await commitFile(dir, "other.txt", "o\n", "base tip");
    const wtPath = path.join(dir, "wt", "omp-ui-TECH-123-f918c1d1");

    const base = await addWorktreeFromNewBase(
      dir, wtPath, "omp-ui/TECH-123/f918c1d1", "TECH-123", "main");

    expect(base).toBe("TECH-123");
    expect((await listBranches(dir)).sort()).toEqual(
      ["TECH-123", "main", "omp-ui/TECH-123/f918c1d1"].sort(),
    );
    // The project's checkout never moved.
    expect((await git(dir, ["branch", "--show-current"])).trim()).toBe("main");
    // The session branch is cut AT the new base's commit: same tip until
    // session work lands on top of it.
    const sessionTip = (await git(wtPath, ["rev-parse", "HEAD"])).trim();
    const tip = (await git(dir, ["rev-parse", "TECH-123"])).trim();
    expect(sessionTip).toBe(tip);
    expect((await git(wtPath, ["branch", "--show-current"])).trim()).toBe(
      "omp-ui/TECH-123/f918c1d1",
    );
  });

  it("cuts the base at HEAD when no start point is given", async () => {
    const dir = await tmpRepo();
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const wtPath = path.join(dir, "wt", "s");

    const base = await addWorktreeFromNewBase(dir, wtPath, "omp-ui/s1a2b3c4", "NEWBASE", null);

    expect(base).toBe("NEWBASE");
    expect((await git(dir, ["rev-parse", "NEWBASE"])).trim()).toBe(head);
  });

  it("rolls the new base back when the session branch collides with it", async () => {
    const dir = await tmpRepo();
    await expect(
      addWorktreeFromNewBase(dir, path.join(dir, "wt", "x"), "TECH-123", "TECH-123", "main"),
    ).rejects.toThrow(/already exists/);
    // Neither the checkout nor the created ref survives the rollback.
    expect(await listBranches(dir)).toEqual(["main"]);
    expect(fs.existsSync(path.join(dir, "wt", "x"))).toBe(false);
  });

  it("propagates git's refusal for a taken base name and creates nothing", async () => {
    const dir = await tmpRepo();
    await git(dir, ["branch", "TECH-123"]);
    await expect(
      addWorktreeFromNewBase(
        dir, path.join(dir, "wt", "y"), "omp-ui/TECH-123/f918c1d1", "TECH-123", "main"),
    ).rejects.toThrow(/already exists/);
    expect(await listBranches(dir)).toEqual(["TECH-123", "main"].sort());
    expect(fs.existsSync(path.join(dir, "wt", "y"))).toBe(false);
  });
});

describe("previewMerge", () => {
  it("answers unknown where the probe cannot run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
    cleanups.push(dir);
    expect(await previewMerge(dir, "main", "other")).toEqual({ kind: "unknown" });
  });

  it("names the conflicted file without touching either tree", async () => {
    const dir = await tmpRepo();
    await commitFile(dir, "conflict.txt", "line\n", "seed");
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "conflict.txt", "side A\n", "A");
    await commitFile(dir, "conflict.txt", "side B\n", "B");
    expect(await previewMerge(dir, "main", branch)).toEqual({
      kind: "conflicts",
      files: ["conflict.txt"],
    });
    // A prediction moves nothing: no merge is in progress anywhere.
    await expect(git(dir, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).rejects.toThrow();
  });
});

describe("syncWorktree", () => {
  it("merges the destination's new commits into the worktree", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(dir, "new.txt", "n\n", "main moves on");

    expect(await syncWorktree(dir, wt, "main")).toEqual({ kind: "merged", source: "main", files: [] });
    expect(fs.readFileSync(path.join(wt, "new.txt"), "utf8")).toBe("n\n");
    // Catching up twice is a no-op, not an empty merge.
    expect(await syncWorktree(dir, wt, "main")).toEqual({
      kind: "up-to-date",
      source: "main",
      files: [],
    });
  });

  it("leaves conflicts in the worktree, mid-merge, and reports them", async () => {
    const dir = await tmpRepo();
    await commitFile(dir, "conflict.txt", "line\n", "seed");
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "conflict.txt", "worktree side\n", "branch edit");
    await commitFile(dir, "conflict.txt", "main side\n", "main edit");

    const result = await syncWorktree(dir, wt, "main");
    expect(result).toEqual({ kind: "conflicts", source: "main", files: ["conflict.txt"] });
    // The merge is in progress in the WORKTREE — that is the point (issue #387).
    await expect(git(wt, ["rev-parse", "--verify", "MERGE_HEAD"])).resolves.toBeTruthy();
    expect(fs.readFileSync(path.join(wt, "conflict.txt"), "utf8")).toContain("<<<<<<<");
  });

  it("refuses a dirty checkout before touching git", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(dir, "new.txt", "n\n", "main moves on");
    fs.writeFileSync(path.join(wt, "draft.txt"), "uncommitted\n");

    await expect(syncWorktree(dir, wt, "main")).rejects.toThrow(
      /commit or discard the worktree's changes before syncing/,
    );
    expect((await git(wt, ["rev-parse", "HEAD"])).trim()).toBe(
      (await git(dir, ["rev-parse", branch])).trim(),
    );
    await expect(git(wt, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).rejects.toThrow();
  });

  it("rejects when the source branch no longer exists", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await expect(syncWorktree(dir, wt, "gone")).rejects.toThrow(/no longer exists/);
  });
});

describe("renameWorktreeBranch", () => {
  it("follows the checkout's HEAD and retires the old name", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");

    await renameWorktreeBranch(wt, branch, "feat/renamed");

    expect((await git(wt, ["branch", "--show-current"])).trim()).toBe("feat/renamed");
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe("");
    expect((await git(dir, ["branch", "--format=%(refname:short)", "--list", "feat/renamed"])).trim()).toBe("feat/renamed");
    // The commit history moved with the name.
    expect(fs.readFileSync(path.join(wt, "one.txt"), "utf8")).toBe("one\n");
  });

  it("rejects with git's message on a name collision", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await expect(renameWorktreeBranch(wt, branch, "main")).rejects.toThrow(/already exists/);
  });
});

describe("removeWorktreeBranch", () => {
  it("removes a branch verified merged into a named candidate", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "fold", branch]);
    // The delete path runs after the checkout is gone — mirror that order.
    await removeWorktree(dir, wt);
    const result = await removeWorktreeBranch(dir, branch, ["main"]);
    expect(result).toEqual({ kind: "removed" });
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe("");
  });

  it("removes a branch merged into a candidate that is not HEAD (-D after verified ancestry)", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "fold", branch]);
    await removeWorktree(dir, wt);
    // The project moves off main to a branch without the commit: plain -d
    // would refuse; the caller's ancestry check licenses -D (issue #385).
    await git(dir, ["checkout", "-q", "-b", "elsewhere", "HEAD~1"]);
    const result = await removeWorktreeBranch(dir, branch, ["main"]);
    expect(result).toEqual({ kind: "removed" });
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe("");
  });

  it("keeps a branch merged into none of the candidates", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await removeWorktree(dir, wt);
    const result = await removeWorktreeBranch(dir, branch, ["main", "release/x"]);
    expect(result).toEqual({ kind: "kept-unmerged" });
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe(branch);
  });

  it("keeps the branch when no candidate exists as a local branch", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    await commitFile(wt, "one.txt", "one\n", "one");
    await removeWorktree(dir, wt);
    const result = await removeWorktreeBranch(dir, branch, ["deleted-candidate"]);
    expect(result).toEqual({ kind: "kept-no-destination" });
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe(branch);
  });

  it("reports already-gone when the branch ref no longer exists", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    await addWorktree(dir, path.join(dir, "wt", "checkout"), branch, "main");
    await git(dir, ["update-ref", "-d", `refs/heads/${branch}`]);
    expect(await removeWorktreeBranch(dir, branch, ["main"])).toEqual({ kind: "already-gone" });
  });

  it("reports kept-refused with git's detail when git itself refuses", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wt = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wt, branch, "main");
    // Merged into main, but the checkout still lives: -D refuses a branch
    // another worktree holds — the caller removes the checkout first.
    expect(await removeWorktreeBranch(dir, branch, ["main"])).toEqual({
      kind: "kept-refused",
      detail: expect.stringContaining(branch),
    });
    expect(
      (await git(dir, ["branch", "--format=%(refname:short)", "--list", branch])).trim(),
    ).toBe(branch);
  });
});

describe("removeWorktree", () => {
  it("removes a dirty checkout, keeping the branch", async () => {
    const dir = await tmpRepo();
    const branch = mint();
    const wtPath = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wtPath, branch, "main");
    fs.writeFileSync(path.join(wtPath, "untracked.txt"), "dirty\n");
    await removeWorktree(dir, wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect((await git(dir, ["branch", "--list", branch])).trim()).toBe(branch);
  });

  it("falls back to fs removal and prune when the checkout dir is already gone", async () => {
    const dir = await tmpRepo();
    const branch = mint();
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
    await addWorktree(dir, wtPath, mint(), "main");
    fs.mkdirSync(path.join(dir, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".omp", "mcp.json"), "{}\n");
    await linkProjectOmpDir(dir, wtPath);
    // Break the checkout's git metadata so `git worktree remove` fails and the
    // recursive-rm fallback runs (issue #291's cleanup path). Either delete can
    // now reach the tree only after the generated link is gone, so the project's
    // own `.omp` is unreachable from the checkout on every platform (#325, #424).

    await removeWorktree(dir, wtPath);

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.readFileSync(path.join(dir, ".omp", "mcp.json"), "utf8")).toBe("{}\n");
  });

  it("unlinks the generated .omp link before git removes the checkout (issue #424)", async () => {
    // The git path, not the fallback: Git for Windows reads the junction's
    // directory attribute, so handing it the linked tree walks into the
    // project's real `.omp` and leaves the checkout standing.
    const dir = await tmpRepo();
    const wtPath = path.join(dir, "wt", "checkout");
    await addWorktree(dir, wtPath, mint(), "main");
    fs.mkdirSync(path.join(dir, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".omp", "mcp.json"), "{}\n");
    await linkProjectOmpDir(dir, wtPath);

    await removeWorktree(dir, wtPath);

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.readFileSync(path.join(dir, ".omp", "mcp.json"), "utf8")).toBe("{}\n");
  });
});

describe("reclaimCheckouts", () => {
  it("uses the explicit survivor snapshot and reclaims a distinct checkout once", async () => {
    const project = await tmpRepo();
    const worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-lifecycle-"));
    cleanups.push(worktreesRoot);
    const branch = mint();
    const worktreePath = mintWorktreePath(worktreesRoot, project, branch);
    const base = await addWorktree(project, worktreePath, branch, null);
    const checkout = { projectCwd: project, worktree: { path: worktreePath, branch, base } };

    await expect(
      reclaimCheckouts([checkout], {
        worktreesRoot,
        survivingSessions: [{ worktree: checkout.worktree }],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ checkoutKept: "shared", branchOutcome: "not-attempted" }),
    ]);
    expect(fs.existsSync(worktreePath)).toBe(true);

    const reclaimed = await reclaimCheckouts([checkout, checkout], {
      worktreesRoot,
      survivingSessions: [],
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toEqual(
      expect.objectContaining({ checkoutKept: null, branchOutcome: "removed" }),
    );
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect((await git(project, ["branch", "--list", branch])).trim()).toBe("");
  });

  it("never removes a checkout whose descriptor is non-canonical", async () => {
    const project = await tmpRepo();
    const worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-lifecycle-"));
    cleanups.push(worktreesRoot);
    const branch = mint();
    const worktreePath = path.join(worktreesRoot, "not-the-minted-path");
    await addWorktree(project, worktreePath, branch, null);

    const [result] = await reclaimCheckouts(
      [{ projectCwd: project, worktree: { path: worktreePath, branch, base: "main" } }],
      { worktreesRoot, survivingSessions: [], warn: () => {} },
    );
    expect(result?.checkoutKept).toBe("non-canonical");
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it("reclaims a checkout whose branch was renamed in place (canonical keys on the slot dir)", async () => {
    const project = await tmpRepo();
    const worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-lifecycle-"));
    cleanups.push(worktreesRoot);
    const branch = mint();
    const worktreePath = mintWorktreePath(worktreesRoot, project, branch);
    const base = await addWorktree(project, worktreePath, branch, null);
    // Issues #386/#389: auto-naming renames the branch; the path stays put.
    await renameWorktreeBranch(worktreePath, branch, "feat/renamed");

    const [result] = await reclaimCheckouts(
      [{ projectCwd: project, worktree: { path: worktreePath, branch: "feat/renamed", base } }],
      { worktreesRoot, survivingSessions: [], warn: () => {} },
    );
    expect(result).toEqual(
      expect.objectContaining({ checkoutKept: null, branchOutcome: "removed" }),
    );
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect((await git(project, ["branch", "--list", "feat/renamed"])).trim()).toBe("");
  });

  it("honours keepBranch: checkout gone, ref survives, kept-requested reported", async () => {
    const project = await tmpRepo();
    const worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-lifecycle-"));
    cleanups.push(worktreesRoot);
    const branch = mint();
    const worktreePath = mintWorktreePath(worktreesRoot, project, branch);
    const base = await addWorktree(project, worktreePath, branch, null);
    await commitFile(worktreePath, "one.txt", "one\n", "one");

    const [result] = await reclaimCheckouts(
      [{ projectCwd: project, worktree: { path: worktreePath, branch, base }, keepBranch: true }],
      { worktreesRoot, survivingSessions: [] },
    );
    expect(result).toEqual(
      expect.objectContaining({ checkoutKept: null, branchOutcome: "kept-requested" }),
    );
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect((await git(project, ["branch", "--list", branch])).trim()).toBe(branch);
  });

  it("deletes the branch via mergedInto when the base destination does not contain it", async () => {
    const project = await tmpRepo();
    const worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-lifecycle-"));
    cleanups.push(worktreesRoot);
    const branch = mint();
    const worktreePath = mintWorktreePath(worktreesRoot, project, branch);
    const base = await addWorktree(project, worktreePath, branch, null);
    await commitFile(worktreePath, "one.txt", "one\n", "one");
    // release/x (checked out nowhere) was just merged to contain the branch.
    await git(project, ["branch", "release/x", branch]);

    const [result] = await reclaimCheckouts(
      [
        {
          projectCwd: project,
          worktree: { path: worktreePath, branch, base },
          mergedInto: "release/x",
        },
      ],
      { worktreesRoot, survivingSessions: [] },
    );
    expect(result).toEqual(
      expect.objectContaining({ checkoutKept: null, branchOutcome: "removed" }),
    );
    expect((await git(project, ["branch", "--list", branch])).trim()).toBe("");
    expect((await git(project, ["branch", "--list", "release/x"])).trim()).toBe("release/x");
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
