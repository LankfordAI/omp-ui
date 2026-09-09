import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkoutBranch,
  createBranch,
  createBranchService,
  listBranches,
  parseBranchStatus,
  pullBranch,
  pushBranch,
  readDefaultBranch,
  type GitRunner,
} from "./branches";
import { git, type GitOptions } from "./git";

const execFileP = promisify(execFile);

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "branches-test-"));
  cleanups.push(dir);
  return dir;
}

const gitIn = (dir: string, args: string[]) => execFileP("git", args, { cwd: dir });

async function configureIdentity(dir: string): Promise<void> {
  await gitIn(dir, ["config", "user.email", "test@example.com"]);
  await gitIn(dir, ["config", "user.name", "test"]);
}

/** A throwaway git repo on `main` with one committed seed file. */
async function tmpRepo(): Promise<string> {
  const dir = tmpDir();
  await gitIn(dir, ["init", "-q", "-b", "main"]);
  await configureIdentity(dir);
  fs.writeFileSync(path.join(dir, ".seed"), "seed\n");
  await gitIn(dir, ["add", "."]);
  await gitIn(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function revParse(dir: string, ref = "HEAD"): Promise<string> {
  return (await gitIn(dir, ["rev-parse", ref])).stdout.trim();
}

async function commitFile(
  dir: string,
  filename: string,
  content: string,
  message: string,
): Promise<string> {
  fs.writeFileSync(path.join(dir, filename), content);
  await gitIn(dir, ["add", filename]);
  await gitIn(dir, ["commit", "-q", "-m", message]);
  return revParse(dir);
}

interface RemoteFixture {
  local: string;
  publisher: string;
  bare: string;
}

/** A local `work` branch tracking `team/release` in a temporary bare repository. */
async function remoteFixture(): Promise<RemoteFixture> {
  const root = tmpDir();
  const bare = path.join(root, "team.git");
  const local = path.join(root, "local");
  const publisher = path.join(root, "publisher");
  fs.mkdirSync(local);

  await gitIn(root, ["init", "--bare", "-q", bare]);
  await gitIn(local, ["init", "-q", "-b", "work"]);
  await configureIdentity(local);
  fs.writeFileSync(path.join(local, ".seed"), "seed\n");
  await gitIn(local, ["add", ".seed"]);
  await gitIn(local, ["commit", "-q", "-m", "seed"]);
  await gitIn(local, ["remote", "add", "team", bare]);
  await gitIn(local, ["push", "-q", "-u", "team", "HEAD:release"]);
  await gitIn(bare, ["symbolic-ref", "HEAD", "refs/heads/release"]);

  await gitIn(root, ["clone", "-q", bare, publisher]);
  await configureIdentity(publisher);
  return { local, publisher, bare };
}

async function publishSeed(fixture: RemoteFixture, content: string): Promise<string> {
  const head = await commitFile(fixture.publisher, ".seed", content, "remote update");
  await gitIn(fixture.publisher, ["push", "-q", "origin", "release"]);
  return head;
}

/** The commit a repository's branch points at; null when the branch does not exist. */
async function headOf(dir: string, branch: string): Promise<string | null> {
  const out = (
    await gitIn(dir, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`])
  ).stdout.trim();
  return out === "" ? null : out;
}

/** An empty bare repository in `root`, wired into `dir` as remote `name`. */
async function addBareRemote(root: string, dir: string, name: string): Promise<string> {
  const url = path.join(root, `${name}.git`);
  await gitIn(root, ["init", "--bare", "-q", path.basename(url)]);
  await gitIn(dir, ["remote", "add", name, url]);
  return url;
}

/** A repo with no upstream config and one empty bare remote per name (issue #414's remote chain). */
async function multiRemoteRepo(
  names: string[],
): Promise<{ dir: string; bare: Record<string, string> }> {
  const dir = await tmpRepo();
  const root = tmpDir();
  const bare: Record<string, string> = {};
  for (const name of names) bare[name] = await addBareRemote(root, dir, name);
  return { dir, bare };
}

function statusOutput(ahead = 0, behind = 0): string {
  return [
    "# branch.oid 0123456789abcdef",
    "# branch.head main",
    "# branch.upstream team/main",
    `# branch.ab +${ahead} -${behind}`,
    "",
  ].join("\n");
}

interface RunnerCall {
  args: string[];
  options: GitOptions | undefined;
}

function trackedRunner(input: {
  statuses?: string[];
  fetch?: (call: number) => Promise<string>;
  pull?: (call: number) => Promise<string>;
  upstreamAvailable?: boolean;
} = {}): { runner: GitRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  let statusRead = 0;
  let fetchCall = 0;
  let pullCall = 0;
  const statuses = input.statuses ?? [statusOutput()];

  const runner: GitRunner = async (_cwd, args, options) => {
    calls.push({ args: [...args], options });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
    if (args[0] === "status") {
      const selected = statuses[Math.min(statusRead, statuses.length - 1)];
      statusRead += 1;
      return selected ?? statusOutput();
    }
    if (args[0] === "for-each-ref" && args[1] === "refs/heads") return "main\n";
    if (args[0] === "symbolic-ref") return "origin/main\n";
    if (args[0] === "for-each-ref") return "refs/heads/main\0team/main\0team\n";
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
    if (args[0] === "remote" && args[1] === "get-url") {
      if (args.at(-1) !== "origin") throw new Error("No such remote: origin");
      return "https://example.invalid/upstream/repo.git\n";
    }
    if (args[0] === "remote") return "team\norigin\n";
    if (args[0] === "fetch") {
      fetchCall += 1;
      return input.fetch === undefined ? "" : input.fetch(fetchCall);
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      if (input.upstreamAvailable === false) throw new Error("missing upstream");
      return "0123456789abcdef\n";
    }
    if (args[0] === "pull") {
      pullCall += 1;
      return input.pull === undefined ? "" : input.pull(pullCall);
    }
    throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
  };

  return { runner, calls };
}

/** The real git runner with every call recorded, so a test can assert on calls and git state alike. */
function recordingGit(): { runner: GitRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: GitRunner = async (cwd, args, options) => {
    calls.push({ args: [...args], options });
    return git(cwd, args, options);
  };
  return { runner, calls };
}

describe("parseBranchStatus", () => {
  it("parses a named head, arbitrary upstream, and ahead/behind counts", () => {
    expect(
      parseBranchStatus(
        [
          "# branch.oid 0123456789abcdef",
          "# branch.head work",
          "# branch.upstream team/release",
          "# branch.ab -7 +3",
          "1 .M N... 100644 100644 100644 abc abc tracked.txt",
          "",
        ].join("\n"),
      ),
    ).toEqual({ head: "work", upstream: "team/release", ahead: 3, behind: 7 });
  });

  it("normalizes detached heads and absent or malformed count headers", () => {
    expect(parseBranchStatus("# branch.head (detached)\n# branch.ab +nope -2\n")).toEqual({
      head: null,
      upstream: null,
      ahead: 0,
      behind: 2,
    });
    expect(parseBranchStatus("# branch.oid (initial)\n# branch.head main\n")).toEqual({
      head: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
    });
  });
});

describe("listBranches", () => {
  it("lists current and branches with the default branch first", async () => {
    const dir = await tmpRepo();
    await gitIn(dir, ["checkout", "-q", "-b", "feature/x"]);

    const list = await listBranches(dir);
    expect(list.repoRoot).toBe(fs.realpathSync.native(dir));
    expect(list.current).toBe("feature/x");
    expect(list.branches).toEqual(["main", "feature/x"]);
    expect(list.defaultBranch).toBe("main");
  });

  it("reports a non-repo directory as the complete empty state", async () => {
    expect(await listBranches(tmpDir())).toEqual({
      repoRoot: null,
      current: null,
      branches: [],
      defaultBranch: null,
      upstreamRef: null,
      upstreamRemote: null,
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      upstreamFetchedAt: null,
      upstreamRefreshError: null,
      defaultRemote: null,
    });
  });

  it("reports a detached HEAD without upstream state", async () => {
    const dir = await tmpRepo();
    await gitIn(dir, ["checkout", "-q", "--detach"]);

    const list = await listBranches(dir);
    expect(list.current).toBeNull();
    expect(list.branches).toEqual(["main"]);
    expect(list.upstreamRef).toBeNull();
    expect(list.hasUpstream).toBe(false);
    expect(list.ahead).toBe(0);
    expect(list.behind).toBe(0);
  });

  it("reports an unborn named branch with no commits or upstream", async () => {
    const dir = tmpDir();
    await gitIn(dir, ["init", "-q", "-b", "main"]);

    const list = await listBranches(dir);
    expect(list.repoRoot).toBe(fs.realpathSync.native(dir));
    expect(list.current).toBe("main");
    expect(list.branches).toEqual([]);
    expect(list.upstreamRef).toBeNull();
    expect(list.hasUpstream).toBe(false);
  });

  it("reports a branch with no configured upstream", async () => {
    const list = await listBranches(await tmpRepo());
    expect(list.upstreamRef).toBeNull();
    expect(list.upstreamRemote).toBeNull();
    expect(list.hasUpstream).toBe(false);
    expect([list.ahead, list.behind]).toEqual([0, 0]);
  });

  it("resolves defaultRemote as origin, else the sole remote, else null", async () => {
    const dir = await tmpRepo();
    const root = tmpDir();

    // Nothing configured: the push flow has no target to offer.
    expect((await listBranches(dir)).defaultRemote).toBeNull();

    await addBareRemote(root, dir, "team");
    expect((await listBranches(dir)).defaultRemote).toBe("team");

    // Two remotes: only the named default survives; the sole-remote rule is
    // a fallback for exactly one remote, not a scan for any remote.
    await addBareRemote(root, dir, "origin");
    expect((await listBranches(dir)).defaultRemote).toBe("origin");
  });

  it("keeps a configured short ref when its tracking ref is missing", async () => {
    const dir = await tmpRepo();
    await gitIn(dir, ["remote", "add", "team", path.join(dir, "missing.git")]);
    await gitIn(dir, ["config", "branch.main.remote", "team"]);
    await gitIn(dir, ["config", "branch.main.merge", "refs/heads/release"]);

    const list = await listBranches(dir);
    expect(list.upstreamRef).toBe("team/release");
    expect(list.upstreamRemote).toBe("team");
    expect(list.hasUpstream).toBe(false);
    expect([list.ahead, list.behind]).toEqual([0, 0]);
  });

  it("tracks team/release from local work and reports ahead, behind, then divergence", async () => {
    const fixture = await remoteFixture();
    const service = createBranchService();

    const even = await service.listBranches(fixture.local);
    expect(even.current).toBe("work");
    expect(even.upstreamRef).toBe("team/release");
    expect(even.upstreamRemote).toBe("team");
    expect(even.hasUpstream).toBe(true);
    expect([even.ahead, even.behind]).toEqual([0, 0]);

    await commitFile(fixture.local, "local.txt", "ahead\n", "local ahead");
    const ahead = await service.listBranches(fixture.local);
    expect([ahead.ahead, ahead.behind]).toEqual([1, 0]);

    await gitIn(fixture.local, ["reset", "--hard", "-q", "team/release"]);
    await publishSeed(fixture, "remote\n");
    await gitIn(fixture.local, ["fetch", "-q", "team"]);
    const behind = await service.listBranches(fixture.local);
    expect([behind.ahead, behind.behind]).toEqual([0, 1]);

    await commitFile(fixture.local, "local.txt", "diverged\n", "local divergence");
    const diverged = await service.listBranches(fixture.local);
    expect([diverged.ahead, diverged.behind]).toEqual([1, 1]);
  });

  it("preserves cached counts and exposes the error when a refresh fails", async () => {
    let now = 1_000;
    const fake = trackedRunner({
      statuses: [statusOutput(), statusOutput(2, 3), statusOutput(9, 9)],
      fetch: async (call) => {
        if (call === 2) throw new Error("network down");
        return "";
      },
    });
    const service = createBranchService(fake.runner, () => now);

    const populated = await service.listBranches("/repo", { fetchUpstream: true });
    expect([populated.ahead, populated.behind]).toEqual([2, 3]);
    expect(populated.upstreamFetchedAt).toBe(1_000);

    now = 17_000;
    const failed = await service.listBranches("/repo", { fetchUpstream: true });
    expect([failed.ahead, failed.behind]).toEqual([2, 3]);
    expect(failed.upstreamFetchedAt).toBe(1_000);
    expect(failed.upstreamRefreshError).toBe("network down");
    expect(fake.calls.filter((call) => call.args[0] === "fetch")).toHaveLength(2);
  });

  it("coalesces concurrent refreshes for the same repository and remote", async () => {
    let finishFetch: (() => void) | undefined;
    const pendingFetch = new Promise<string>((resolve) => {
      finishFetch = () => resolve("");
    });
    const fake = trackedRunner({ fetch: async () => pendingFetch });
    const service = createBranchService(fake.runner, () => 5_000);

    const first = service.listBranches("/repo/a", { fetchUpstream: true });
    const second = service.listBranches("/repo/b", { fetchUpstream: true });
    finishFetch?.();
    const results = await Promise.all([first, second]);

    expect(fake.calls.filter((call) => call.args[0] === "fetch")).toHaveLength(1);
    expect(results.map((result) => result.upstreamFetchedAt)).toEqual([5_000, 5_000]);
  });

  it("does not spawn another fetch during the failure cooldown", async () => {
    let now = 500;
    const fake = trackedRunner({
      statuses: [statusOutput(4, 1)],
      fetch: async () => {
        throw new Error("offline");
      },
    });
    const service = createBranchService(fake.runner, () => now);

    const failed = await service.listBranches("/repo", { fetchUpstream: true });
    now = 30_499;
    const coolingDown = await service.listBranches("/repo", { fetchUpstream: true });

    expect(fake.calls.filter((call) => call.args[0] === "fetch")).toHaveLength(1);
    expect(failed.upstreamRefreshError).toBe("offline");
    expect(coolingDown.upstreamRefreshError).toBe("offline");
    expect([coolingDown.ahead, coolingDown.behind]).toEqual([4, 1]);
  });

  it("passes bounded noninteractive options to fetch and pull", async () => {
    const fake = trackedRunner({ statuses: [statusOutput(0, 1)] });
    const service = createBranchService(fake.runner, () => 10_000);

    await service.listBranches("/repo", { fetchUpstream: true });
    await service.pullBranch("/repo");

    const fetchOptions = fake.calls.find((call) => call.args[0] === "fetch")?.options;
    const pullOptions = fake.calls.find((call) => call.args[0] === "pull")?.options;
    expect(fetchOptions?.timeoutMs).toBe(5_000);
    expect(pullOptions?.timeoutMs).toBe(30_000);
    for (const options of [fetchOptions, pullOptions]) {
      expect(options?.env).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        SSH_ASKPASS_REQUIRE: "never",
      });
    }
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
    fs.writeFileSync(path.join(dir, ".seed"), "dirty\n");

    await expect(checkoutBranch(dir, "other")).rejects.toThrow(/overwritten by checkout/);
    expect((await listBranches(dir)).current).toBe("main");
  });
});

describe("readDefaultBranch", () => {
  it("prefers origin/HEAD, falls back to main, then master, then null", async () => {
    const dir = await tmpRepo();
    // No remote: the local main is the answer.
    expect(await readDefaultBranch(dir)).toBe("main");
    await gitIn(dir, ["branch", "-m", "main", "master"]);
    expect(await readDefaultBranch(dir)).toBe("master");
    await gitIn(dir, ["branch", "-m", "master", "trunk"]);
    expect(await readDefaultBranch(dir)).toBeNull();
    // origin/HEAD wins over the fallbacks once it resolves. The symref is
    // created explicitly instead of being left to `fetch`: git only started
    // following the remote's HEAD during a plain fetch in 2.48
    // (remote.<name>.followRemoteHEAD), so relying on it pinned this test to
    // the git on the developer's machine (issue #397).
    const bare = tmpDir();
    await gitIn(bare, ["init", "-q", "--bare"]);
    await gitIn(dir, ["remote", "add", "origin", bare]);
    await gitIn(dir, ["push", "-q", "-u", "origin", "trunk"]);
    await gitIn(bare, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    await gitIn(dir, ["fetch", "-q", "origin"]);
    // Decoy local `main`: without it the assertion only proves that no
    // fallback matched, not that origin/HEAD outranks one that did.
    await gitIn(dir, ["branch", "main", "trunk"]);
    await gitIn(dir, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    ]);
    expect(await readDefaultBranch(dir)).toBe("trunk");
    // Upstream deletes trunk and a pruned fetch removes the tracking ref
    // (issue #399). The symref still READS — symbolic-ref exits 0 on a
    // dangling target — but must no longer count as resolving. Assert the
    // precondition so a git that starts validating can't pass vacuously.
    await gitIn(dir, ["update-ref", "-d", "refs/remotes/origin/trunk"]);
    const read = await gitIn(dir, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    expect(read.stdout.trim()).toBe("origin/trunk");
    expect(await readDefaultBranch(dir)).toBe("main");
  });
});

describe("createBranch", () => {
  it("creates a branch at a start point without checking it out", async () => {
    const dir = await tmpRepo();
    const second = await commitFile(dir, "next.txt", "n\n", "next");
    await gitIn(dir, ["checkout", "-q", "-b", "older", "HEAD~1"]);

    await createBranch(dir, "release/x", "main");

    // No checkout: the working tree did not move.
    expect((await listBranches(dir)).current).toBe("older");
    expect(await revParse(dir, "release/x")).toBe(second);
  });

  it("rejects with git's message on a name collision", async () => {
    const dir = await tmpRepo();
    await expect(createBranch(dir, "main", "main")).rejects.toThrow(/already exists/);
  });
});

describe("pullBranch", () => {
  it("fast-forwards a local branch to its configured upstream", async () => {
    const fixture = await remoteFixture();
    const before = await revParse(fixture.local);
    const remoteHead = await publishSeed(fixture, "fast-forwarded\n");

    await pullBranch(fixture.local);

    expect(await revParse(fixture.local)).toBe(remoteHead);
    expect(await revParse(fixture.local)).not.toBe(before);
    expect(fs.readFileSync(path.join(fixture.local, ".seed"), "utf8").replaceAll("\r\n", "\n")).toBe(
      "fast-forwarded\n",
    );
  });

  it("rejects a diverged branch without changing HEAD", async () => {
    const fixture = await remoteFixture();
    await publishSeed(fixture, "remote divergence\n");
    await gitIn(fixture.local, ["fetch", "-q", "team"]);
    await commitFile(fixture.local, "local.txt", "local divergence\n", "local divergence");
    const before = await revParse(fixture.local);

    await expect(pullBranch(fixture.local)).rejects.toThrow(
      "Cannot pull: branch has diverged; merge or rebase manually.",
    );
    expect(await revParse(fixture.local)).toBe(before);
  });

  it("leaves HEAD and dirty worktree content unchanged when Git refuses the pull", async () => {
    const fixture = await remoteFixture();
    await publishSeed(fixture, "remote dirty conflict\n");
    fs.writeFileSync(path.join(fixture.local, ".seed"), "local dirty content\n");
    const before = await revParse(fixture.local);

    await expect(pullBranch(fixture.local)).rejects.toThrow(/local changes.*overwritten by merge/is);
    expect(await revParse(fixture.local)).toBe(before);
    expect(fs.readFileSync(path.join(fixture.local, ".seed"), "utf8")).toBe(
      "local dirty content\n",
    );
  });
});

describe("pushBranch", () => {
  it("reports up-to-date without a network call when the upstream ref has everything", async () => {
    const fixture = await remoteFixture();
    const rec = recordingGit();
    const service = createBranchService(rec.runner);
    const remoteHead = await headOf(fixture.bare, "release");
    expect(remoteHead).toBe(await revParse(fixture.local));

    expect(await service.pushBranch(fixture.local, "work")).toEqual({
      kind: "up-to-date",
      remote: "team",
      upstreamRef: "team/release",
    });

    expect(rec.calls.filter((call) => call.args[0] === "push")).toEqual([]);
    expect(await headOf(fixture.bare, "release")).toBe(remoteHead);
  });

  it("fast-forwards the remote ref and counts the commits it sent", async () => {
    const fixture = await remoteFixture();
    const before = await headOf(fixture.bare, "release");
    await commitFile(fixture.local, "a.txt", "a\n", "first ahead");
    await commitFile(fixture.local, "b.txt", "b\n", "second ahead");

    expect(await pushBranch(fixture.local, "work")).toEqual({
      kind: "pushed",
      remote: "team",
      upstreamRef: "team/release",
      commits: 2,
    });

    const after = await headOf(fixture.bare, "release");
    expect(after).toBe(await revParse(fixture.local));
    expect(after).not.toBe(before);
  });

  it("pushes a renamed upstream as branch:merge and names the destination branch", async () => {
    // `work` tracks team/release: the local name and the destination differ,
    // so a push that guesses from the local name lands on the wrong ref.
    const fixture = await remoteFixture();
    const rec = recordingGit();
    const service = createBranchService(rec.runner);
    await commitFile(fixture.local, "local.txt", "ahead\n", "ahead");

    expect(await service.pushBranch(fixture.local, "work")).toEqual({
      kind: "pushed",
      remote: "team",
      upstreamRef: "team/release",
      commits: 1,
    });

    expect(rec.calls.filter((call) => call.args[0] === "push").map((call) => call.args)).toEqual([
      ["push", "team", "work:release"],
    ]);
    expect(await headOf(fixture.bare, "release")).toBe(await revParse(fixture.local));
    expect(await headOf(fixture.bare, "work")).toBeNull();
  });

  it("publishes a branch with no upstream and binds it to the sole remote", async () => {
    const fixture = await remoteFixture();
    await gitIn(fixture.local, ["checkout", "-q", "-b", "feature/new"]);
    const head = await revParse(fixture.local);

    // No `branch.feature/new.*` config and no argument: the sole remote wins.
    expect(await pushBranch(fixture.local, "feature/new")).toEqual({
      kind: "published",
      remote: "team",
      upstreamRef: "team/feature/new",
      commits: 1,
    });

    expect(await headOf(fixture.bare, "feature/new")).toBe(head);
    const remote = await gitIn(fixture.local, ["config", "--get", "branch.feature/new.remote"]);
    const merge = await gitIn(fixture.local, ["config", "--get", "branch.feature/new.merge"]);
    expect(remote.stdout.trim()).toBe("team");
    expect(merge.stdout.trim()).toBe("refs/heads/feature/new");
  });

  it("reports rejected with git's stderr when the remote moved first", async () => {
    // Two clones of one bare repo diverge: the publisher wins, and `work`'s
    // stale team/release must not let the push through.
    const fixture = await remoteFixture();
    await publishSeed(fixture, "remote moved\n");
    await commitFile(fixture.local, "local.txt", "local\n", "local ahead");
    const remoteHead = await headOf(fixture.bare, "release");

    expect(await pushBranch(fixture.local, "work")).toMatchObject({
      kind: "rejected",
      remote: "team",
      // `kind` already proves git's refusal was recognised; the refused ref
      // proves the detail is git's stderr verbatim, not a paraphrase.
      detail: expect.stringMatching(/work -> release/),
    });
    expect(await headOf(fixture.bare, "release")).toBe(remoteHead);
  });

  it("fails for a non-repo and for a branch that does not exist", async () => {
    expect(await pushBranch(tmpDir(), "main")).toEqual({
      kind: "failed",
      detail: "Cannot push: project is not inside a Git repository.",
    });

    const dir = await tmpRepo();
    expect(await pushBranch(dir, "never/existed")).toEqual({
      kind: "failed",
      detail: "Cannot push: branch never/existed does not exist.",
    });
  });

  it("lets the branch's configured remote outrank the caller's argument", async () => {
    const fixture = await remoteFixture();
    const other = await addBareRemote(path.dirname(fixture.bare), fixture.local, "other");
    await commitFile(fixture.local, "local.txt", "configured\n", "configured ahead");

    expect(await pushBranch(fixture.local, "work", "other")).toMatchObject({
      kind: "pushed",
      remote: "team",
    });
    expect(await headOf(fixture.bare, "release")).toBe(await revParse(fixture.local));
    expect(await headOf(other, "release")).toBeNull();
  });

  it("lets the caller's argument outrank origin for a branch with no upstream", async () => {
    const repo = await multiRemoteRepo(["origin", "up"]);

    expect(await pushBranch(repo.dir, "main", "up")).toMatchObject({
      kind: "published",
      remote: "up",
    });
    expect(await headOf(repo.bare.up, "main")).toBe(await revParse(repo.dir));
    expect(await headOf(repo.bare.origin, "main")).toBeNull();
  });

  it("prefers origin over any other remote when nothing else resolves", async () => {
    const repo = await multiRemoteRepo(["team", "origin"]);

    expect(await pushBranch(repo.dir, "main")).toMatchObject({
      kind: "published",
      remote: "origin",
    });
    expect(await headOf(repo.bare.origin, "main")).toBe(await revParse(repo.dir));
    expect(await headOf(repo.bare.team, "main")).toBeNull();
  });

  it("fails when the repository has no remote at all", async () => {
    const dir = await tmpRepo();
    expect(await pushBranch(dir, "main")).toEqual({
      kind: "failed",
      detail: "Cannot push: no remote configured.",
    });
  });

  it("gives the push alone the bounded noninteractive network options", async () => {
    const fixture = await remoteFixture();
    const rec = recordingGit();
    const service = createBranchService(rec.runner);
    await commitFile(fixture.local, "local.txt", "ahead\n", "ahead");

    expect((await service.pushBranch(fixture.local, "work")).kind).toBe("pushed");

    const push = rec.calls.find((call) => call.args[0] === "push");
    expect(push?.options?.timeoutMs).toBe(60_000);
    expect(push?.options?.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
    });
    // Local reads get no timeout: a slow `rev-list` is not a network failure.
    expect(
      rec.calls.filter((call) => call.options?.timeoutMs !== undefined).map((call) => call.args[0]),
    ).toEqual(["push"]);
  });

  it("keeps the next listing off the network", async () => {
    const fixture = await remoteFixture();
    const rec = recordingGit();
    let now = 1_000;
    const service = createBranchService(rec.runner, () => now);
    await commitFile(fixture.local, "local.txt", "ahead\n", "ahead");

    expect((await service.pushBranch(fixture.local, "work")).kind).toBe("pushed");

    now = 5_000;
    const listed = await service.listBranches(fixture.local, { fetchUpstream: true });
    expect([listed.ahead, listed.behind]).toEqual([0, 0]);
    expect(listed.upstreamFetchedAt).toBe(1_000);
    expect(rec.calls.filter((call) => call.args[0] === "fetch")).toEqual([]);
  });
});
