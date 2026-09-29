import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  resolveOmpBinary,
  writePlanExtension,
  writeSideQuestionsExtension,
} from "@omp-ui/core";
import {
  BTW_STATUS_KEY,
  btwAskMessage,
  btwRefreshMessage,
  parseBtwRecord,
  parseBtwSnapshot,
  type BtwSnapshot,
} from "@omp-ui/core/side-questions";

/**
 * End-to-end proof that the `/btw` bridge (issue #682) loads into the REAL
 * `omp --mode=rpc-ui`, arms, and publishes a well-formed snapshot over
 * `ui.setStatus` without touching the transcript. The full ask round trip
 * needs a live model, so it skips itself when the environment has none (the
 * bridge then reports omp's own "No active model" sentence).
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

interface Harness {
  client: RpcClient;
  frames: Frame[];
  snapshots(): BtwSnapshot[];
  kill(): Promise<void>;
}

const disposers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function spawnHarness(): { harness: Harness; lineage: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-btwlive-"));
  const lineage = path.join(base, "lin");
  const frames: Frame[] = [];
  let exited = false;
  const client = new RpcClient({
    cwd: base,
    lineageDir: lineage,
    ompPath: ompPath!,
    extensions: [writePlanExtension(lineage), writeSideQuestionsExtension(lineage)],
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
        .filter((f) => f.type === "extension_ui_request" && f.statusKey === BTW_STATUS_KEY)
        .map((f) => parseBtwSnapshot(f.statusText))
        .filter((s): s is BtwSnapshot => s !== null),
    kill: async () => {
      client.kill();
      // The exit itself is the signal; escalate rather than hang.
      const deadline = Date.now() + 8_000;
      while (!exited && Date.now() < deadline) await sleep(100);
      if (!exited) client.kill("SIGKILL");
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  disposers.push(() => harness.kill());
  return { harness, lineage };
}

describe.skipIf(!ompPath)("side-questions live (real omp)", () => {
  it("loads, publishes an available snapshot on refresh, and leaves the transcript alone", { timeout: 120000 }, async () => {
    const { harness } = spawnHarness();
    await waitFor(
      () => (harness.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
      60_000,
      "omp ready",
    );
    harness.client.send({ type: "prompt", message: btwRefreshMessage({ requestId: "live-1" }) });
    const snapshot = await waitFor(() => harness.snapshots().at(-1), 30_000, "btw snapshot after refresh");
    expect(snapshot).toMatchObject({ available: true, active: null, topics: [] });
    // The hidden command is consumed before any user item: nothing from the
    // bridge line reached the model or the transcript.
    const userItems = harness.frames.filter(
      (f) => (f.type === "message_start" || f.type === "message_end") && f.message?.role === "user",
    );
    expect(userItems).toEqual([]);
  });

  it("answers a side question into btw-history without a transcript row (needs a live model)", { timeout: 180000 }, async (ctx) => {
    const { harness, lineage } = spawnHarness();
    await waitFor(
      () => (harness.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
      60_000,
      "omp ready",
    );
    harness.client.send({
      type: "prompt",
      message: btwAskMessage({ requestId: "live-2", question: "Reply with the single word: pong" }),
    });
    const settled = await waitFor(
      () => harness.snapshots().find((s) => s.topics[0] !== undefined && s.topics[0].status !== "running"),
      120_000,
      "the side question to settle",
    );
    const topic = settled.topics[0];
    const userItems = harness.frames.filter(
      (f) => (f.type === "message_start" || f.type === "message_end") && f.message?.role === "user",
    );
    expect(userItems).toEqual([]);

    // The history file is omp's own grammar, whatever the turn's outcome.
    const dirs = fs.readdirSync(lineage).filter((name) => fs.statSync(path.join(lineage, name)).isDirectory());
    const files = dirs.flatMap((dir) => {
      const history = path.join(lineage, dir, "btw-history");
      return fs.existsSync(history) ? fs.readdirSync(history).map((name) => path.join(history, name)) : [];
    });
    expect(files).toHaveLength(1);
    await waitFor(
      () => {
        const record = parseBtwRecord(fs.readFileSync(files[0], "utf8"));
        return record !== null && record.status === topic.status ? record : undefined;
      },
      10_000,
      "the history file to settle",
    );

    if (topic.status !== "complete") return ctx.skip(`no live model in this environment: ${topic.error ?? topic.status}`);
    expect(topic.answer.trim()).not.toBe("");
  });
});
