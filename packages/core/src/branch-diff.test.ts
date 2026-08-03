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

describe("readBranchDiff", () => {
  it("reads the branch, tracked changes vs HEAD, and untracked files", async () => {
    const dir = await tmpRepo();
    fs.writeFileSync(path.join(dir, "app.ts"), "export const a = 1;\n");
    await execFileP("git", ["add", ".", "-A"], { cwd: dir });
    await execFileP("git", ["commit", "-q", "-m", "add app"], { cwd: dir });

    fs.writeFileSync(path.join(dir, "app.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(dir, "notes.md"), "# new\n");

    const diff = await readBranchDiff(dir);
    expect(diff.repoRoot).toBe(dir);
    expect(diff.branch).toBe("main");
    expect(diff.diff).toContain("diff --git a/app.ts b/app.ts");
    expect(diff.diff).toContain("-export const a = 1;");
    expect(diff.diff).toContain("+export const a = 2;");
    expect(diff.untracked).toEqual([{ path: "notes.md", text: "# new\n", binary: false }]);
  });

  it("reports non-repo projects as null fields, not an error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "branch-diff-test-"));
    cleanups.push(dir);
    expect(await readBranchDiff(dir)).toEqual({
      branch: null,
      repoRoot: null,
      diff: "",
      untracked: [],
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
});
