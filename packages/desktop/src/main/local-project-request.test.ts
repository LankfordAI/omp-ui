import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetToolProjectArgs, OwnedSessionRecord, ProjectRecord, ProjectRequestPrompt } from "@omp-ui/core";
import { LOCAL_CLONE_INACTIVITY_MS, LOCAL_CLONE_TIMEOUT_MS } from "@omp-ui/core";
import type { HostCallControl } from "./host-bridge";
import { LocalProjectRequests, execLocalGit, type LocalGitRunner, type LocalProjectRequestDeps } from "./local-project-request";
import type { ProjectRequestOutcome } from "./project-request-gate";
import { ownedSessionRecord } from "./test/fixtures";

const TAB = "tab-1";
let base: string;
let home: string;
let userData: string;
let repos: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lpr-")));
  home = path.join(base, "home");
  userData = path.join(home, ".config", "omp-ui");
  repos = path.join(home, "repos");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(repos, { recursive: true });
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function checkout(dir: string): string {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

const control = () => ({
  signal: new AbortController().signal,
  suspendWatchdog: vi.fn<() => void>(),
  rearmWatchdog: vi.fn<(ms: number) => void>(),
}) satisfies HostCallControl;

function harness(over: {
  record?: Partial<OwnedSessionRecord>;
  projects?: ProjectRecord[];
  eligibility?: string | null;
  answer?: (prompt: ProjectRequestPrompt) => ProjectRequestOutcome | Promise<ProjectRequestOutcome>;
  git?: LocalGitRunner;
} = {}) {
  const projects: ProjectRecord[] = over.projects ?? [];
  const asked: ProjectRequestPrompt[] = [];
  const added: string[] = [];
  const progress: Array<[string, string | null]> = [];
  const git = vi.fn<LocalGitRunner>(over.git ?? (async () => ""));
  const deps: LocalProjectRequestDeps = {
    eligibility: () => over.eligibility ?? null,
    record: () => ownedSessionRecord({ tabId: TAB, projectCwd: path.join(repos, "here"), ...over.record }),
    projects: () => projects,
    protectedRoots: () => [userData, path.join(home, ".omp", "agent")],
    homedir: () => home,
    ask: async (_tabId, prompt) => {
      asked.push(prompt);
      return over.answer ? over.answer(prompt) : { kind: "allow", parent: null };
    },
    addProject: async (dir) => {
      added.push(dir);
    },
    reportCloneProgress: (tabId, line) => {
      progress.push([tabId, line]);
    },
    git,
  };
  return { requests: new LocalProjectRequests(deps), asked, added, progress, git };
}

const register = (p: string): FleetToolProjectArgs => ({ machine: "this computer", verb: "register", repositoryUrl: null, path: p });
const clone = (url: string): FleetToolProjectArgs => ({ machine: "this computer", verb: "clone", repositoryUrl: url, path: null });

describe("LocalProjectRequests (#1228)", () => {
  it("returns an already-registered path with no card", async () => {
    const dir = checkout(path.join(repos, "app"));
    const h = harness({ projects: [{ path: dir } as ProjectRecord] });
    expect(await h.requests.request(TAB, register(dir), control())).toMatchObject({ status: "accepted", path: dir });
    expect(h.asked).toEqual([]);
    expect(h.added).toEqual([]);
  });

  it("registers after Allow, with the executable config the card lists", async () => {
    const dir = checkout(path.join(repos, "app"));
    fs.mkdirSync(path.join(dir, ".omp", "extensions"), { recursive: true });
    const c = control();
    const h = harness();
    expect(await h.requests.request(TAB, register(dir), c)).toMatchObject({ status: "accepted", path: dir });
    expect(h.asked[0]).toMatchObject({ verb: "register", source: dir, executableConfig: [".omp/extensions"] });
    expect(c.suspendWatchdog).toHaveBeenCalled();
    expect(c.rearmWatchdog).toHaveBeenCalledWith(60_000);
    expect(h.added).toEqual([dir]);
  });

  it.each([
    ["the home folder", () => home],
    ["omp-ui's data folder", () => userData],
    ["a folder inside a registered project", () => checkout(path.join(repos, "mono", "pkg"))],
    ["a folder without .git", () => {
      const dir = path.join(repos, "plain");
      fs.mkdirSync(dir);
      return dir;
    }],
  ])("refuses %s without a card", async (_label, target) => {
    const dir = target();
    if (dir === home || dir === userData) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    const h = harness({ projects: [{ path: path.join(repos, "mono") } as ProjectRecord] });
    expect(await h.requests.request(TAB, register(dir), control())).toMatchObject({ status: "refused" });
    expect(h.asked).toEqual([]);
    expect(h.added).toEqual([]);
  });

  it.each([
    ["private", "private sessions do not add projects"],
    ["Plan mode", "Plan mode: describe the project in your plan instead"],
    ["setting off", "this session cannot add projects"],
  ])("refuses an ineligible session (%s)", async (_label, reason) => {
    const dir = checkout(path.join(repos, "app"));
    const h = harness({ eligibility: reason });
    expect(await h.requests.request(TAB, register(dir), control())).toEqual({ status: "refused", reason });
    expect(h.asked).toEqual([]);
  });

  it("deny and cancel add nothing", async () => {
    const dir = checkout(path.join(repos, "app"));
    const denied = harness({ answer: () => ({ kind: "deny" }) });
    expect(await denied.requests.request(TAB, register(dir), control())).toEqual({ status: "refused", reason: "the user declined" });
    const cancelled = harness({ answer: () => "cancelled" });
    expect(await cancelled.requests.request(TAB, register(dir), control())).toEqual({ status: "refused", reason: "the request was cancelled" });
    expect([...denied.added, ...cancelled.added]).toEqual([]);
  });

  it("clones into the picked parent and registers the clone", async () => {
    const parent = path.join(base, "elsewhere");
    fs.mkdirSync(parent);
    const h = harness({
      answer: () => ({ kind: "allow", parent }),
      git: async (args) => {
        if (args[0] === "clone") checkout(args[4]!);
        return "";
      },
    });
    const c = control();
    expect(await h.requests.request(TAB, clone("https://github.com/acme/app.git"), c)).toMatchObject({
      status: "accepted",
      path: path.join(parent, "app"),
    });
    expect(h.asked[0]).toMatchObject({ verb: "clone", name: "app", defaultParent: repos });
    expect(h.git.mock.calls[0]![0]).toEqual([
      "clone",
      "--filter=blob:none",
      "--progress",
      "--",
      "https://github.com/acme/app.git",
      path.join(parent, "app"),
    ]);
    expect(h.git.mock.calls[0]![1]).toMatchObject({
      timeout: LOCAL_CLONE_TIMEOUT_MS,
      inactivityMs: LOCAL_CLONE_INACTIVITY_MS,
      env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }),
    });
    expect(c.rearmWatchdog).toHaveBeenCalledWith(LOCAL_CLONE_TIMEOUT_MS + 15_000);
    expect(h.added).toEqual([path.join(parent, "app")]);
  });

  it("a chat proposes the home folder as the clone parent", async () => {
    const h = harness({ record: { chat: true }, answer: () => ({ kind: "deny" }) });
    await h.requests.request(TAB, clone("git@github.com:acme/app.git"), control());
    expect(h.asked[0]).toMatchObject({ defaultParent: home });
  });

  it("refuses a destination created while the card was open, without calling git", async () => {
    const h = harness({
      answer: () => {
        fs.mkdirSync(path.join(repos, "app"));
        return { kind: "allow", parent: null };
      },
    });
    expect(await h.requests.request(TAB, clone("https://github.com/acme/app"), control())).toEqual({
      status: "refused",
      reason: `${path.join(repos, "app")} already exists`,
    });
    expect(h.git).not.toHaveBeenCalled();
    expect(h.added).toEqual([]);
  });

  it("keeps the partial destination and reports full stderr with a resume hint when .git exists", async () => {
    const dest = path.join(repos, "app");
    const h = harness({
      git: async () => {
        checkout(dest);
        fs.mkdirSync(path.join(dest, "partial"), { recursive: true });
        throw new Error("fatal: transport failed\nerror: RPC failed");
      },
    });
    expect(await h.requests.request(TAB, clone("https://github.com/acme/app"), control())).toEqual({
      status: "refused",
      reason:
        "git clone failed: fatal: transport failed\nerror: RPC failed — the partial checkout was kept at " +
        `${dest}; retrying the same clone will resume it`,
    });
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(true);
    expect(h.added).toEqual([]);
  });

  it("removes the destination when git fails without writing .git", async () => {
    const dest = path.join(repos, "app");
    const h = harness({
      git: async () => {
        fs.mkdirSync(path.join(dest, "partial"), { recursive: true });
        throw new Error("fatal: repository not found\nmore");
      },
    });
    expect(await h.requests.request(TAB, clone("https://github.com/acme/app"), control())).toEqual({
      status: "refused",
      reason: "git clone failed: fatal: repository not found\nmore",
    });
    expect(fs.existsSync(dest)).toBe(false);
    expect(h.added).toEqual([]);
  });

  it("resumes a kept partial clone when the origin matches and completes the checkout", async () => {
    const dest = checkout(path.join(repos, "app"));
    const h = harness({
      git: async (args) => {
        if (args[0] === "-C" && args[2] === "remote") return "https://github.com/acme/app";
        if (args[0] === "-C" && args[2] === "symbolic-ref") return "origin/main";
        if (args[0] === "-C" && args[2] === "fetch") h.git.mock.calls[1]![1].onStderr?.("Receiving objects:  99%\rReceiving objects: 100%\r\n");
        return "";
      },
    });
    const c = control();
    expect(await h.requests.request(TAB, clone("https://github.com/acme/app"), c)).toMatchObject({
      status: "accepted",
      path: dest,
    });
    const calls = h.git.mock.calls.map(([argv]) => argv);
    expect(calls).toEqual([
      ["-C", dest, "remote", "get-url", "origin"],
      ["-C", dest, "fetch", "--progress", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      ["-C", dest, "remote", "set-head", "origin", "--auto"],
      ["-C", dest, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      ["-C", dest, "checkout", "-f", "-B", "main", "origin/main"],
      ["rev-parse", "HEAD"],
    ]);
    const fetchOpts = h.git.mock.calls[1]![1]!;
    expect(fetchOpts.inactivityMs).toBe(LOCAL_CLONE_INACTIVITY_MS);
    expect(fetchOpts.onStderr).toBeDefined();
    expect(h.progress).toContainEqual([TAB, "Receiving objects: 100%"]);
    expect(h.progress.at(-1)).toEqual([TAB, null]);
    expect(h.added).toEqual([dest]);
  });

  it("refuses already exists for a foreign directory with .git and never fetches", async () => {
    const dest = checkout(path.join(repos, "app"));
    const h = harness({
      git: async (args) => (args[0] === "-C" && args[2] === "remote" ? "https://gitlab.com/other/repo.git" : ""),
    });
    expect(await h.requests.request(TAB, clone("https://github.com/acme/app"), control())).toEqual({
      status: "refused",
      reason: `${dest} already exists`,
    });
    expect(h.git.mock.calls.map(([argv]) => argv)).toEqual([["-C", dest, "remote", "get-url", "origin"]]);
    expect(h.added).toEqual([]);
  });

  it("streams clone progress through reportCloneProgress and clears it at the end", async () => {
    const parent = path.join(base, "elsewhere");
    fs.mkdirSync(parent);
    const h = harness({
      answer: () => ({ kind: "allow", parent }),
      git: async (args, opts) => {
        if (args[0] === "clone") {
          checkout(args[4]!);
          opts.onStderr?.("\x1b[2KReceiving objects:  40% (12/30)\rReceiving objects: 100%\r\n");
        }
        return "";
      },
    });
    expect(await h.requests.request(TAB, clone("https://github.com/acme/app"), control())).toMatchObject({ status: "accepted" });
    expect(h.progress).toContainEqual([TAB, "Receiving objects: 100%"]);
    expect(h.progress.at(-1)).toEqual([TAB, null]);
  });

  it("refuses an unsupported clone source without a card", async () => {
    const h = harness();
    expect(await h.requests.request(TAB, clone("file:///srv/app"), control())).toMatchObject({ status: "refused" });
    expect(h.asked).toEqual([]);
  });
});

describe("execLocalGit runner (#1395)", () => {
  let base: string;
  let bin: string;
  let stderrCalls: string[];
  const stubGit = (body: string): void => {
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(bin, "git"), 0o755);
  };

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-gitrunner-")));
    bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    stderrCalls = [];
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  const run = (args: string[], over: Partial<Parameters<LocalGitRunner>[1]> = {}) =>
    execLocalGit(args, { cwd: base, timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, ...over });

  it("kills the child after stderr silence and reports the inactivity message", async () => {
    stubGit('echo "counting" >&2; exec sleep 30');
    const onStderr = (chunk: string) => stderrCalls.push(chunk);
    await expect(run(["x"], { inactivityMs: 200, onStderr })).rejects.toThrow(
      "git produced no stderr output for 0s — killed (stalled transport, not a slow clone)",
    );
    expect(stderrCalls).toEqual(["counting\n"]);
  }, 10_000);

  it("kills the child at the wall cap even with steady output", async () => {
    stubGit('while true; do echo "tick" >&2; sleep 0.05; done');
    await expect(run(["x"], { timeout: 300 })).rejects.toThrow("git did not finish within 1m — killed");
  }, 10_000);

  it("kills the child when the signal aborts", async () => {
    stubGit('echo "started" >&2; exec sleep 30');
    const abort = new AbortController();
    const onStderr = (chunk: string) => stderrCalls.push(chunk);
    const pending = run(["x"], { signal: abort.signal, onStderr });
    await vi.waitFor(() => expect(stderrCalls).toEqual(["started\n"]));
    abort.abort();
    await expect(pending).rejects.toThrow("git was cancelled");
  }, 10_000);

  it("resolves stdout and rejects with git's stderr on failure", async () => {
    stubGit('echo out; echo "bad" >&2; exit 1');
    await expect(run(["x"])).rejects.toThrow("bad");
    stubGit("echo out");
    await expect(run(["x"])).resolves.toBe("out\n");
  }, 10_000);
});
