import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ROUTINE_SCRIPT_ENV_PREFIX,
  ROUTINE_TEST_OUTPUT_CAP,
  cancelAllRoutineScripts,
  runRoutineScript,
  runRoutineScriptForTest,
  type RoutineScriptEnv,
} from "./routine-scripts";
import type { FleetSpawnOptions } from "./fleet-shell";

const ENV: RoutineScriptEnv = { OMP_UI_ROUTINE_TRIGGER: "test", OMP_UI_ROUTINE_PROJECT_CWD: "/repo" };

interface FakeChild {
  readonly child: ChildProcess;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  close(code: number | null): void;
  emitError(err: Error): void;
}

/** A child whose close/error are driven by the test: nothing fires unasked. */
function fakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(emitter, {
    pid: 4242,
    stdout,
    stderr,
    kill: (): boolean => true,
  });
  return {
    // The launcher only ever uses the event emitter surface, stdout/stderr,
    // pid, and kill — the full ChildProcess type is not constructible here.
    child: child as unknown as ChildProcess,
    stdout,
    stderr,
    close: (code) => emitter.emit("close", code),
    emitError: (err) => emitter.emit("error", err),
  };
}

describe("runRoutineScript with a fake spawner", () => {
  it("maps exit 0 / 78 / 3 to ok / skip / failed", async () => {
    for (const [code, kind] of [
      [0, "ok"],
      [78, "skip"],
      [3, "failed"],
    ] as const) {
      const f = fakeChild();
      const promise = runRoutineScript("true", "/repo", ENV, { spawnFn: () => f.child });
      f.close(code);
      expect(await promise).toEqual(kind === "failed" ? { kind: "failed", timedOut: false, exitCode: 3 } : { kind });
    }
  });

  it("settles a never-closing child at the cap with timedOut and releases the latch", async () => {
    const f = fakeChild();
    const promise = runRoutineScript("sleep 60", "/repo", ENV, {
      spawnFn: () => f.child,
      timeoutMs: 25,
    });
    // cancelAll must kill the live group and still resolve through the timer.
    // (The group kill targets -pid via process.kill; ESRCH on the fake pid is
    // swallowed, exactly as a dead real tree would be.)
    cancelAllRoutineScripts();
    expect(await promise).toEqual({ kind: "failed", timedOut: true, exitCode: null });

    // A second run with a never-closing child settles on its own timer too —
    // proving the previous handle left the live set (no latch leak).
    const g = fakeChild();
    const outcome = await runRoutineScript("sleep 60", "/repo", ENV, { spawnFn: () => g.child, timeoutMs: 25 });
    expect(outcome).toEqual({ kind: "failed", timedOut: true, exitCode: null });
  });

  it("resolves failed (never rejects) when the spawner throws synchronously", async () => {
    const result = await runRoutineScript("true", "/repo", ENV, {
      spawnFn: () => {
        throw new Error("spawn blew up");
      },
    });
    expect(result).toEqual({ kind: "failed", timedOut: false, exitCode: null });
  });

  it("resolves failed when the child reports an error event", async () => {
    const f = fakeChild();
    const promise = runRoutineScript("true", "/repo", ENV, { spawnFn: () => f.child });
    f.emitError(new Error("EACCES"));
    expect(await promise).toEqual({ kind: "failed", timedOut: false, exitCode: null });
  });

  it("sweeps inherited OMP_UI_ROUTINE_* keys and sets only this phase's values", async () => {
    const f = fakeChild();
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const promise = runRoutineScript(
      "true",
      "/repo",
      {
        OMP_UI_ROUTINE_ID: "live-id",
        OMP_UI_ROUTINE_TRIGGER: "clock",
        OMP_UI_ROUTINE_PROJECT_CWD: "/live",
      },
      {
        env: {
          PATH: "/bin",
          [`${ROUTINE_SCRIPT_ENV_PREFIX}OUTCOME`]: "stale-late",
          [`${ROUTINE_SCRIPT_ENV_PREFIX}TAB_ID`]: "stale-tab",
          [`${ROUTINE_SCRIPT_ENV_PREFIX}REASON_CODE`]: "stale",
        },
        spawnFn: (_c, _a, opts: FleetSpawnOptions) => {
          seenEnv = opts.env;
          return f.child;
        },
      },
    );
    f.close(0);
    await promise;
    // The sentinels are absent from what the child actually receives — a grep
    // for the prefix in the parent env would hide exactly this.
    expect(seenEnv![`${ROUTINE_SCRIPT_ENV_PREFIX}OUTCOME`]).toBeUndefined();
    expect(seenEnv![`${ROUTINE_SCRIPT_ENV_PREFIX}TAB_ID`]).toBeUndefined();
    expect(seenEnv![`${ROUTINE_SCRIPT_ENV_PREFIX}REASON_CODE`]).toBeUndefined();
    expect(seenEnv![`${ROUTINE_SCRIPT_ENV_PREFIX}ID`]).toBe("live-id");
    expect(seenEnv![`${ROUTINE_SCRIPT_ENV_PREFIX}TRIGGER`]).toBe("clock");
    expect(seenEnv![`${ROUTINE_SCRIPT_ENV_PREFIX}PROJECT_CWD`]).toBe("/live");
  });

  it("retains zero output unattended and caps each stream in Test mode", async () => {
    const f = fakeChild();
    const unattended = runRoutineScript("true", "/repo", ENV, { spawnFn: () => f.child });
    f.stdout.emit("data", Buffer.from("x".repeat(ROUTINE_TEST_OUTPUT_CAP + 4096)));
    f.stderr.emit("data", Buffer.from("y".repeat(ROUTINE_TEST_OUTPUT_CAP + 4096)));
    f.close(0);
    const plain = await unattended;
    expect(plain).toEqual({ kind: "ok" });
    expect("stdout" in plain).toBe(false);

    const g = fakeChild();
    const tested = runRoutineScriptForTest("true", "/repo", ENV, { spawnFn: () => g.child });
    g.stdout.emit("data", Buffer.from("x".repeat(ROUTINE_TEST_OUTPUT_CAP + 4096)));
    g.stderr.emit("data", Buffer.from("y".repeat(42)));
    g.close(0);
    const result = await tested;
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.stdout.length).toBe(ROUTINE_TEST_OUTPUT_CAP);
      expect(result.stderr).toBe("y".repeat(42));
    }
  });
});

describe("runRoutineScript against the real shell", () => {
  describe.runIf(process.platform !== "win32")("posix", () => {
    it("maps exit 78 to skip and a false command to failed", async () => {
      expect(await runRoutineScript("exit 78", process.cwd(), ENV)).toEqual({ kind: "skip" });
      const failed = await runRoutineScript("false", process.cwd(), ENV);
      expect(failed.kind).toBe("failed");
    });

    it("times out a long sleep whose child never closes before the kill lands", async () => {
      // timeoutMs: 200 < sleep 30; the group kill SIGKILLs, but the promise is
      // settled by the timer race regardless of when close arrives.
      const result = await runRoutineScript("sleep 30", process.cwd(), ENV, { timeoutMs: 200 });
      expect(result).toEqual({ kind: "failed", timedOut: true, exitCode: null });
    });

    it("strips provider-key sentinels from the child env", async () => {
      const f = fakeChild();
      let seenEnv: NodeJS.ProcessEnv | undefined;
      const promise = runRoutineScript("env", "/repo", ENV, {
        env: { PATH: "/bin", OPENAI_API_KEY: "sentinel-key", ANTHROPIC_API_KEY: "sentinel-2" },
        spawnFn: (_c, _a, opts: FleetSpawnOptions) => {
          seenEnv = opts.env;
          return f.child;
        },
      });
      f.close(0);
      await promise;
      expect(seenEnv!["OPENAI_API_KEY"]).toBeUndefined();
      expect(seenEnv!["ANTHROPIC_API_KEY"]).toBeUndefined();
    });
  });

  describe.runIf(process.platform === "win32")("win32", () => {
    it("maps exit codes through the pwsh/cmd plan", async () => {
      expect(await runRoutineScript("exit /b 78", process.cwd(), ENV)).toEqual({ kind: "skip" });
      const failed = await runRoutineScript("exit /b 3", process.cwd(), ENV);
      expect(failed.kind).toBe("failed");
    });

    it("times out a long sleep", async () => {
      const result = await runRoutineScript("ping -n 31 127.0.0.1 >nul", process.cwd(), ENV, { timeoutMs: 200 });
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.timedOut).toBe(true);
    });
  });
});
