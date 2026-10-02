import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readBranchDiff } from "./branch-diff";

const execFileP = promisify(execFile);

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway git repo with one committed seed file and a HEAD to diff against. */
async function tmpRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "branch-diff-test-"));
  cleanups.push(dir);
  const git = (args: string[]) => execFileP("git", args, { cwd: dir });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(dir, ".seed"), "seed\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "init"]);
  return dir;
}
/**
 * Points a remote-tracking ref at main's commit and aims the origin/HEAD
 * symref at it, so `readDefaultBranch` resolves the default the way a
 * cloned repo's would — no network remote needed.
 */
async function seedOriginMain(dir: string): Promise<void> {
  const git = (args: string[]) => execFileP("git", args, { cwd: dir });
  await git(["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
  await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
}

/** Seeds origin/main + origin/HEAD and makes origin/main the upstream of local main. */
async function trackOriginMain(dir: string): Promise<void> {
  const git = (args: string[]) => execFileP("git", args, { cwd: dir });
  // A remote that is never contacted, so `branch -u` accepts origin/main.
  await git(["remote", "add", "origin", "https://example.invalid/repo.git"]);
  await seedOriginMain(dir);
  await git(["branch", "-q", "-u", "origin/main", "main"]);
}

describe("readBranchDiff", () => {
  it("reads the branch, tracked changes vs HEAD, and untracked files", async () => {
    const dir = await tmpRepo();
    fs.writeFileSync(path.join(dir, "app.ts"), "export const a = 1;\n");
    await execFileP("git", ["add", ".", "-A"], { cwd: dir });
    await execFileP("git", ["commit", "-q", "-m", "add app"], { cwd: dir });

    fs.writeFileSync(path.join(dir, "app.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(dir, "notes.md"), "# new\n");

    const diff = await readBranchDiff(dir);
    expect(diff.repoRoot).toBe(fs.realpathSync.native(dir));
    expect(diff.branch).toBe("main");
    expect(diff.diff).toContain("diff --git a/app.ts b/app.ts");
    expect(diff.diff).toContain("-export const a = 1;");
    expect(diff.diff).toContain("+export const a = 2;");
    expect(diff.untracked).toEqual([{ path: "notes.md", text: "# new\n", binary: false }]);
    expect(diff.mergeBase).toBeNull();
    // On the default branch itself there is no branch-local work: the plain
    // HEAD reading stands (issue #711).
    expect(diff.baseRef).toBeNull();
  });

  it("reports non-repo projects as null fields, not an error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "branch-diff-test-"));
    cleanups.push(dir);
    expect(await readBranchDiff(dir)).toEqual({
      branch: null,
      repoRoot: null,
      diff: "",
      untracked: [],
      mergeBase: null,
      baseRef: null,
    });
  });

  it("survives an unborn HEAD with a fallback diff", async () => {
    // `git diff HEAD` rejects before the first commit; the staged/unstaged
    // halves must still surface a change.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "branch-diff-test-"));
    cleanups.push(dir);
    await execFileP("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileP("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileP("git", ["config", "user.name", "test"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "draft.ts"), "export const d = 1;\n");
    await execFileP("git", ["add", "."], { cwd: dir });

    const diff = await readBranchDiff(dir);
    expect(diff.branch).toBe("main");
    expect(diff.diff).toContain("+export const d = 1;");
  });

  it("marks untracked binary files as binary", async () => {
    const dir = await tmpRepo();
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const diff = await readBranchDiff(dir);
    expect(diff.untracked).toEqual([{ path: "blob.bin", text: "", binary: true }]);
  });

  it("skips oversized untracked files", async () => {
    const dir = await tmpRepo();
    fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(400_000));
    const diff = await readBranchDiff(dir);
    expect(diff.untracked).toEqual([]);
  });

  it("diffs from the merge-base when a worktree base is given", async () => {
    const dir = await tmpRepo();
    const git = (args: string[]) => execFileP("git", args, { cwd: dir });
    await git(["checkout", "-q", "-b", "omp-ui/session"]);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 1;\n");
    await git(["add", "feature.ts"]);
    await git(["commit", "-q", "-m", "feature"]);

    const diff = await readBranchDiff(dir, "main");
    const expectedBase = (await git(["merge-base", "main", "HEAD"])).stdout.trim();
    expect(diff.mergeBase).toBe(expectedBase);
    expect(diff.baseRef).toBe("main");
    expect(diff.diff).toContain("diff --git a/feature.ts b/feature.ts");
    expect(diff.diff).toContain("+export const f = 1;");
  });

  it("keeps the diff scoped to the session branch after the base advances", async () => {
    const dir = await tmpRepo();
    const git = (args: string[]) => execFileP("git", args, { cwd: dir });
    await git(["checkout", "-q", "-b", "omp-ui/session"]);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 1;\n");
    await git(["add", "feature.ts"]);
    await git(["commit", "-q", "-m", "feature"]);

    // main moves on after the cut — its new file must not enter the diff.
    await git(["checkout", "-q", "main"]);
    fs.writeFileSync(path.join(dir, "mainline.ts"), "export const m = 1;\n");
    await git(["add", "mainline.ts"]);
    await git(["commit", "-q", "-m", "mainline"]);
    await git(["checkout", "-q", "omp-ui/session"]);

    const diff = await readBranchDiff(dir, "main");
    expect(diff.mergeBase).toBe((await git(["merge-base", "main", "HEAD"])).stdout.trim());
    expect(diff.baseRef).toBe("main");
    expect(diff.diff).toContain("+export const f = 1;");
    expect(diff.diff).not.toContain("mainline.ts");
  });

  it("folds uncommitted edits into the single merge-base diff", async () => {
    const dir = await tmpRepo();
    const git = (args: string[]) => execFileP("git", args, { cwd: dir });
    await git(["checkout", "-q", "-b", "omp-ui/session"]);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 1;\n");
    await git(["add", "feature.ts"]);
    await git(["commit", "-q", "-m", "feature"]);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 2;\n");

    const diff = await readBranchDiff(dir, "main");
    // One diff covers the commit plus the working-tree edit — a single
    // file entry, showing the working-tree content.
    expect(diff.baseRef).toBe("main");
    expect(diff.diff.match(/^diff --git a\/feature\.ts b\/feature\.ts$/gm)).toHaveLength(1);
    expect(diff.diff).toContain("+export const f = 2;");
    expect(diff.diff).not.toContain("+export const f = 1;");
  });

  it("falls back to the HEAD diff with a null mergeBase for a nonexistent base", async () => {
    const dir = await tmpRepo();
    fs.writeFileSync(path.join(dir, ".seed"), "changed\n");

    const diff = await readBranchDiff(dir, "no-such-ref");
    expect(diff.mergeBase).toBeNull();
    expect(diff.baseRef).toBeNull();
    expect(diff.diff).toContain("+changed");
  });

  it("auto-bases a plain-checkout branch on the default branch's merge-base", async () => {
    // Issue #711: the first commit must not erase the session's work.
    const dir = await tmpRepo();
    const git = (args: string[]) => execFileP("git", args, { cwd: dir });
    await git(["checkout", "-q", "-b", "feat/x"]);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 1;\n");
    await git(["add", "feature.ts"]);
    await git(["commit", "-q", "-m", "feature"]);

    // main advances after the cut — its commit is not this branch's work.
    await git(["checkout", "-q", "main"]);
    fs.writeFileSync(path.join(dir, "mainline.ts"), "export const m = 1;\n");
    await git(["add", "mainline.ts"]);
    await git(["commit", "-q", "-m", "mainline"]);
    await git(["checkout", "-q", "feat/x"]);

    fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 2;\n");

    const diff = await readBranchDiff(dir);
    expect(diff.mergeBase).toBe((await git(["merge-base", "main", "HEAD"])).stdout.trim());
    expect(diff.baseRef).toBe("main");
    expect(diff.diff).toContain("+export const f = 2;");
    expect(diff.diff).not.toContain("mainline.ts");
  });

  it("retries the origin/<default> ref when the local default branch is gone", async () => {
    const dir = await tmpRepo();
    const git = (args: string[]) => execFileP("git", args, { cwd: dir });
    await seedOriginMain(dir);
    await git(["checkout", "-q", "-b", "feat/x"]);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 1;\n");
    await git(["add", "feature.ts"]);
    await git(["commit", "-q", "-m", "feature"]);
    await git(["branch", "-q", "-D", "main"]);

    const diff = await readBranchDiff(dir);
    expect(diff.mergeBase).toBe((await git(["merge-base", "origin/main", "HEAD"])).stdout.trim());
    expect(diff.baseRef).toBe("origin/main");
    expect(diff.diff).toContain("+export const f = 1;");
  });

  it("diffs vs HEAD on a detached HEAD with no recorded base", async () => {
    const dir = await tmpRepo();
    const git = (args: string[]) => execFileP("git", args, { cwd: dir });
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["checkout", "-q", "--detach", sha]);
    fs.writeFileSync(path.join(dir, ".seed"), "detached\n");

    const diff = await readBranchDiff(dir);
    expect(diff.branch).toBeNull();
    expect(diff.mergeBase).toBeNull();
    expect(diff.baseRef).toBeNull();
    expect(diff.diff).toContain("+detached");
  });

  it("diffs vs HEAD when no default branch resolves", async () => {
    const dir = await tmpRepo();
    const git = (args: string[]) => execFileP("git", args, { cwd: dir });
    await git(["branch", "-m", "feature"]);
    fs.writeFileSync(path.join(dir, ".seed"), "changed\n");

    const diff = await readBranchDiff(dir);
    expect(diff.branch).toBe("feature");
    expect(diff.mergeBase).toBeNull();
    expect(diff.baseRef).toBeNull();
    expect(diff.diff).toContain("+changed");
  });

  it("keeps unpushed default-branch commits visible against the upstream", async () => {
    // Issue #711: a commit on the default branch must not erase the work.
    const dir = await tmpRepo();
    const git = (args: string[]) => execFileP("git", args, { cwd: dir });
    await trackOriginMain(dir);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 1;\n");
    await git(["add", "feature.ts"]);
    await git(["commit", "-q", "-m", "feature"]);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 2;\n");

    const diff = await readBranchDiff(dir);
    expect(diff.branch).toBe("main");
    expect(diff.baseRef).toBe("origin/main");
    expect(diff.mergeBase).toBe((await git(["rev-parse", "origin/main"])).stdout.trim());
    expect(diff.diff.match(/^diff --git a\/feature\.ts /gm)).toHaveLength(1);
    expect(diff.diff).toContain("+export const f = 2;");
  });

  it("prefers the default branch over a feature branch's own upstream", async () => {
    const dir = await tmpRepo();
    const git = (args: string[]) => execFileP("git", args, { cwd: dir });
    await git(["remote", "add", "origin", "https://example.invalid/repo.git"]);
    await git(["checkout", "-q", "-b", "feat/x"]);
    fs.writeFileSync(path.join(dir, "feature.ts"), "export const f = 1;\n");
    await git(["add", "feature.ts"]);
    await git(["commit", "-q", "-m", "feature"]);
    // Fully pushed: the upstream sits at HEAD.
    await git(["update-ref", "refs/remotes/origin/feat/x", "HEAD"]);
    await git(["branch", "-q", "-u", "origin/feat/x"]);

    const diff = await readBranchDiff(dir);
    expect(diff.baseRef).toBe("main");
    expect(diff.diff).toContain("+export const f = 1;");
  });

  it("diffs vs HEAD on the default branch when its upstream is gone", async () => {
    const dir = await tmpRepo();
    const git = (args: string[]) => execFileP("git", args, { cwd: dir });
    await trackOriginMain(dir);
    await git(["update-ref", "-d", "refs/remotes/origin/main"]);
    fs.writeFileSync(path.join(dir, ".seed"), "changed\n");

    const diff = await readBranchDiff(dir);
    expect(diff.mergeBase).toBeNull();
    expect(diff.baseRef).toBeNull();
    expect(diff.diff).toContain("+changed");
  });
});
