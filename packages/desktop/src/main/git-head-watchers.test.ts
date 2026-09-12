import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchGitHead } from "@omp-ui/core";
import { HeadWatcherHub } from "./git-head-watchers";

const run = promisify(execFile);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function tmpRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-headwatch-"));
  dirs.push(dir);
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".seed"), "seed\n");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  await run("git", ["branch", "feature"], { cwd: dir });
  return dir;
}

function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("HeadWatcherHub", () => {
  it("starts one watcher per path; a second start reuses it and stop releases it", async () => {
    const dispose = vi.fn();
    const watch = vi.fn(async () => dispose);
    const hub = new HeadWatcherHub({ onChanged: () => {}, watch: watch as typeof watchGitHead });

    await hub.start("/p/a");
    await hub.start("/p/a");
    expect(watch).toHaveBeenCalledTimes(1);

    hub.stop("/p/a");
    expect(dispose).toHaveBeenCalledTimes(1);
    await hub.start("/p/a");
    expect(watch).toHaveBeenCalledTimes(2);

    await hub.disposeAll();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("a rejecting watch (not a repo) leaves no entry and retries nothing", async () => {
    const watch = vi.fn().mockRejectedValue(new Error("not a git repository"));
    const onChanged = vi.fn();
    const hub = new HeadWatcherHub({ onChanged, watch: watch as typeof watchGitHead });

    await hub.start("/p/plain");
    expect(onChanged).not.toHaveBeenCalled();

    await hub.start("/p/plain");
    expect(watch).toHaveBeenCalledTimes(2); // still unwatchable; still silent
    await hub.disposeAll();
  });

  it("churn calls onChanged with the project path; onGone drops the map entry", async () => {
    const watch = vi.fn(
      async (_cwd: string, _onEvent: () => void, opts: { onGone?: () => void }) => {
        // Simulate the gitdir vanishing under the hub.
        setImmediate(() => opts.onGone?.());
        return () => {};
      },
    );
    const onChanged = vi.fn();
    const hub = new HeadWatcherHub({
      onChanged,
      watch: watch as unknown as typeof watchGitHead,
    });

    await hub.start("/p/a");
    const onEvent = watch.mock.calls[0]![1] as () => void;
    onEvent();
    expect(onChanged).toHaveBeenCalledWith("/p/a");

    // onGone (fired asynchronously by the stub) dropped the entry: a later
    // start re-probes instead of finding a live watcher.
    await new Promise((resolve) => setImmediate(resolve));
    await hub.start("/p/a");
    expect(watch).toHaveBeenCalledTimes(2);
    await hub.disposeAll();
  });

  it("stop during an in-flight probe disposes the late watcher", async () => {
    const gate = withResolvers<void>();
    const { promise, resolve } = withResolvers<() => void>();
    const dispose = vi.fn();
    const watch = vi.fn(() => {
      void gate.promise.then(() => resolve(dispose));
      return promise;
    });
    const hub = new HeadWatcherHub({ onChanged: () => {}, watch: watch as typeof watchGitHead });

    const started = hub.start("/p/a");
    hub.stop("/p/a");
    gate.resolve();
    await started;
    expect(dispose).toHaveBeenCalledTimes(1);
    await hub.disposeAll();
  });

  // The reason disposeAll answers with a promise (#503): a teardown that deletes the probe's
  // directory must not run while git.exe still holds it as its cwd.
  it("disposeAll settles only after an in-flight probe has finished", async () => {
    const gate = withResolvers<void>();
    const { promise, resolve } = withResolvers<() => void>();
    const dispose = vi.fn();
    const watch = vi.fn(() => {
      void gate.promise.then(() => resolve(dispose));
      return promise;
    });
    const hub = new HeadWatcherHub({ onChanged: () => {}, watch: watch as typeof watchGitHead });

    const started = hub.start("/p/a");
    let settled = false;
    const settling = hub.disposeAll().then(() => {
      settled = true;
    });
    const idle = withResolvers<void>();
    setImmediate(idle.resolve);
    await idle.promise;
    expect(settled).toBe(false);

    gate.resolve();
    await settling;
    expect(settled).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1); // the late watcher was released, not leaked
    await started;
  });

  // Integration smoke (the #498 terminal path): a real repo driven through the
  // real watcher answers onChanged when git moves HEAD, awaited on the event
  // itself — no sleeps.
  it("a terminal-style git checkout reaches onChanged (real inotify)", async () => {
    const dir = await tmpRepo();
    const changed = withResolvers<string>();
    const hub = new HeadWatcherHub({ onChanged: (cwd) => changed.resolve(cwd) });

    await hub.start(dir);
    await run("git", ["checkout", "-q", "feature"], { cwd: dir });

    expect(await changed.promise).toBe(dir);
    await hub.disposeAll();
  });
});
