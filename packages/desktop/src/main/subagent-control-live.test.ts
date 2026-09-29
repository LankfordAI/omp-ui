import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary, writeSubagentControlExtension } from "@omp-ui/core";
import {
  SUBAGENT_CONTROL_STATUS_KEY,
  findSubagentControlResult,
  parseSubagentControlSnapshot,
  subagentControlArmMessage,
  subagentControlMessage,
  type SubagentControlSnapshot,
} from "@omp-ui/core/subagent-control";

/**
 * End-to-end proof that the subagent-control bridge (issue #684, ADR-0040)
 * loads into the REAL `omp --mode=rpc-ui`, binds omp's registry/lifecycle
 * globals through the literal subpaths, arms into an `available` snapshot, and
 * settles a verb envelope with omp's own refusal sentence — without a model.
 * A real spawned subagent would need one; the refusal path exercises the same
 * registry lookup the live verbs take.
 *
 * Spawns real omp (~5–10 s each); skips cleanly when resolveOmpBinary fails.
 */

type Frame = {
  type: string;
  statusKey?: string;
  statusText?: string;
  message?: { role?: string; content?: unknown };
};

const ompPath = resolveOmpBinary();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

interface Harness {
  client: RpcClient;
  frames: Frame[];
  snapshots(): SubagentControlSnapshot[];
  kill(): Promise<void>;
}

const disposers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function spawnHarness(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-subctl-live-"));
  const lineage = path.join(base, "lin");
  const frames: Frame[] = [];
  let exited = false;
  const client = new RpcClient({
    cwd: base,
    lineageDir: lineage,
    ompPath: ompPath!,
    extensions: [writeSubagentControlExtension(lineage)],
    onFrame: (frame) => frames.push(frame as Frame),
    onExit: () => {
      exited = true;
    },
    onError: () => {},
  });
  const harness: Harness = {
    client,
    frames,
    snapshots: () =>
      frames
        .filter((f) => f.type === "extension_ui_request" && f.statusKey === SUBAGENT_CONTROL_STATUS_KEY)
        .map((f) => parseSubagentControlSnapshot(f.statusText))
        .filter((s): s is SubagentControlSnapshot => s !== null),
    kill: async () => {
      client.kill();
      const deadline = Date.now() + 8_000;
      while (!exited && Date.now() < deadline) await sleep(100);
      if (!exited) client.kill("SIGKILL");
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  disposers.push(() => harness.kill());
  return harness;
}

describe.skipIf(!ompPath)("subagent-control live (real omp)", () => {
  it("loads and arms into an available snapshot without a transcript row", { timeout: 120000 }, async () => {
    const harness = spawnHarness();
    await waitFor(
      () => (harness.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
      60_000,
      "omp ready",
    );
    harness.client.send({ type: "prompt", message: subagentControlArmMessage() });
    const snapshot = await waitFor(
      () => harness.snapshots().find((s) => s.available),
      30_000,
      "an available control snapshot",
    );
    expect(snapshot.processKey).not.toBe("");
    // The registry globals resolved: a real agent id would be controllable.
    expect(snapshot.reason).toBeUndefined();
    // The hidden arm line reached the bridge, not the model or the transcript.
    const userItems = harness.frames.filter(
      (f) => (f.type === "message_start" || f.type === "message_end") && f.message?.role === "user",
    );
    expect(userItems).toEqual([]);
  });

  it("settles a kill of an unknown agent with omp's refusal, correlated by requestId", { timeout: 120000 }, async () => {
    const harness = spawnHarness();
    await waitFor(
      () => (harness.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
      60_000,
      "omp ready",
    );
    harness.client.send({ type: "prompt", message: subagentControlArmMessage() });
    await waitFor(() => harness.snapshots().find((s) => s.available), 30_000, "the arm snapshot");
    harness.client.send({
      type: "prompt",
      message: subagentControlMessage({ requestId: "live-kill-1", agentId: "no-such-agent", action: "kill" }),
    });
    const settled = await waitFor(
      () => {
        const snapshot = harness.snapshots().at(-1);
        const result = snapshot === undefined
          ? undefined
          : findSubagentControlResult(snapshot, "live-kill-1");
        return result !== undefined ? result : undefined;
      },
      30_000,
      "the kill result",
    );
    expect(settled.ok).toBe(false);
    expect(settled.error).toContain("no-such-agent");
    expect(settled.error).toContain("history://");
    // Still no transcript pollution: the envelope never became a model turn.
    const userItems = harness.frames.filter(
      (f) => (f.type === "message_start" || f.type === "message_end") && f.message?.role === "user",
    );
    expect(userItems).toEqual([]);
  });
});
