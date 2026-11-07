import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatsCollector } from "./stats-collector";
import type { StatsSourceInfo } from "./types";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}
const fixtures: { root: string; collector: StatsCollector; children: FakeChild[] }[] = [];

function fixture(options: { database?: "valid" | "foreign" | "missing"; binary?: string | null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-stats-collector-"));
  const source: StatsSourceInfo = {
    profile: null, databasePath: path.join(root, "stats.db"),
    sessionsRoot: path.join(root, "sessions"), archiveRoot: path.join(root, "archive", "sessions"),
  };
  if (options.database !== "missing") {
    const db = new DatabaseSync(source.databasePath);
    db.exec(options.database === "foreign" ? "CREATE TABLE unrelated (value TEXT)" : `CREATE TABLE messages (
      session_file TEXT, entry_id TEXT, folder TEXT, model TEXT, provider TEXT, timestamp INTEGER,
      stop_reason TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, total_tokens INTEGER, cost_total REAL)`);
    db.close();
  }
  const children: FakeChild[] = [];
  const spawnMock = vi.fn<(command: string, args: readonly string[], options: SpawnOptions) => ChildProcess>(() => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  let binary = options.binary === undefined ? path.join(root, "bin", "omp") : options.binary;
  let env: NodeJS.ProcessEnv = { PATH: root, KEEP: "original", NO_COLOR: "0", FORCE_COLOR: "1" };
  let selected = source;
  const collector = new StatsCollector({
    cwd: root,
    getOmpPath: () => binary,
    getEnv: () => env,
    resolveSource: () => selected,
    spawn: spawnMock as unknown as typeof spawn,
  });
  fixtures.push({ root, collector, children });
  return {
    root, source, collector, children, spawnMock,
    setBinary(value: string | null) { binary = value; },
    setEnv(value: NodeJS.ProcessEnv) { env = value; },
    setSource(value: StatsSourceInfo) { selected = value; },
    env,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(async () => {
  for (const { root, collector, children } of fixtures.splice(0)) {
    const disposed = collector.dispose();
    for (const child of children) child.close(null, "SIGTERM");
    await disposed;
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("StatsCollector", () => {
  it("reserves one run for simultaneous force/if-stale clients and returns state by value", async () => {
    const { collector, spawnMock, children, source } = fixture();
    const first = collector.start("force");
    const second = collector.start("if-stale");
    expect(first.run?.phase).toBe("running");
    expect(second.run?.id).toBe(first.run?.id);
    expect(spawnMock).not.toHaveBeenCalled();
    first.run!.phase = "failed";
    first.source!.databasePath = "/wrong";
    expect(collector.status().run?.phase).toBe("running");
    expect(collector.status().source).toEqual(source);
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(collector.start("force").run?.id).toBe(second.run?.id);
    children[0]!.close();
    expect(collector.status().run?.phase).toBe("succeeded");
  });

  it("launches only direct summary args with pinned env and neutral cwd", async () => {
    const { collector, source, root, env, setEnv, spawnMock, children } = fixture();
    collector.start("force");
    env.KEEP = "mutated-after-start";
    setEnv({ KEEP: "replacement" });
    await Promise.resolve();
    expect(spawnMock.mock.calls[0]).toEqual([
      path.join(root, "bin", "omp"), ["stats", "--summary"],
      {
        cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: [path.join(root, "bin"), root].join(path.delimiter), KEEP: "original", NO_COLOR: "1", FORCE_COLOR: "0" },
      },
    ]);
    expect(collector.status().source).toEqual(source);
    children[0]!.close();
  });

  it("requires actual close, code zero, and a readonly intended schema probe", async () => {
    const { collector, source, children } = fixture();
    const before = fs.readFileSync(source.databasePath);
    collector.start("force");
    await Promise.resolve();
    children[0]!.emit("exit", 0, null);
    expect(collector.status().run?.phase).toBe("running");
    expect(collector.status().lastSuccessfulSyncAt).toBeNull();
    children[0]!.close();
    expect(collector.status().run).toMatchObject({ phase: "succeeded", error: null, exitCode: 0, finishedAt: Date.now() });
    expect(collector.status().lastSuccessfulSyncAt).toBe(Date.now());
    expect(fs.readFileSync(source.databasePath)).toEqual(before);
    expect(fs.readdirSync(path.dirname(source.databasePath))).toEqual(["stats.db"]);
  });

  it.each(["foreign", "missing"] as const)("fails safely for %s database after code-zero close", async (database) => {
    const { collector, source, children } = fixture({ database });
    collector.start("force");
    await Promise.resolve();
    children[0]!.close();
    expect(collector.status().run?.phase).toBe("failed");
    expect(collector.status().lastSuccessfulSyncAt).toBeNull();
    if (database === "missing") expect(fs.existsSync(source.databasePath)).toBe(false);
  });

  it("does not accept a partial messages schema", async () => {
    const { collector, source, children } = fixture({ database: "foreign" });
    const db = new DatabaseSync(source.databasePath);
    db.exec("CREATE TABLE messages (session_file TEXT)");
    db.close();
    collector.start("force");
    await Promise.resolve();
    children[0]!.close();
    expect(collector.status().run?.phase).toBe("failed");
  });

  it("uses latest-attempt cooldown after failure, allows force, and never retries on its own", async () => {
    const { collector, children, spawnMock } = fixture();
    const first = collector.start("if-stale");
    await Promise.resolve();
    children[0]!.close(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(collector.start("if-stale").run?.id).toBe(first.run?.id);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const next = collector.start("if-stale");
    expect(next.run?.id).not.toBe(first.run?.id);
    await Promise.resolve();
    children[1]!.close(2);
    const force = collector.start("force");
    expect(force.run?.id).not.toBe(next.run?.id);
    await Promise.resolve();
    children[2]!.close(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it("pins live source, then clears freshness and cooldown when idle source identity changes", async () => {
    const { collector, source, setSource, children } = fixture();
    const first = collector.start("force");
    await Promise.resolve();
    const nextSource = { ...source, sessionsRoot: `${source.sessionsRoot}-other` };
    setSource(nextSource);
    expect(collector.status().source).toEqual(source);
    expect(collector.start("force").run?.id).toBe(first.run?.id);
    children[0]!.close();
    const next = collector.status();
    expect(next.source).toEqual(nextSource);
    expect(next.run).toBeNull();
    expect(next.lastSuccessfulSyncAt).toBeNull();
    expect(collector.start("if-stale").run?.id).not.toBe(first.run?.id);
    await Promise.resolve();
    children[1]!.close();
  });

  it("resolves the binary dynamically rather than caching an unavailable path", async () => {
    const { collector, setBinary, spawnMock, children, root } = fixture({ binary: null });
    collector.start("force");
    await Promise.resolve();
    expect(collector.status().run?.phase).toBe("failed");
    expect(spawnMock).not.toHaveBeenCalled();
    setBinary(path.join(root, "new", "omp"));
    collector.start("force");
    await Promise.resolve();
    expect(spawnMock.mock.calls[0]?.[0]).toBe(path.join(root, "new", "omp"));
    children[0]!.close();
  });

  it("contains spawn exceptions and source errors without leaking their contents", async () => {
    const { collector, spawnMock } = fixture();
    spawnMock.mockImplementationOnce(() => { throw new Error("credential-secret"); });
    collector.start("force");
    await Promise.resolve();
    expect(collector.status().run?.phase).toBe("failed");
    expect(JSON.stringify(collector.status())).not.toContain("credential-secret");
    const invalid = new StatsCollector({ cwd: "/neutral", getOmpPath: () => "/omp", getEnv: () => ({}), resolveSource: () => { throw new Error("private-secret"); }, spawn: spawnMock as unknown as typeof spawn });
    expect(invalid.start("force")).toMatchObject({ source: null, sourceError: "The OMP stats source is invalid.", run: null });
    expect(JSON.stringify(invalid.status())).not.toContain("private-secret");
    await invalid.dispose();
  });

  it("drains both pipes, bounds private stderr at 32KiB, and never exposes child text", async () => {
    const { collector, children } = fixture();
    collector.start("force");
    await Promise.resolve();
    const child = children[0]!;
    child.stdout.write(Buffer.alloc(256 * 1024, "o"));
    child.stderr.write(Buffer.alloc(256 * 1024, "s"));
    child.stderr.write("credential-secret");
    // The memory bound itself is a security invariant, not just a UI assertion.
    const internal = collector as unknown as { active: { stderr: Buffer; stderrLength: number } };
    expect(internal.active.stderr.byteLength).toBe(32 * 1024);
    expect(internal.active.stderrLength).toBe(32 * 1024);
    // Executor form: core's ES2022 lib predates Promise.withResolvers.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(child.stdout.readableLength).toBe(0);
    child.close(1);
    expect(JSON.stringify(collector.status())).not.toContain("credential-secret");
    expect(collector.status().run?.phase).toBe("failed");
  });

  it("times out with TERM then KILL, refuses overlapping starts without close, and rejects late success", async () => {
    const { collector, children, spawnMock } = fixture();
    const first = collector.start("force");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(children[0]!.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(collector.status().run?.phase).toBe("stopping");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]!.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    const disposal = collector.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    await disposal;
    expect(collector.status().run?.phase).toBe("stopping");
    expect(collector.start("force").run?.id).toBe(first.run?.id);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    children[0]!.close(0);
    expect(collector.status().run?.phase).toBe("failed");
    expect(collector.status().lastSuccessfulSyncAt).toBeNull();
  });

  it("keeps the single-flight slot after timeout reaping even without disposal", async () => {
    const { collector, children, spawnMock } = fixture();
    const first = collector.start("force");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(605_000);
    expect(collector.start("force").run?.id).toBe(first.run?.id);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    children[0]!.close(0);
    expect(collector.status().run?.phase).toBe("failed");
    expect(collector.start("force").run?.id).not.toBe(first.run?.id);
    await Promise.resolve();
    children[1]!.close();
  });

  it("disposal cancels synchronously and late close-zero is cancelled, not success", async () => {
    const { collector, children, spawnMock } = fixture();
    collector.start("force");
    await Promise.resolve();
    const disposal = collector.dispose();
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(collector.status().run?.phase).toBe("stopping");
    children[0]!.close(0);
    await disposal;
    expect(collector.status().run?.phase).toBe("cancelled");
    expect(collector.status().lastSuccessfulSyncAt).toBeNull();
    collector.start("force");
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a reserved run before launch without starting a child", async () => {
    const { collector, spawnMock } = fixture();
    collector.start("force");
    const disposal = collector.dispose();
    expect(collector.status().run?.phase).toBe("cancelled");
    await disposal;
    await Promise.resolve();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("treats an error event followed by close-zero as failure and clears its kill timers", async () => {
    const { collector, children } = fixture();
    collector.start("force");
    await Promise.resolve();
    children[0]!.emit("error", new Error("private-secret"));
    expect(collector.status().run?.phase).toBe("stopping");
    children[0]!.close(0);
    expect(collector.status().run?.phase).toBe("failed");
    await vi.advanceTimersByTimeAsync(605_000);
    expect(children[0]!.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(JSON.stringify(collector.status())).not.toContain("private-secret");
  });

  it("does not substitute an existing database for the intended missing target", async () => {
    const { collector, source, setSource, children } = fixture();
    const missing = path.join(path.dirname(source.databasePath), "selected-missing.db");
    setSource({ ...source, databasePath: missing });
    collector.start("force");
    await Promise.resolve();
    children[0]!.close();
    expect(collector.status().run?.phase).toBe("failed");
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(source.databasePath)).toBe(true);
  });

  it("fails closed on a corrupt database without exposing SQLite text", async () => {
    const { collector, source, children } = fixture({ database: "missing" });
    fs.writeFileSync(source.databasePath, "not a sqlite database: private-secret");
    collector.start("force");
    await Promise.resolve();
    children[0]!.close();
    expect(collector.status().run?.phase).toBe("failed");
    expect(JSON.stringify(collector.status())).not.toContain("private-secret");
  });

  it("fails closed while the intended database has an exclusive writer lock", async () => {
    const { collector, source, children } = fixture();
    const writer = new DatabaseSync(source.databasePath);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      collector.start("force");
      await Promise.resolve();
      children[0]!.close();
      expect(collector.status().run?.phase).toBe("failed");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("does not report success for a signal termination even with code zero", async () => {
    const { collector, children } = fixture();
    collector.start("force");
    await Promise.resolve();
    children[0]!.close(0, "SIGTERM");
    expect(collector.status().run?.phase).toBe("failed");
    expect(collector.status().lastSuccessfulSyncAt).toBeNull();
  });

  it("settles disposal after a missed close even when TERM and KILL throw", async () => {
    const { collector, children } = fixture();
    collector.start("force");
    await Promise.resolve();
    children[0]!.kill.mockImplementation(() => { throw new Error("private-secret"); });
    const disposal = collector.dispose();
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    await disposal;
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(collector.status().run?.phase).toBe("stopping");
    expect(JSON.stringify(collector.status())).not.toContain("private-secret");
    children[0]!.close(0);
    expect(collector.status().run?.phase).toBe("cancelled");
  });

  it.each(["stdout", "stderr"] as const)("contains %s pipe errors until close and rejects later code-zero", async (pipe) => {
    const { collector, children } = fixture();
    collector.start("force");
    await Promise.resolve();
    children[0]![pipe].emit("error", new Error("private-secret"));
    expect(collector.status().run?.phase).toBe("stopping");
    children[0]!.close(0);
    expect(collector.status().run?.phase).toBe("failed");
    expect(JSON.stringify(collector.status())).not.toContain("private-secret");
  });

  it("does not accept a lookalike view in place of OMP's messages table", async () => {
    const { collector, source, children } = fixture();
    const db = new DatabaseSync(source.databasePath);
    db.exec("ALTER TABLE messages RENAME TO other_messages; CREATE VIEW messages AS SELECT * FROM other_messages");
    db.close();
    collector.start("force");
    await Promise.resolve();
    children[0]!.close();
    expect(collector.status().run?.phase).toBe("failed");
  });
});
