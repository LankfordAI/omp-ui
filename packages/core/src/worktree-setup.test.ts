import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { addWorktree, removeWorktree } from "./worktree";
import {
  applyWorktreeFiles,
  parseWorktreeSetup,
  validateWorktreeSetup,
} from "./worktree-setup";

const execFileP = promisify(execFile);
const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-setup-test-"));
  cleanups.push(dir);
  return dir;
}

async function gitRepoWithIgnored(): Promise<string> {
  const dir = tmpDir();
  await execFileP("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n.env.*\ncache/\n");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "tracked\n");
  await execFileP("git", ["add", "."], { cwd: dir });
  await execFileP("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".env"), "APP=1\n");
  fs.writeFileSync(path.join(dir, ".env.local"), "LOCAL=2\n");
  fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cache", "data.bin"), "cached\n");
  return dir;
}

describe("validateWorktreeSetup & parseWorktreeSetup", () => {
  it("normalizes valid setups and returns null when completely empty", () => {
    expect(
      validateWorktreeSetup({
        copyPaths: [" .env ", "./.env.local", ".env"],
        copyMode: "copy",
        postCreateCommand: "  npm ci --prefer-offline  ",
      }),
    ).toEqual({
      copyPaths: [".env", ".env.local"],
      copyMode: "copy",
      postCreateCommand: "npm ci --prefer-offline",
    });

    expect(
      validateWorktreeSetup({ copyPaths: [], copyMode: "copy", postCreateCommand: "   " }),
    ).toBeNull();
    expect(validateWorktreeSetup(null)).toBeNull();
  });

  it.each(["../secret", "/etc/passwd", "C:\\Windows\\win.ini", ".git/config", ".omp/config.yml"])(
    "rejects unsafe path %s",
    (bad) => {
      expect(() =>
        validateWorktreeSetup({ copyPaths: [bad], copyMode: "copy", postCreateCommand: null }),
      ).toThrow(/unsafe worktree setup path/i);
      expect(parseWorktreeSetup({ copyPaths: [bad], copyMode: "copy", postCreateCommand: null })).toBeNull();
    },
  );
});

describe("applyWorktreeFiles", () => {
  it("copies allowlisted gitignored globs while never overwriting tracked files", async () => {
    const repo = await gitRepoWithIgnored();
    const wt = path.join(tmpDir(), "wt-copy");
    await addWorktree(repo, wt, "feat/copy", "main");

    const res = await applyWorktreeFiles(repo, wt, {
      copyPaths: [".env*", "tracked.txt"],
      copyMode: "copy",
      postCreateCommand: null,
    });
    expect(res.applied).toEqual([".env", ".env.local"]);
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("APP=1\n");
    expect(fs.readFileSync(path.join(wt, ".env.local"), "utf8")).toBe("LOCAL=2\n");
    expect(fs.lstatSync(path.join(wt, ".env")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8")).toBe("tracked\n");
  });

  it("symlinks allowlisted gitignored files and leaves source intact when removeWorktree runs", async () => {
    const repo = await gitRepoWithIgnored();
    const wt = path.join(tmpDir(), "wt-link");
    await addWorktree(repo, wt, "feat/link", "main");

    const res = await applyWorktreeFiles(repo, wt, {
      copyPaths: [".env", "cache"],
      copyMode: "symlink",
      postCreateCommand: null,
    });
    expect(res.applied).toContain(".env");
    expect(fs.lstatSync(path.join(wt, ".env")).isSymbolicLink()).toBe(true);

    await removeWorktree(repo, wt);
    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.readFileSync(path.join(repo, ".env"), "utf8")).toBe("APP=1\n");
    expect(fs.readFileSync(path.join(repo, "cache", "data.bin"), "utf8")).toBe("cached\n");
  });
});
