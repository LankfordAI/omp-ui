import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git";
import { addWorktree, isWithin, mintWorktreeBranch, mintWorktreePath, removeWorktree } from "./worktree";

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
  fs.writeFileSync(path.join(dir, ".seed"), "seed\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
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
});
