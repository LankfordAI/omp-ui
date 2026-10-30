import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyDiscardedChange, DISCARDED_REF, listDiscardedChanges } from "./discarded-changes";
import { git } from "./git";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** A project repo with one committed file and two linked worktrees, the worktree-session shape. */
async function fixture(): Promise<{ project: string; wt: string; sibling: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discarded-test-"));
  cleanups.push(root);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  await git(project, ["init", "-q", "-b", "main"]);
  await git(project, ["config", "user.email", "test@example.com"]);
  await git(project, ["config", "user.name", "test"]);
  await git(project, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(project, "a.txt"), "one\n");
  fs.writeFileSync(path.join(project, "b.txt"), "x\n");
  await git(project, ["add", "."]);
  await git(project, ["commit", "-q", "-m", "init"]);
  const wt = path.join(root, "wt");
  const sibling = path.join(root, "sibling");
  await git(project, ["worktree", "add", "-q", "-b", "p/wt", wt]);
  await git(project, ["worktree", "add", "-q", "-b", "p/sibling", sibling]);
  return { project, wt, sibling };
}

/**
 * What omp 18.14's guard does before a discarding command in a linked
 * worktree, observed against the real binary: `git stash create`, then the
 * commit lands on refs/omp/discarded with the reflog message `before <cmd>`.
 */
async function guardedDiscard(cwd: string, command: string[]): Promise<string> {
  const commit = (await git(cwd, ["stash", "create"])).trim();
  await git(cwd, ["update-ref", "--create-reflog", "-m", `before git ${command.join(" ")}`, DISCARDED_REF, commit]);
  await git(cwd, command);
  return commit;
}

describe("listDiscardedChanges", () => {
  it("lists only the saves this checkout made, newest first, though every worktree shares the ref", async () => {
    const { wt, sibling } = await fixture();
    fs.appendFileSync(path.join(wt, "a.txt"), "mine\n");
    const first = await guardedDiscard(wt, ["reset", "--hard"]);
    fs.appendFileSync(path.join(sibling, "a.txt"), "theirs\n");
    const theirs = await guardedDiscard(sibling, ["checkout", "--", "a.txt"]);
    fs.appendFileSync(path.join(wt, "b.txt"), "mine too\n");
    const second = await guardedDiscard(wt, ["restore", "b.txt"]);

    const saves = await listDiscardedChanges(wt, "p/wt");
    expect(saves.map((save) => save.commit)).toEqual([second, first]);
    expect(saves[0]).toMatchObject({ command: "git restore b.txt", branch: "p/wt", files: ["b.txt"] });
    expect(saves[1]).toMatchObject({ command: "git reset --hard", branch: "p/wt", files: ["a.txt"] });
    expect((await listDiscardedChanges(sibling, "p/sibling")).map((save) => save.commit)).toEqual([theirs]);
  });

  it("keeps a save across a branch rename and lists nothing in a repo without saves", async () => {
    const { wt } = await fixture();
    expect(await listDiscardedChanges(wt, "p/wt")).toEqual([]);
    fs.appendFileSync(path.join(wt, "a.txt"), "mine\n");
    const commit = await guardedDiscard(wt, ["reset", "--hard"]);
    await git(wt, ["branch", "-m", "p/wt", "feat/renamed"]);
    expect((await listDiscardedChanges(wt, "feat/renamed")).map((save) => save.commit)).toEqual([commit]);
  });

  it("claims a detached save only for the checkout that sat detached, though siblings share the commit", async () => {
    const { wt, sibling } = await fixture();
    await git(sibling, ["checkout", "-q", "--detach"]);
    fs.appendFileSync(path.join(sibling, "a.txt"), "theirs\n");
    const theirs = await guardedDiscard(sibling, ["reset", "--hard"]);

    expect(await listDiscardedChanges(wt, "p/wt")).toEqual([]);
    expect(await listDiscardedChanges(sibling, "p/sibling")).toMatchObject([
      { commit: theirs, branch: "(no branch)" },
    ]);
  });
});

describe("applyDiscardedChange", () => {
  it("brings staged changes back staged and unstaged ones unstaged", async () => {
    const { wt } = await fixture();
    fs.appendFileSync(path.join(wt, "a.txt"), "unstaged\n");
    fs.appendFileSync(path.join(wt, "b.txt"), "staged\n");
    await git(wt, ["add", "b.txt"]);
    const commit = await guardedDiscard(wt, ["reset", "--hard"]);
    expect((await git(wt, ["status", "--porcelain"])).trim()).toBe("");

    expect(await applyDiscardedChange(wt, "p/wt", commit)).toEqual({ kind: "applied", indexRestored: true, files: [] });
    expect((await git(wt, ["status", "--porcelain"])).split("\n").filter(Boolean).sort()).toEqual([" M a.txt", "M  b.txt"]);
  });

  it("leaves conflicts in the worktree when the branch moved past the save", async () => {
    const { wt } = await fixture();
    fs.appendFileSync(path.join(wt, "a.txt"), "mine\n");
    const commit = await guardedDiscard(wt, ["reset", "--hard"]);
    fs.writeFileSync(path.join(wt, "a.txt"), "rewritten\n");
    await git(wt, ["commit", "-qam", "rewrite"]);

    expect(await applyDiscardedChange(wt, "p/wt", commit)).toEqual({ kind: "conflicts", indexRestored: false, files: ["a.txt"] });
    expect(fs.readFileSync(path.join(wt, "a.txt"), "utf8")).toContain("<<<<<<<");
  });

  it("refuses a save another worktree made and leaves the checkout untouched", async () => {
    const { wt, sibling } = await fixture();
    fs.appendFileSync(path.join(sibling, "a.txt"), "theirs\n");
    const theirs = await guardedDiscard(sibling, ["reset", "--hard"]);

    await expect(applyDiscardedChange(wt, "p/wt", theirs)).rejects.toThrow(/is not a save of this worktree/);
    expect((await git(wt, ["status", "--porcelain"])).trim()).toBe("");
  });
});
