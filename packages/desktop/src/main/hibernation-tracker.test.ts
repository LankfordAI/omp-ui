import { describe, expect, it, vi, type Mock } from "vitest";
import type { Registry, RpcFrame } from "@omp-ui/core";
import { HibernationTracker, type HibernationTrackerDeps } from "./hibernation-tracker";
import type { LiveEntry } from "./live-entry";
import { TurnTracker } from "./turns";

const TAB = "tab-1";
/** hibernateIdleMinutes in the stub registry (matches the shipped default). */
const WINDOW = 30 * 60_000;

interface Harness {
  tracker: HibernationTracker;
  rpcSend: Mock<(cmd: Record<string, unknown>) => void>;
  hibernate: Mock<(tabId: string, entry: LiveEntry) => Promise<boolean>>;
}

/**
 * Regression net for issue #910, driven through the tracker's own deps:
 * the probe's fallback timer is owned by the tab record and an early
 * correlated response must clear it synchronously, leaving exactly one
 * pending handle — the re-armed idle window.
 */
function harness(): Harness {
  const rpcSend = vi.fn<(cmd: Record<string, unknown>) => void>();
  // A parked verdict must never reach the reap; calling it fails the test.
  const hibernate = vi.fn<(tabId: string, entry: LiveEntry) => Promise<boolean>>(async () => {
    throw new Error("hibernate must not be called on a parked verdict");
  });
  const entry = {
    kind: "rpc-ui",
    rpc: { send: rpcSend },
  } as unknown as LiveEntry;
  const registry = {
    getSetting: (key: string): number => (key === "hibernateIdleMinutes" ? 30 : 0),
    // TAB is not its project's last active session (issue #304): the sibling
    // carries a newer cachedModified than TAB's launchedAt recency fallback.
    sessions: [
      {
        tabId: "tab-newer",
        projectCwd: "/proj",
        launchedAt: "2026-07-29T09:00:00.000Z",
        cachedModified: "2026-07-29T12:00:00.000Z",
      },
      {
        tabId: TAB,
        projectCwd: "/proj",
        launchedAt: "2026-07-29T10:00:00.000Z",
        cachedModified: null,
      },
    ],
  } as unknown as Registry;
  const deps: HibernationTrackerDeps = {
    registry,
    send: () => {},
    broadcast: async () => {},
    turns: new TurnTracker(),
    getLive: (tabId) => (tabId === TAB ? entry : undefined),
    awaitingHumanAnswer: () => false,
    isViewed: () => false,
    preventsHibernation: () => false,
    hibernate,
    runSerialized: (_tabId, work) => work(),
  };
  return { tracker: new HibernationTracker(deps), rpcSend, hibernate };
}

/** The id of the get_state probe currently in flight, per the fake rpc. */
function lastProbeId(rpcSend: Harness["rpcSend"]): string {
  for (let i = rpcSend.mock.calls.length - 1; i >= 0; i -= 1) {
    const cmd = rpcSend.mock.calls[i]?.[0];
    if (cmd !== null && typeof cmd === "object" && "type" in cmd && "id" in cmd) {
      if (cmd.type === "get_state") return cmd.id as string;
    }
  }
  throw new Error("no get_state probe was sent");
}

describe("HibernationTracker timer lifecycle (issue #910)", () => {
  it("the early probe answer clears the 5 s fallback and leaves only the re-armed window", async () => {
    // Pinned fake set (#910): the assertions count EVERY pending fake timer,
    // so only setTimeout/clearTimeout/Date are taken over — no collaborator's
    // immediate or interval can pollute the census.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { tracker, rpcSend, hibernate } = harness();

      // The first frame arms the idle window; nothing else is pending.
      tracker.onFrame(TAB, { type: "agent_end" } as RpcFrame);
      expect(vi.getTimerCount()).toBe(1);

      // Window elapsed: the pre-kill probe goes out and arms its 5 s
      // fallback; the fired window timer is gone.
      await vi.advanceTimersByTimeAsync(WINDOW);
      expect(rpcSend).toHaveBeenCalledTimes(1);
      expect(rpcSend).toHaveBeenCalledWith({ type: "get_state", id: expect.any(String) });
      expect(vi.getTimerCount()).toBe(1);
      const probeId = lastProbeId(rpcSend);

      // The correlated answer (parked work → "rearm" verdict) settles the
      // probe: the fallback clears synchronously, and the drained attempt
      // re-arms exactly one window.
      tracker.onFrame(TAB, {
        type: "response",
        id: probeId,
        command: "get_state",
        success: true,
        data: { queuedMessageCount: 1, isStreaming: false, hasPendingAsyncWork: false },
      } as RpcFrame);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      expect(hibernate).not.toHaveBeenCalled();

      // The re-armed window elapses: a fresh probe, still no reap.
      await vi.advanceTimersByTimeAsync(WINDOW);
      expect(rpcSend).toHaveBeenCalledTimes(2);
      expect(rpcSend.mock.calls[1]![0]).toMatchObject({ type: "get_state" });
      expect(hibernate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
