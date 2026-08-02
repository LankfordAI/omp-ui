import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  resolveOmpBinary,
  writeAdvisorOverlay,
  writePlanExtension,
  writeAdvisorStatsExtension,
} from "@omp-ui/core";
import { ADVISOR_STATS_KEY } from "@omp-ui/core/advisor-stats";

/**
 * End-to-end proof that the advisor cost readout reaches the renderer collector
 * through the REAL generated extensions and the real `omp --mode=rpc-ui` binary
 * (no fork stub). Regression guard for the boot-arm + auto-publish path that
 * delivers `omp-ui:advisorStats` over `ui.setStatus`.
 *
 * These spawn real omp (~5–10 s each) and require a reachable binary, so they
 * skip cleanly when resolveOmpBinary fails (mirrors how the app resolves it) —
 * CI without omp does not fail.
 */

interface AdvisorFrame {
  text: string;
}

type Frame = { type: string; statusKey?: string; statusText?: string };

function sleep(ms: number): Promise<void> {
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe` until non-undefined or the timeout elapses. */
async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const ompPath = resolveOmpBinary();

interface Scope {
  base: string;
  lineage: string;
  frames: Frame[];
}

interface Harness {
  client: RpcClient;
  /** Advisor frames published by THIS process only (indexed from its spawn). */
  advisorFrames(): AdvisorFrame[];
  /** Any response frames from THIS process (indexed from its spawn). */
  seenResponse(): boolean;
  kill(): void;
}

function makeScope(): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-advlive-"));
  return { base, lineage: path.join(base, "lin"), frames: [] };
}

function spawnHarness(scope: Scope, resumeSessionId?: string): Harness {
  const extension = writeAdvisorStatsExtension(scope.lineage);
  const planExt = writePlanExtension(scope.lineage);
  const overlay = writeAdvisorOverlay(scope.lineage, null, true);
  if (!overlay) throw new Error("advisor overlay was not written");
  let killed = false;
  // Frames are shared across a scope (fresh + resumed processes), so each
  // harness only considers frames published at/after its own spawn.
  const fromIndex = scope.frames.length;
  const tail = scope.frames.slice(fromIndex);
  const client = new RpcClient({
    cwd: scope.base,
    lineageDir: scope.lineage,
    ompPath: ompPath!,
    resumeSessionId,
    advisor: true,
    configOverlays: [overlay],
    extensions: [planExt, extension],
    onFrame: (frame) => tail.push(frame as Frame),
    onExit: () => {},
    onError: () => {},
  });
  return {
    client,
    advisorFrames: () =>
      tail
        .filter((f) => f.type === "extension_ui_request" && f.statusKey === ADVISOR_STATS_KEY)
        .map((f) => ({ text: f.statusText ?? "" })),
    seenResponse: () => tail.some((f) => f.type === "response"),
    kill: () => {
      if (killed) return;
      killed = true;
      client.kill();
    },
  };
}

/** Extracts the session id from `<timestamp>_<id>.jsonl` in the lineage dir. */
function sessionIdFromLineage(lineage: string): string {
  const files = fs
    .readdirSync(lineage)
    .filter((f) => f.endsWith(".jsonl") && !f.includes(".jsonl."));
  if (files.length === 0) throw new Error("no session file in lineage dir");
  const newest = [...files].sort().at(-1)!;
  const id = path.basename(newest, ".jsonl").split("_").at(-1);
  if (!id) throw new Error(`cannot parse session id from ${newest}`);
  return id;
}

function assertAvailableCost(frames: AdvisorFrame[]): void {
  const latest = frames.at(-1);
  expect(latest).toBeTruthy();
  const parsed: unknown = JSON.parse(latest!.text);
  const view = parsed as Record<string, unknown>;
  expect(view.available).toBe(true);
  expect(typeof view.cost).toBe("number");
}

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe.skipIf(!ompPath)("advisor-stats live (real omp)", () => {
  it("publishes an available:true cost frame on a fresh boot arm", { timeout: 90000 }, async () => {
    const scope = makeScope();
    disposers.push(() => fs.rmSync(scope.base, { recursive: true, force: true }));
    const harness = spawnHarness(scope);
    try {
      await waitFor(() => (harness.seenResponse() ? true : undefined), 15000, "oauth ready response");
      harness.client.send({ type: "prompt", message: "/omp-ui-advisor-stats" });
      const frames = await waitFor(
        () => (harness.advisorFrames().length ? harness.advisorFrames() : undefined),
        15000,
        "advisor-stats frame after boot arm",
      );
      assertAvailableCost(frames);
    } finally {
      harness.kill();
    }
  });

  it("auto-publishes a fresh available:true frame after a real turn", { timeout: 90000 }, async () => {
    const scope = makeScope();
    disposers.push(() => fs.rmSync(scope.base, { recursive: true, force: true }));
    const harness = spawnHarness(scope);
    try {
      await waitFor(() => (harness.seenResponse() ? true : undefined), 15000, "oauth ready response");
      harness.client.send({ type: "prompt", message: "/omp-ui-advisor-stats" });
      await waitFor(
        () => (harness.advisorFrames().length ? harness.advisorFrames() : undefined),
        15000,
        "boot-arm advisor frame",
      );
      const before = harness.advisorFrames().length;
      harness.client.send({ type: "prompt", message: "just say ok" });
      const frames = await waitFor(
        () => (harness.advisorFrames().length > before ? harness.advisorFrames() : undefined),
        20000,
        "advisor-stats frame after a turn (auto-publish)",
      );
      assertAvailableCost(frames);
    } finally {
      harness.kill();
    }
  });

  it("shows the readout on --resume before any new turn", { timeout: 90000 }, async () => {
    const scope = makeScope();
    disposers.push(() => fs.rmSync(scope.base, { recursive: true, force: true }));
    const first = spawnHarness(scope);
    try {
      await waitFor(() => (first.seenResponse() ? true : undefined), 15000, "oauth ready response");
      // Run one real turn so the session materializes on disk — a session file
      // only appears after the first prompt, and --resume needs its id.
      first.client.send({ type: "prompt", message: "just say ok" });
      const sessionId = await waitFor(
        () => {
          try {
            return sessionIdFromLineage(scope.lineage);
          } catch {
            return undefined;
          }
        },
        10000,
        "oauth session file to materialize",
      );
      first.kill();
      // Kill is async from the child's perspective; omp flushes the session file
      // on exit. Give it a beat before re-spawning against the same session.
      await sleep(500);

      const resumed = spawnHarness(scope, sessionId);
      try {
        await waitFor(
          () => (resumed.seenResponse() ? true : undefined),
          15000,
          "oauth ready (resumed)",
        );
        resumed.client.send({ type: "prompt", message: "/omp-ui-advisor-stats" });
        const frames = await waitFor(
          () => (resumed.advisorFrames().length ? resumed.advisorFrames() : undefined),
          15000,
          "advisor-stats frame on --resume before a new turn",
        );
        assertAvailableCost(frames);
      } finally {
        resumed.kill();
      }
    } finally {
      first.kill();
    }
  });
});
