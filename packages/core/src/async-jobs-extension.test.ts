import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASYNC_JOBS_COMMAND,
  ASYNC_JOBS_STATUS_KEY,
  parseAsyncJobsSnapshot,
  type AsyncJobsSnapshot,
} from "./async-jobs";
import { asyncJobsExtensionPath, writeAsyncJobsExtension } from "./async-jobs-extension";
import { transpileGeneratedExtension, typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-async-jobs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The fake root's job surface, all optional — absence is the degradation case. */
interface FakeJobApi {
  getAsyncJobSnapshot?: (options: { recentLimit: number }) => unknown;
  inspectAsyncJob?: (id: string) => unknown;
  cancelAsyncJob?: (id: string) => unknown;
}

interface FakeRoot {
  prompt(): Promise<void>;
  dispose(): void;
}

interface JobsHarness {
  FakeAgentSession: new () => FakeRoot;
  published: AsyncJobsSnapshot[];
  arm(): Promise<void>;
  invoke(args: string): Promise<void>;
  latest(): AsyncJobsSnapshot;
}

function executableExtension(api: FakeJobApi): JobsHarness {
  class FakeAgentSession {
    promptCalls = 0;
    disposeCalls = 0;
    async prompt(): Promise<void> {
      this.promptCalls += 1;
    }
    dispose(): void {
      this.disposeCalls += 1;
    }
  }
  Object.assign(FakeAgentSession.prototype, api);

  const file = writeAsyncJobsExtension(tempLineage());
  const source = fs.readFileSync(file, "utf8");
  const output = transpileGeneratedExtension(source, "cjs");
  const loaded = { exports: {} as { default?: (extensionApi: unknown) => void } };
  Function("module", "exports", output)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated extension has no default factory");

  let handler:
    | ((args: string, ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => Promise<void>)
    | undefined;
  const published: AsyncJobsSnapshot[] = [];
  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(ASYNC_JOBS_COMMAND);
      handler = options.handler;
    },
  });

  const invoke = async (args: string): Promise<void> => {
    if (!handler) throw new Error("generated extension did not register its command");
    await handler(args, {
      ui: {
        setStatus: (key, text): void => {
          expect(key).toBe(ASYNC_JOBS_STATUS_KEY);
          const parsed = parseAsyncJobsSnapshot(text);
          if (parsed !== null) published.push(parsed);
        },
      },
    });
  };
  return {
    FakeAgentSession,
    published,
    arm: (): Promise<void> => invoke(""),
    invoke,
    latest: (): AsyncJobsSnapshot => {
      const value = published.at(-1);
      if (!value) throw new Error("generated extension published no snapshot");
      return value;
    },
  };
}

function rawJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bg_1",
    type: "bash",
    status: "running",
    label: "sleep 30",
    command: "sleep 30",
    startTime: 1_000,
    ...overrides,
  };
}

/** Binds the prompt hook's root: the first prompt captures the session. */
async function bindRoot(harness: JobsHarness): Promise<FakeRoot> {
  const session = new harness.FakeAgentSession();
  await session.prompt();
  return session;
}

describe("writeAsyncJobsExtension", () => {
  it("writes the file beside the lineage dir and interpolates the wire constants", () => {
    const dir = tempLineage();
    const file = writeAsyncJobsExtension(dir);
    expect(file).toBe(asyncJobsExtensionPath(dir));
    const source = fs.readFileSync(file, "utf8");
    expect(source).toContain(`"${ASYNC_JOBS_STATUS_KEY}"`);
    expect(source).toContain(`"${ASYNC_JOBS_COMMAND}"`);
    expect(source).toContain("const POLL_MS = 1500;");
    expect(source).toContain("const BYTE_LIMIT = 262144;");
    typecheckGeneratedExtension(file);
  });

  it("the arm publishes the job with inspect details after the root bound", async () => {
    const harness = executableExtension({
      getAsyncJobSnapshot: ({ recentLimit }) => ({
        running: [rawJob()],
        recent: recentLimit > 0 ? [rawJob({ id: "bg_0", status: "completed", endTime: 2_000 })] : [],
        delivery: null,
      }),
      inspectAsyncJob: (id: string) =>
        id === "bg_1"
          ? { command: "sleep 30", cwd: "/tmp/scratch", pids: [4242], exitCode: null, output: "hi" }
          : undefined,
      cancelAsyncJob: () => true,
    });
    await bindRoot(harness);
    await harness.arm();
    const snapshot = harness.latest();
    expect(snapshot.available).toBe(true);
    expect(snapshot.canInspect).toBe(true);
    expect(snapshot.canCancel).toBe(true);
    expect(snapshot.running[0]).toMatchObject({
      id: "bg_1",
      type: "bash",
      status: "running",
      command: "sleep 30",
      cwd: "/tmp/scratch",
      pids: [4242],
      exitCode: null,
      outputTail: "hi",
    });
    expect(snapshot.recent[0]?.status).toBe("completed");
    expect(snapshot.result).toBeNull();
  });

  it("publishes the last 2000 chars of the output, ANSI stripped, newlines kept", async () => {
    const long = "x".repeat(4_990) + "\u001b[31m" + "tail\nend";
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [rawJob()], recent: [], delivery: null }),
      inspectAsyncJob: () => ({ output: long }),
      cancelAsyncJob: () => true,
    });
    await bindRoot(harness);
    await harness.arm();
    const job = harness.latest().running[0]!;
    expect(job.outputTail).toHaveLength(2_000);
    expect(job.outputTail.endsWith("tail\nend")).toBe(true);
    expect(job.outputTail).not.toContain("\u001b");
    expect(job.outputTruncated).toBe(true);
  });

  it("an unchanged poll publishes nothing; changed output publishes revision + 1", async () => {
    vi.useFakeTimers();
    let output = "first";
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [rawJob()], recent: [], delivery: null }),
      inspectAsyncJob: () => ({ output }),
      cancelAsyncJob: () => true,
    });
    await bindRoot(harness);
    await harness.arm();
    expect(harness.published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(harness.published).toHaveLength(1);
    output = "second";
    // An unchanged digest idles the chain to the 10s cadence; the next tick
    // (t=11500) picks the change up — the settle a quiet session accepts.
    await vi.advanceTimersByTimeAsync(5_500); // t=10000: the idle arm is at t=11500
    expect(harness.published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(harness.published).toHaveLength(2);
    expect(harness.published[1]?.revision).toBe(2);
    expect(harness.published[1]?.running[0]?.outputTail).toBe("second");
  });

  it("an oversized snapshot falls to the short tail, then to unavailable", async () => {
    const wide = executableExtension({
      getAsyncJobSnapshot: () => ({
        running: Array.from({ length: 150 }, (_, i) => rawJob({ id: `bg_${i}`, startTime: 1_000 + i })),
        recent: [],
        delivery: null,
      }),
      inspectAsyncJob: () => ({ output: "y".repeat(5_000) }),
      cancelAsyncJob: () => true,
    });
    await bindRoot(wide);
    await wide.arm();
    const short = wide.latest();
    expect(short.available).toBe(true);
    expect(short.running).toHaveLength(150);
    expect(short.running[0]?.outputTail).toHaveLength(200);
    // Past even the empty-tail rung: no job is ever published in half.
    const huge = executableExtension({
      getAsyncJobSnapshot: () => ({
        running: Array.from({ length: 200 }, (_, i) =>
          rawJob({ id: `bg_${i}`, startTime: 1_000 + i, label: "l".repeat(512), command: "c".repeat(1_024) }),
        ),
        recent: [],
        delivery: null,
      }),
    });
    await bindRoot(huge);
    await huge.arm();
    expect(huge.latest().available).toBe(false);
    expect(huge.latest().unavailable).toContain("262144 bytes");
  });

  it("without getAsyncJobSnapshot the snapshot is unavailable with the reason", async () => {
    const harness = executableExtension({});
    await bindRoot(harness);
    await harness.arm();
    expect(harness.latest().available).toBe(false);
    expect(harness.latest().unavailable).toContain("no background-job API");
  });

  it("before any prompt the snapshot reports no bound session", async () => {
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: null }),
    });
    await harness.arm();
    expect(harness.latest().available).toBe(false);
    expect(harness.latest().unavailable).toContain("no omp session has prompted yet");
  });

  it("without inspectAsyncJob the flags clear and detail fields stay null", async () => {
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [rawJob()], recent: [], delivery: null }),
      cancelAsyncJob: () => true,
    });
    await bindRoot(harness);
    await harness.arm();
    const snapshot = harness.latest();
    expect(snapshot.canInspect).toBe(false);
    expect(snapshot.running[0]).toMatchObject({
      command: "sleep 30",
      cwd: null,
      pids: [],
      exitCode: null,
      outputTail: "",
    });
  });

  it("without cancelAsyncJob kill reports ok:false and a hint", async () => {
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [rawJob()], recent: [], delivery: null }),
    });
    await bindRoot(harness);
    await harness.arm();
    const processKey = harness.latest().processKey;
    await harness.invoke(
      `kill ${JSON.stringify({ requestId: "r1", processKey, jobId: "bg_1", startTime: 1_000 })}`,
    );
    const result = harness.latest().result!;
    expect(result).toMatchObject({ requestId: "r1", ok: false, cancelled: [] });
    expect(result.text).toContain("18.4.9");
  });

  it("kill cancels the job and publishes the matching result", async () => {
    const cancelled: string[] = [];
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [rawJob()], recent: [], delivery: null }),
      inspectAsyncJob: () => ({ command: "sleep 30", cwd: "/tmp/scratch", pids: [4242] }),
      cancelAsyncJob: (id: string) => {
        cancelled.push(id);
        return true;
      },
    });
    await bindRoot(harness);
    await harness.arm();
    const processKey = harness.latest().processKey;
    await harness.invoke(
      `kill ${JSON.stringify({ requestId: "r7", processKey, jobId: "bg_1", startTime: 1_000 })}`,
    );
    expect(cancelled).toEqual(["bg_1"]);
    expect(harness.latest().result).toEqual({
      requestId: "r7",
      ok: true,
      cancelled: ["bg_1"],
      text: "Cancelled background job bg_1.",
    });
  });

  it("a foreign processKey never cancels anything", async () => {
    const cancelled: string[] = [];
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [rawJob()], recent: [], delivery: null }),
      cancelAsyncJob: (id: string) => {
        cancelled.push(id);
        return true;
      },
    });
    await bindRoot(harness);
    await harness.arm();
    await harness.invoke(
      `kill ${JSON.stringify({ requestId: "r1", processKey: "omp-ui-other-key", jobId: "bg_1", startTime: 1_000 })}`,
    );
    expect(cancelled).toEqual([]);
    expect(harness.latest().result?.ok).toBe(false);
  });

  it("a startTime mismatch never cancels a reused bg_N", async () => {
    const cancelled: string[] = [];
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [rawJob()], recent: [], delivery: null }),
      cancelAsyncJob: (id: string) => {
        cancelled.push(id);
        return true;
      },
    });
    await bindRoot(harness);
    await harness.arm();
    const processKey = harness.latest().processKey;
    await harness.invoke(
      `kill ${JSON.stringify({ requestId: "r1", processKey, jobId: "bg_1", startTime: 999_999 })}`,
    );
    expect(cancelled).toEqual([]);
    const result = harness.latest().result!;
    expect(result.ok).toBe(false);
    expect(result.text).toContain("a newer job now uses that id");
  });

  it("kill all cancels running jobs only", async () => {
    const cancelled: string[] = [];
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({
        running: [rawJob(), rawJob({ id: "bg_2", startTime: 1_500 })],
        recent: [rawJob({ id: "bg_9", status: "completed", endTime: 2_000 })],
        delivery: null,
      }),
      cancelAsyncJob: (id: string) => {
        cancelled.push(id);
        return true;
      },
    });
    await bindRoot(harness);
    await harness.arm();
    const processKey = harness.latest().processKey;
    await harness.invoke(
      `kill ${JSON.stringify({ requestId: "r1", processKey, jobId: null, startTime: null })}`,
    );
    expect(cancelled).toEqual(["bg_1", "bg_2"]);
    const result = harness.latest().result!;
    expect(result).toMatchObject({ requestId: "r1", ok: true, cancelled: ["bg_1", "bg_2"] });
    expect(result.text).toContain("2 background jobs");
  });

  it("kill of a job that already finished reports it", async () => {
    const cancelled: string[] = [];
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [rawJob()], recent: [], delivery: null }),
      cancelAsyncJob: (id: string) => {
        cancelled.push(id);
        return true;
      },
    });
    await bindRoot(harness);
    await harness.arm();
    const processKey = harness.latest().processKey;
    await harness.invoke(
      `kill ${JSON.stringify({ requestId: "r1", processKey, jobId: "bg_5", startTime: 1_000 })}`,
    );
    expect(cancelled).toEqual([]);
    expect(harness.latest().result?.text).toContain('No running background job with id "bg_5"');
  });

  it("unsupported or malformed args throw instead of faking a result", async () => {
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: null }),
      cancelAsyncJob: () => true,
    });
    await bindRoot(harness);
    await expect(harness.invoke("list")).rejects.toThrow("unsupported command args");
    await expect(harness.invoke("kill not-json")).rejects.toThrow("malformed kill request");
    await expect(
      harness.invoke(
        `kill ${JSON.stringify({ requestId: "r", processKey: "k", jobId: "bg_1", startTime: "nope" })}`,
      ),
    ).rejects.toThrow("malformed kill request");
  });

  it("disposing the root session stops the poll", async () => {
    vi.useFakeTimers();
    let output = "one";
    const harness = executableExtension({
      getAsyncJobSnapshot: () => ({ running: [rawJob()], recent: [], delivery: null }),
      inspectAsyncJob: () => ({ output }),
      cancelAsyncJob: () => true,
    });
    const session = await bindRoot(harness);
    await harness.arm();
    expect(harness.published).toHaveLength(1);
    session.dispose();
    output = "two";
    await vi.advanceTimersByTimeAsync(4_500);
    expect(harness.published).toHaveLength(1);
  });
});
