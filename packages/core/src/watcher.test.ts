import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { watchLineageDir, type LineageEvent } from "./watcher";

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
