import * as fs from "node:fs";
import { execFile } from "node:child_process";
import * as os from "node:os";
import { promisify } from "node:util";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { watchGitHead, watchLineageDir, type LineageEvent } from "./watcher";

// node:fs exports are non-configurable (no spyOn), so the module mock wraps
// fs.watch in a vi.fn; everything else stays real.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  (globalThis as Record<string, unknown>).__ompUiRealFsWatch = real.watch;
  return { ...real, watch: vi.fn(real.watch) };
});

const realWatch = (globalThis as Record<string, unknown>).__ompUiRealFsWatch as typeof fs.watch;
const watchMock = vi.mocked(fs.watch);

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-watcher-"));
});

afterEach(() => {
  watchMock.mockImplementation(realWatch);
  vi.useRealTimers();
  fs.rmSync(base, { recursive: true, force: true });
});

/** Swaps fs.watch for a fake handle and captures the listener, so events fire deterministically. */
function stubWatch(): { fire: (filename: string | null) => void; fireError: () => void; close: Mock } {
  let listener: fs.WatchListener<string> | undefined;
  let onError: (() => void) | undefined;
  const close = vi.fn();
  watchMock.mockImplementation(((...args: unknown[]) => {
    listener = args[args.length - 1] as fs.WatchListener<string>;
    return {
      close,
      on: (_event: string, cb: () => void) => {
        onError = cb;
      },
    } as unknown as fs.FSWatcher;
  }) as typeof fs.watch);
  return {
    fire: (filename) => listener!("rename", filename),
    fireError: () => onError!(),
    close,
  };
}

describe("watchLineageDir", () => {
  // Promise.withResolvers is es2024; core's tsconfig lib predates it.
  function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("emits session-file for debounced .jsonl activity only", () => {
    vi.useFakeTimers();
    const w = stubWatch();
    const events: LineageEvent[] = [];
    const dispose = watchLineageDir(base, (e) => events.push(e));

    w.fire("s1.jsonl");
    w.fire("ignored.bak");
    w.fire("s2.jsonl");
    vi.advanceTimersByTime(100);

    expect(events).toEqual([
      { kind: "session-file", filePath: path.join(base, "s1.jsonl") },
      { kind: "session-file", filePath: path.join(base, "s2.jsonl") },
    ]);
    dispose();
  });

  it("dispose closes the handle and clears the debounce timer", () => {
    vi.useFakeTimers();
    const w = stubWatch();
    const events: LineageEvent[] = [];
    const dispose = watchLineageDir(base, (e) => events.push(e));

    w.fire("s1.jsonl"); // arms the 100 ms debounce
    dispose();

    expect(w.close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("vanished closes the FSWatcher itself, and dispose stays idempotent (issue #64)", () => {
    const w = stubWatch();
    const events: LineageEvent[] = [];
    const dispose = watchLineageDir(base, (e) => events.push(e));

    w.fireError();

    expect(events).toEqual([{ kind: "vanished" }]);
    expect(w.close).toHaveBeenCalledTimes(1);
    // The backend drops the map entry on vanished and may dispose later — no double close.
    dispose();
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it("a deleted dir fires vanished and the real FSWatcher reaches close (issue #64)", async () => {
    // Real inotify: fs.watch delivery cannot be driven by fake timers, so this
    // awaits the platform event itself (the watcher's real 100 ms debounce
    // included) rather than a guessed delay.
    fs.writeFileSync(path.join(base, "keep.jsonl"), "{}\n");
    let realWatcher: fs.FSWatcher | undefined;
    watchMock.mockImplementation(((...args: unknown[]) => {
      realWatcher = Reflect.apply(realWatch, fs, args) as fs.FSWatcher;
      return realWatcher;
    }) as typeof fs.watch);
    const vanished = withResolvers<LineageEvent>();
    const dispose = watchLineageDir(base, vanished.resolve);
    const closed = withResolvers<void>();
    realWatcher!.once("close", closed.resolve);

    fs.rmSync(base, { recursive: true });

    expect((await vanished.promise).kind).toBe("vanished");
    // Regression: without vanish closing the handle, this never resolves.
    await closed.promise;
    dispose();
  });

  it("watching a missing dir reports vanished asynchronously — unless disposed first", async () => {
    let silenced = 0;
    const disposeA = watchLineageDir(path.join(base, "gone-a"), () => silenced++);
    disposeA();

    const heard = withResolvers<LineageEvent>();
    const disposeB = watchLineageDir(path.join(base, "gone-b"), heard.resolve);

    // Two loop turns guarantee the silenced watcher's setImmediate has run.
    const turns = withResolvers<void>();
    setImmediate(() => setImmediate(turns.resolve));
    await turns.promise;
    expect(silenced).toBe(0);

    expect((await heard.promise).kind).toBe("vanished");
    disposeB();
  });
});

describe("watchGitHead", () => {
  function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  /** A git-runner seam answering `rev-parse --git-path HEAD` with `headPath`. */
  function gitPathSeam(headPath: string): (cwd: string, args: string[]) => Promise<string> {
    return async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-path") return `${headPath}\n`;
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
  }

  beforeEach(() => {
    // The file's earlier watchLineageDir tests leave calls on the shared
    // fs.watch mock; the assertions below read call[0], so start each test
    // clean — and re-install the real implementation, since a stale stub
    // delegation would break watchGitHead's probe-order assertions.
    watchMock.mockClear();
    watchMock.mockImplementation(realWatch);
  });

  it("watches the directory of the resolved HEAD path", async () => {
    const gitDir = path.join(base, ".git");
    fs.mkdirSync(gitDir);
    const w = stubWatch();

    const dispose = await watchGitHead(base, () => {}, { runGit: gitPathSeam(".git/HEAD") });

    const watched = watchMock.mock.calls[0]![0];
    expect(watched).toBe(gitDir);
    dispose();
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it("debounces churn into one trailing event and dispose stops the timer", async () => {
    vi.useFakeTimers();
    fs.mkdirSync(path.join(base, ".git"));
    const w = stubWatch();
    const events: number[] = [];

    const dispose = await watchGitHead(base, () => events.push(1), { runGit: gitPathSeam(".git/HEAD") });

    w.fire("HEAD");
    w.fire("ORIG_HEAD");
    w.fire("HEAD");
    expect(events).toEqual([]);
    vi.advanceTimersByTime(149);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([1]);

    // A second burst arms a fresh timer; dispose cancels it un-fired.
    w.fire("HEAD");
    dispose();
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores index bookkeeping churn and never pre-arms the debounce with it", async () => {
    // listBranches' `git status` rewrites index/index.lock on a dirty tree;
    // that echo must not fire (issue #506's loop), and must not start the
    // trailing timer early so a later real event fires before its debounce.
    vi.useFakeTimers();
    fs.mkdirSync(path.join(base, ".git"));
    const w = stubWatch();
    const events: number[] = [];

    const dispose = await watchGitHead(base, () => events.push(1), { runGit: gitPathSeam(".git/HEAD") });

    w.fire("index.lock");
    w.fire("index");
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([]);

    // A burst of index noise then HEAD fires exactly one event, timed from HEAD:
    // had the index.lock fire armed the timer, the flush would land mid-burst.
    w.fire("index.lock");
    vi.advanceTimersByTime(140);
    w.fire("HEAD");
    vi.advanceTimersByTime(149);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([1]);
    dispose();
  });

  it("rejects for a path that is not a repository", async () => {
    await expect(watchGitHead(base, () => {})).rejects.toThrow();
    expect(watchMock).not.toHaveBeenCalled();
  });

  it("a gitdir vanished between probe and watch resolves a no-op dispose", async () => {
    // dir does not exist — real fs.watch throws ENOENT
    const events: number[] = [];
    const gone = vi.fn();

    const dispose = await watchGitHead(base, () => events.push(1), { runGit: gitPathSeam(".git/HEAD"),  onGone: gone });

    dispose();
    expect(events).toEqual([]);
    expect(gone).not.toHaveBeenCalled();
  });

  it("a watcher error closes the handle and reports gone once; dispose stays idempotent", async () => {
    fs.mkdirSync(path.join(base, ".git"));
    const w = stubWatch();
    const gone = vi.fn();

    const dispose = await watchGitHead(base, () => {}, { runGit: gitPathSeam(".git/HEAD"),  onGone: gone });
    w.fireError();

    expect(gone).toHaveBeenCalledTimes(1);
    expect(w.close).toHaveBeenCalledTimes(1);
    dispose();
    expect(gone).toHaveBeenCalledTimes(1);
    expect(w.close).toHaveBeenCalledTimes(1);
  });
  it("real gitdir churn fires exactly one event (terminal-style checkout)", async () => {
    // Real git, real inotify: no sleeps — the wait is on the event itself.
    const run = promisify(execFile);
    await run("git", ["init", "-q", "-b", "main"], { cwd: base });
    await run("git", ["config", "user.email", "t@example.com"], { cwd: base });
    await run("git", ["config", "user.name", "t"], { cwd: base });
    fs.writeFileSync(path.join(base, ".seed"), "seed\n");
    await run("git", ["add", "."], { cwd: base });
    await run("git", ["commit", "-q", "-m", "init"], { cwd: base });
    await run("git", ["branch", "feature"], { cwd: base });

    const fired = withResolvers<void>();
    const dispose = await watchGitHead(base, () => fired.resolve());

    await run("git", ["checkout", "-q", "feature"], { cwd: base });
    await fired.promise;
    dispose();
  });
});
