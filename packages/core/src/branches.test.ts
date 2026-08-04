import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutBranch, listBranches } from "./branches";

const execFileP = promisify(execFile);

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway git repo on `main` with one committed seed file. */
async function tmpRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "branches-test-"));
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

const gitIn = (dir: string, args: string[]) => execFileP("git", args, { cwd: dir });

describe("listBranches", () => {
  it("lists current and branches with the default branch first", async () => {
    const dir = await tmpRepo();
    await gitIn(dir, ["checkout", "-q", "-b", "feature/x"]);

    const list = await listBranches(dir);
    expect(list.repoRoot).toBe(dir);
    expect(list.current).toBe("feature/x");
    expect(list.branches).toEqual(["main", "feature/x"]);
    expect(list.defaultBranch).toBe("main");
  });

  it("reports a non-repo directory as all-null, not an error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "branches-test-"));
    cleanups.push(dir);
    expect(await listBranches(dir)).toEqual({
      repoRoot: null,
      current: null,
      branches: [],
      defaultBranch: null,
    });
  });

  it("reports a detached HEAD as current: null", async () => {
    const dir = await tmpRepo();
    await gitIn(dir, ["checkout", "-q", "--detach"]);

    const list = await listBranches(dir);
    expect(list.current).toBeNull();
    expect(list.branches).toEqual(["main"]);
  });
});

describe("checkoutBranch", () => {
  it("switches to the named branch", async () => {
    const dir = await tmpRepo();
    await gitIn(dir, ["checkout", "-q", "-b", "feature/x"]);

    await checkoutBranch(dir, "main");
    expect((await listBranches(dir)).current).toBe("main");
  });

  it("creates and switches with { create: true }", async () => {
    const dir = await tmpRepo();

    await checkoutBranch(dir, "topic", { create: true });
    const list = await listBranches(dir);
    expect(list.current).toBe("topic");
    expect(list.branches).toContain("topic");
  });

  it("rejects with git's error when the switch would lose local changes", async () => {
    const dir = await tmpRepo();
    await gitIn(dir, ["checkout", "-q", "-b", "other"]);
    fs.writeFileSync(path.join(dir, ".seed"), "other\n");
    await gitIn(dir, ["commit", "-q", "-a", "-m", "other seed"]);
    await gitIn(dir, ["checkout", "-q", "main"]);
    // Uncommitted edit to a file the target branch carries differently: git
    // must refuse, and the message is what the branch menu will show.
    fs.writeFileSync(path.join(dir, ".seed"), "dirty\n");

    await expect(checkoutBranch(dir, "other")).rejects.toThrow(/overwritten by checkout/);
    expect((await listBranches(dir)).current).toBe("main");
  });
});
