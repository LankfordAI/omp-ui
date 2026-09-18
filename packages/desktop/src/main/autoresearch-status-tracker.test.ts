import { describe, expect, it } from "vitest";
import { AUTORESEARCH_STATUS_KEY, type AutoresearchSnapshot, type RpcFrame } from "@omp-ui/core";
import { AutoresearchStatusTracker } from "./autoresearch-status-tracker";

function snapshot(overrides: Partial<AutoresearchSnapshot> = {}): AutoresearchSnapshot {
  return {
    version: 1,
    processKey: "proc-a",
    sessionId: "session-1",
    revision: 1,
    available: true,
    unavailable: null,
    mode: "on",
    goal: "reduce p95 latency",
    goalTruncated: false,
    lastTool: null,
    proposeUnavailable: null,
    ...overrides,
  };
}

function statusFrame(value: AutoresearchSnapshot | string): RpcFrame {
  return {
    type: "extension_ui_request",
    id: "frame-1",
    method: "setStatus",
    statusKey: AUTORESEARCH_STATUS_KEY,
    statusText: typeof value === "string" ? value : JSON.stringify(value),
  } as RpcFrame;
}

function tracker(): { autoresearch: AutoresearchStatusTracker; broadcasts: () => number } {
  let broadcasts = 0;
  const autoresearch = new AutoresearchStatusTracker({
    broadcast: () => {
      broadcasts += 1;
      return Promise.resolve();
    },
  });
  return { autoresearch, broadcasts: () => broadcasts };
}

/** Drains the tracker's fire-and-forget broadcasts. */
async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AutoresearchStatusTracker", () => {
  it("keeps the newest snapshot from one bridge and drops an older revision", () => {
    const { autoresearch } = tracker();
    autoresearch.onFrame("tab", statusFrame(snapshot({ revision: 4 })));
    expect(autoresearch.snapshot("tab")?.revision).toBe(4);
    autoresearch.onFrame("tab", statusFrame(snapshot({ revision: 3, mode: "off" })));
    expect(autoresearch.snapshot("tab")?.mode).toBe("on");
    autoresearch.onFrame("tab", statusFrame(snapshot({ revision: 5, mode: "off" })));
    expect(autoresearch.snapshot("tab")?.mode).toBe("off");
  });

  it("accepts a replacement process and drops the retired generation's late frames", () => {
    const { autoresearch } = tracker();
    autoresearch.onFrame("tab", statusFrame(snapshot({ processKey: "proc-a", revision: 9 })));
    autoresearch.onFrame("tab", statusFrame(snapshot({ processKey: "proc-b", revision: 1 })));
    expect(autoresearch.snapshot("tab")?.processKey).toBe("proc-b");
    // A frame still in flight from the killed spawn cannot outvote the successor,
    // no matter how high its own counter runs.
    autoresearch.onFrame("tab", statusFrame(snapshot({ processKey: "proc-a", revision: 99 })));
    expect(autoresearch.snapshot("tab")?.processKey).toBe("proc-b");
  });

  it("keeps the last good snapshot when a publish is malformed", () => {
    const { autoresearch } = tracker();
    autoresearch.onFrame("tab", statusFrame(snapshot()));
    autoresearch.onFrame("tab", statusFrame("{not json"));
    autoresearch.onFrame("tab", statusFrame(JSON.stringify({ ...snapshot({ revision: 2 }), mode: "maybe" })));
    expect(autoresearch.snapshot("tab")?.goal).toBe("reduce p95 latency");
    expect(autoresearch.snapshot("tab")?.revision).toBe(1);
  });

  it("broadcasts only when the accepted state actually changes", async () => {
    const { autoresearch, broadcasts } = tracker();
    autoresearch.onFrame("tab", statusFrame(snapshot()));
    await drain();
    expect(broadcasts()).toBe(1);
    autoresearch.onFrame("tab", statusFrame(snapshot()));
    await drain();
    expect(broadcasts()).toBe(1);
    autoresearch.onFrame("tab", statusFrame(snapshot({ revision: 2, mode: "off" })));
    await drain();
    expect(broadcasts()).toBe(2);
  });

  it("ignores another bridge's status channel entirely", () => {
    const { autoresearch } = tracker();
    autoresearch.onFrame("tab", {
      type: "extension_ui_request",
      id: "x",
      method: "setStatus",
      statusKey: "omp-ui:goal",
      statusText: JSON.stringify(snapshot()),
    } as RpcFrame);
    expect(autoresearch.snapshot("tab")).toBeUndefined();
  });

  it("clears on exit and dispose so a dead process leaves no chip behind", async () => {
    const { autoresearch, broadcasts } = tracker();
    autoresearch.onFrame("tab", statusFrame(snapshot()));
    autoresearch.onExit("tab");
    await drain();
    expect(autoresearch.snapshot("tab")).toBeUndefined();
    expect(broadcasts()).toBe(2);
    autoresearch.dispose("tab");
    await drain();
    // Nothing left to clear: no redundant broadcast.
    expect(broadcasts()).toBe(2);
  });
});
