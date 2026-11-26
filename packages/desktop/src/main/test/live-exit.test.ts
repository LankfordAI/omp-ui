import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "@omp-ui/core";
import { LiveExitTracker, PreReadyExit, closeAwareSpawn, waitForOrExit } from "./live-exit";

interface Frame {
  type: string;
  id?: string;
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-live-exit-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Writes an executable Node script that ignores omp CLI flags and runs `body`.
 */
function writeStubBinary(dir: string, body: string): string {
  const scriptPath = path.join(dir, "stub-omp.cjs");
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return scriptPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("live-exit helper", () => {
  it("delivers buffered frames before close so a frame-then-immediate-exit stub resolves the frame", async () => {
    const base = makeTempDir();
    const lineage = path.join(base, "lin");
    // Emit ready + a response frame, then exit immediately with code 1.
    // closeAwareSpawn listens on `close`, so stdout drains into RpcClient
    // before `#dead` latches and `waitForOrExit` sees the frame first.
    const stub = writeStubBinary(
      base,
      `
      process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "response", id: "probe-1", success: true }) + "\\n");
      process.exit(1);
      `,
    );

    const frames: Frame[] = [];
    const tracker = new LiveExitTracker();
    const client = new RpcClient({
      cwd: base,
      lineageDir: lineage,
      ompPath: stub,
      spawnProcess: closeAwareSpawn(),
      onFrame: (frame) => frames.push(frame as Frame),
      onExit: (code) => tracker.recordExit(code),
      onError: (msg) => tracker.recordError(msg),
    });

    try {
      const matched = await waitForOrExit(
        () => frames.find((f) => f.type === "response" && f.id === "probe-1"),
        () => tracker.state(),
        5_000,
        "probe-1 response",
      );
      expect(matched).toMatchObject({ type: "response", id: "probe-1" });
    } finally {
      tracker.markTestKilling();
      client.kill();
    }
  });

  it("aborts immediately with PreReadyExit(code=1) when the child exits code 1 with no frame", async () => {
    const base = makeTempDir();
    const lineage = path.join(base, "lin");
    const stub = writeStubBinary(
      base,
      `
      process.stderr.write("No default model selected\\n");
      process.exit(1);
      `,
    );

    const frames: Frame[] = [];
    const tracker = new LiveExitTracker();
    const client = new RpcClient({
      cwd: base,
      lineageDir: lineage,
      ompPath: stub,
      spawnProcess: closeAwareSpawn(),
      onFrame: (frame) => frames.push(frame as Frame),
      onExit: (code) => tracker.recordExit(code),
      onError: (msg) => tracker.recordError(msg),
    });

    const startedAt = Date.now();
    let caught: unknown;
    try {
      await waitForOrExit(
        () => (frames.some((f) => f.type === "response") ? true : undefined),
        () => tracker.state(),
        30_000,
        "oauth ready response",
      );
    } catch (error) {
      caught = error;
    } finally {
      tracker.markTestKilling();
      client.kill();
    }

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(5_000);
    expect(caught).toBeInstanceOf(PreReadyExit);
    const exitErr = caught as PreReadyExit;
    expect(exitErr.code).toBe(1);
    expect(exitErr.isNonZeroExit).toBe(true);
    expect(exitErr.stderrError).toContain("No default model selected");
  });

  it("classifies signal/watchdog exit (code=null) as retryable (isNonZeroExit=false)", async () => {
    const base = makeTempDir();
    const lineage = path.join(base, "lin");
    const stub = writeStubBinary(
      base,
      `
      process.kill(process.pid, "SIGTERM");
      `,
    );

    const frames: Frame[] = [];
    const tracker = new LiveExitTracker();
    const client = new RpcClient({
      cwd: base,
      lineageDir: lineage,
      ompPath: stub,
      spawnProcess: closeAwareSpawn(),
      onFrame: (frame) => frames.push(frame as Frame),
      onExit: (code) => tracker.recordExit(code),
      onError: (msg) => tracker.recordError(msg),
    });

    let caught: unknown;
    try {
      await waitForOrExit(
        () => (frames.some((f) => f.type === "response") ? true : undefined),
        () => tracker.state(),
        30_000,
        "oauth ready response",
      );
    } catch (error) {
      caught = error;
    } finally {
      tracker.markTestKilling();
      client.kill();
    }

    expect(caught).toBeInstanceOf(PreReadyExit);
    const exitErr = caught as PreReadyExit;
    expect(exitErr.code).toBeNull();
    expect(exitErr.isNonZeroExit).toBe(false);
  });

  it("falls back after exit when a grandchild holds stdout open so teardown does not hang", async () => {
    const base = makeTempDir();
    const lineage = path.join(base, "lin");
    const stub = writeStubBinary(
      base,
      `
      const { spawn } = require("node:child_process");
      // Spawn a short-lived grandchild that inherits stdout/stderr so 'close'
      // is delayed well past the parent's exit.
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
        stdio: "inherit",
        detached: true,
      });
      child.unref();
      process.exit(1);
      `,
    );

    const tracker = new LiveExitTracker();
    const client = new RpcClient({
      cwd: base,
      lineageDir: lineage,
      ompPath: stub,
      spawnProcess: closeAwareSpawn(undefined, 150),
      onFrame: () => {},
      onExit: (code) => tracker.recordExit(code),
      onError: (msg) => tracker.recordError(msg),
    });

    const startedAt = Date.now();
    let caught: unknown;
    try {
      await waitForOrExit(
        () => undefined,
        () => tracker.state(),
        10_000,
        "oauth ready response",
      );
    } catch (error) {
      caught = error;
    } finally {
      tracker.markTestKilling();
      client.kill();
    }

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(caught).toBeInstanceOf(PreReadyExit);
    expect((caught as PreReadyExit).code).toBe(1);
  });
});
