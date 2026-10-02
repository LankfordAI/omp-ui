import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary } from "@omp-ui/core";

/**
 * Pins omp's native subagent verbs (issue #713, ADR-0045) against the REAL
 * `omp --mode=rpc-ui`, model-free: an unknown id exercises the same
 * resolveOwnedLiveSubagent lookup a live agent takes. A rename or a dropped
 * verb fails here before the Agents pane silently loses its controls.
 *
 * Spawns real omp (~5–10 s); skips cleanly when resolveOmpBinary fails.
 */

type Frame = {
  type: string;
  id?: string;
  success?: boolean;
  data?: { cancelled?: unknown };
  error?: string;
};

const ompPath = resolveOmpBinary();

function sleep(ms: number): Promise<void> {
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  // A real process is the thing waited on, so a real timer is the only clock.
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

const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

describe.skipIf(!ompPath)("native subagent verbs live (real omp)", () => {
  it(
    "cancel_subagent answers an unknown id cancelled:false; steer_subagent refuses it verbatim",
    { timeout: 120_000 },
    async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-subverbs-live-"));
      const lineage = path.join(base, "lin");
      fs.mkdirSync(lineage, { recursive: true });
      const frames: Frame[] = [];
      let exited = false;
      const client = new RpcClient({
        cwd: base,
        lineageDir: lineage,
        ompPath: ompPath!,
        onFrame: (frame) => frames.push(frame as Frame),
        onExit: () => {
          exited = true;
        },
        onError: () => {},
      });
      disposers.push(async () => {
        client.kill();
        const deadline = Date.now() + 8_000;
        while (!exited && Date.now() < deadline) await sleep(100);
        if (!exited) client.kill("SIGKILL");
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      });
      const responseFor = (id: string): Frame | undefined =>
        frames.find((f) => f.type === "response" && f.id === id);
      await waitFor(
        () => (frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
        60_000,
        "omp ready",
      );

      client.send({ id: "cancel-1", type: "cancel_subagent", subagentId: "no-such-agent" });
      const cancel = await waitFor(() => responseFor("cancel-1"), 30_000, "the cancel response");
      expect(cancel.success).toBe(true);
      expect(cancel.data?.cancelled).toBe(false);

      client.send({ id: "steer-1", type: "steer_subagent", subagentId: "no-such-agent", message: "hello" });
      const steer = await waitFor(() => responseFor("steer-1"), 30_000, "the steer response");
      expect(steer.success).toBe(false);
      expect(steer.error).toBe("Subagent not running: no-such-agent");
    },
  );
});
