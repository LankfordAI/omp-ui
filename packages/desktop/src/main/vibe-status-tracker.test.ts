import { describe, expect, it } from "vitest";
import { VIBE_STATUS_KEY, type RpcFrame, type VibeSnapshot, type VibeWorker } from "@omp-ui/core";
import { VibeStatusTracker } from "./vibe-status-tracker";

const WORKER: VibeWorker = {
  id: "BriskFalcon",
  cli: "fast",
  state: "running",
  killed: false,
  model: "vllm/qwen:medium",
  turns: 1,
  queued: 0,
  turnMessage: null,
  currentTool: null,
  lastIntent: null,
  createdAt: 1,
};

function snapshot(overrides: Partial<VibeSnapshot> = {}): VibeSnapshot {
  return {
    version: 1,
    processKey: "proc-a",
    sessionId: "session-1",
    revision: 1,
    available: true,
    unavailable: null,
    enabled: true,
    workers: [{ ...WORKER }],
    result: null,
    ...overrides,
  };
}

function statusFrame(value: VibeSnapshot | string): RpcFrame {
  return {
    type: "extension_ui_request",
    id: "frame-1",
    method: "setStatus",
    statusKey: VIBE_STATUS_KEY,
    statusText: typeof value === "string" ? value : JSON.stringify(value),
  } as RpcFrame;
}

function tracker(): { vibes: VibeStatusTracker; broadcasts: () => number } {
  let broadcasts = 0;
  const vibes = new VibeStatusTracker({
    broadcast: () => {
      broadcasts += 1;
      return Promise.resolve();
    },
  });
  return { vibes, broadcasts: () => broadcasts };
}

describe("VibeStatusTracker", () => {
  it("keeps the newest snapshot from one bridge and drops an older revision", () => {
    const { vibes } = tracker();
    vibes.onFrame("tab", statusFrame(snapshot({ revision: 4 })));
    expect(vibes.snapshot("tab")?.revision).toBe(4);
    vibes.onFrame("tab", statusFrame(snapshot({ revision: 3 })));
    expect(vibes.snapshot("tab")?.revision).toBe(4);
    vibes.onFrame(
      "tab",
      statusFrame(snapshot({ revision: 5, workers: [{ ...WORKER, id: "CalmOtter", state: "idle" }] })),
    );
    expect(vibes.snapshot("tab")?.workers[0]?.id).toBe("CalmOtter");
  });

  it("accepts a replacement process and drops the retired generation's late frames", () => {
    const { vibes } = tracker();
    vibes.onFrame("tab", statusFrame(snapshot({ processKey: "proc-a", revision: 9 })));
    vibes.onFrame("tab", statusFrame(snapshot({ processKey: "proc-b", revision: 1 })));
    expect(vibes.snapshot("tab")?.processKey).toBe("proc-b");
    vibes.onFrame("tab", statusFrame(snapshot({ processKey: "proc-a", revision: 99 })));
    expect(vibes.snapshot("tab")?.processKey).toBe("proc-b");
  });

  it("keeps the last good snapshot when a publish is malformed", () => {
    const { vibes } = tracker();
    vibes.onFrame("tab", statusFrame(snapshot()));
    vibes.onFrame("tab", statusFrame("{not json"));
    expect(vibes.snapshot("tab")?.workers[0]?.id).toBe("BriskFalcon");
    expect(vibes.preventsHibernation("tab")).toBe(true);
  });

  it("vetoes hibernation only for workers that can still move", () => {
    const { vibes } = tracker();
    vibes.onFrame("tab", statusFrame(snapshot({ revision: 1, enabled: false, workers: [] })));
    expect(vibes.preventsHibernation("tab")).toBe(false);

    // An idle parked roster (mode off, restored) owns no loop.
    vibes.onFrame(
      "tab",
      statusFrame(
        snapshot({
          revision: 2,
          enabled: false,
          workers: [{ ...WORKER, state: "parked", turns: 3, queued: 0 }],
        }),
      ),
    );
    expect(vibes.preventsHibernation("tab")).toBe(false);

    // A queued follow-up counts as live work even while the row reads idle.
    vibes.onFrame(
      "tab",
      statusFrame(
        snapshot({
          revision: 3,
          enabled: true,
          workers: [{ ...WORKER, state: "idle", queued: 1 }],
        }),
      ),
    );
    expect(vibes.preventsHibernation("tab")).toBe(true);

    // Killed tombstones are kept for the roster but own nothing.
    vibes.onFrame(
      "tab",
      statusFrame(
        snapshot({
          revision: 4,
          enabled: true,
          workers: [{ ...WORKER, state: "dead", killed: true, turns: 2, queued: 0 }],
        }),
      ),
    );
    expect(vibes.preventsHibernation("tab")).toBe(false);
  });

  it("clears on exit and dispose", () => {
    const { vibes } = tracker();
    vibes.onFrame("tab", statusFrame(snapshot()));
    expect(vibes.preventsHibernation("tab")).toBe(true);
    vibes.onExit("tab");
    expect(vibes.snapshot("tab")).toBeUndefined();
    expect(vibes.preventsHibernation("tab")).toBe(false);
    vibes.onFrame("tab", statusFrame(snapshot({ revision: 2 })));
    vibes.dispose("tab");
    expect(vibes.snapshot("tab")).toBeUndefined();
  });
});
