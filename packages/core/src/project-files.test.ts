import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { listProjectFiles, MAX_PROJECT_FILES } from "./project-files";

const execFileP = promisify(execFile);

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway git repo with one committed seed file and a HEAD to diff against. */
async function tmpRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-files-test-"));
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

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-files-test-"));
  cleanups.push(dir);
  return dir;
}

describe("listProjectFiles", () => {
  it("lists tracked and untracked-not-ignored files", async () => {
    const dir = await tmpRepo();
    fs.writeFileSync(path.join(dir, "app.ts"), "export const a = 1;\n");
    await execFileP("git", ["add", "."], { cwd: dir });
    await execFileP("git", ["commit", "-q", "-m", "add app"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "notes.md"), "# new\n");

    const { files, truncated } = await listProjectFiles(dir);
    expect(files).toEqual([".seed", "app.ts", "notes.md"]);
    expect(truncated).toBe(false);
  });

  it("excludes gitignored files", async () => {
    const dir = await tmpRepo();
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
    await execFileP("git", ["add", ".", "-A"], { cwd: dir });
    await execFileP("git", ["commit", "-q", "-m", "ignore"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "ignored.txt"), "shh\n");
    fs.writeFileSync(path.join(dir, "kept.txt"), "ok\n");

    const { files } = await listProjectFiles(dir);
    expect(files).toContain("kept.txt");
    expect(files).not.toContain("ignored.txt");
  });

  it("excludes a tracked file deleted from the working tree", async () => {
    const dir = await tmpRepo();
    fs.writeFileSync(path.join(dir, "gone.ts"), "export const g = 1;\n");
    await execFileP("git", ["add", "."], { cwd: dir });
    await execFileP("git", ["commit", "-q", "-m", "add gone"], { cwd: dir });
    fs.rmSync(path.join(dir, "gone.ts"));

    const { files } = await listProjectFiles(dir);
    expect(files).not.toContain("gone.ts");
  });

  it("scopes a repo subdirectory to projectCwd-relative paths", async () => {
    const dir = await tmpRepo();
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "top.ts"), "export const t = 1;\n");
    fs.writeFileSync(path.join(dir, "sub", "inner.ts"), "export const i = 1;\n");
    await execFileP("git", ["add", "."], { cwd: dir });
    await execFileP("git", ["commit", "-q", "-m", "add sub"], { cwd: dir });

    const { files } = await listProjectFiles(path.join(dir, "sub"));
    expect(files).toEqual(["inner.ts"]);
  });

  it("falls back to a walk outside repos and skips node_modules", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "x\n");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "b.ts"), "b\n");

    const { files, truncated } = await listProjectFiles(dir);
    expect(files).toEqual(["a.txt", "src/b.ts"]);
    expect(truncated).toBe(false);
  });

  it("caps the listing and reports truncation", async () => {
    const dir = tmpDir();
    for (let i = 0; i < MAX_PROJECT_FILES + 1; i++) {
      fs.writeFileSync(path.join(dir, `f${String(i).padStart(6, "0")}.txt`), "");
    }

    const { files, truncated } = await listProjectFiles(dir);
    expect(files).toHaveLength(MAX_PROJECT_FILES);
    expect(truncated).toBe(true);
  }, 30_000);
});
