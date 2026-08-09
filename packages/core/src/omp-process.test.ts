import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ompChildEnv,
  runOmpOnce,
  type OmpOneShotProcess,
  type OmpOneShotSpawn,
} from "./omp-process";

interface FakeOmp {
  spawn: OmpOneShotSpawn;
  stdout: PassThrough;
  stderr: PassThrough;
  exit(code: number | null): void;
  spawnError(error: Error): void;
  killed(): boolean;
  invocation(): { ompPath: string; argv: string[]; env: NodeJS.ProcessEnv };
}

function fakeOmp(): FakeOmp {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  let wasKilled = false;
  let invoked: { ompPath: string; argv: string[]; env: NodeJS.ProcessEnv } | undefined;
  const process: OmpOneShotProcess = {
    stdout,
    stderr,
    kill: () => {
      wasKilled = true;
    },
    onExit: (cb) => void events.on("exit", cb),
    onSpawnError: (cb) => void events.on("error", cb),
  };
  return {
    spawn: (ompPath, argv, env) => {
      invoked = { ompPath, argv, env };
      return process;
    },
    stdout,
    stderr,
    exit: (code) => void events.emit("exit", code),
    spawnError: (error) => void events.emit("error", error),
    killed: () => wasKilled,
    invocation: () => invoked!,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ompChildEnv", () => {
  it("copies the base environment and prepends the omp directory to PATH", () => {
    const base = { PATH: path.join("old", "bin"), KEEP: "yes" };
    const env = ompChildEnv(path.join("resolved", "bin", "omp"), base);

    expect(env).toEqual({
      PATH: [path.join("resolved", "bin"), base.PATH].join(path.delimiter),
      KEEP: "yes",
    });
    expect(env).not.toBe(base);
    expect(base.PATH).toBe(path.join("old", "bin"));
  });

  it("uses only the omp directory when the base has no PATH", () => {
    expect(ompChildEnv(path.join("resolved", "bin", "omp"), {}).PATH).toBe(
      path.join("resolved", "bin"),
    );
  });
});

describe("runOmpOnce", () => {
  it("passes argv and the child environment, drains stderr, and collects stdout", async () => {
    vi.useFakeTimers();
    const fake = fakeOmp();
    const argv = ["-p", "--", "prompt"];
    const result = runOmpOnce({
      ompPath: "/opt/omp/bin/omp",
      argv,
      timeout: 1000,
      spawn: fake.spawn,
    });

    expect(fake.invocation().ompPath).toBe("/opt/omp/bin/omp");
    expect(fake.invocation().argv).toBe(argv);
    expect(fake.invocation().env.PATH?.startsWith(`/opt/omp/bin${path.delimiter}`)).toBe(true);
    expect(fake.stderr.listenerCount("data")).toBe(1);
    fake.stderr.write("Working...");
    fake.stdout.write("first");
    fake.stdout.write(" second");
    fake.exit(0);

    await expect(result).resolves.toBe("first second");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, null])("returns null for an unsuccessful exit (%s)", async (code) => {
    vi.useFakeTimers();
    const fake = fakeOmp();
    const result = runOmpOnce({
      ompPath: "/bin/omp",
      argv: [],
      timeout: 1000,
      spawn: fake.spawn,
    });
    fake.stdout.write("ignored");
    fake.exit(code);

    await expect(result).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null when spawning throws", async () => {
    await expect(
      runOmpOnce({
        ompPath: "/missing/omp",
        argv: [],
        timeout: 1000,
        spawn: () => {
          throw new Error("ENOENT");
        },
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a spawn error event and clears the timeout", async () => {
    vi.useFakeTimers();
    const fake = fakeOmp();
    const result = runOmpOnce({
      ompPath: "/bin/omp",
      argv: [],
      timeout: 1000,
      spawn: fake.spawn,
    });
    fake.spawnError(new Error("ENOENT"));

    await expect(result).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills the child and returns null on timeout", async () => {
    vi.useFakeTimers();
    const fake = fakeOmp();
    const result = runOmpOnce({
      ompPath: "/bin/omp",
      argv: [],
      timeout: 90_000,
      spawn: fake.spawn,
    });

    await vi.advanceTimersByTimeAsync(90_000);
    await expect(result).resolves.toBeNull();
    expect(fake.killed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
