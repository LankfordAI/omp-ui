// Settle and its undo (issue #980).
import { beforeEach, describe, expect, it } from "vitest";
import type { BackendState, SessionSummary } from "@omp-ui/core/types";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

const OTHER = "tab-other";

/** The harness record plus a second session, each patchable. */
function twoSessions(
  first: Partial<SessionSummary> = {},
  second: Partial<SessionSummary> = {},
): BackendState {
  const state = h.stateWithRecord("sess-1", "live");
  const base = state.projects[0]!.sessions[0]!;
  state.projects[0]!.sessions = [
    { ...base, ...first },
    { ...base, tabId: OTHER, sessionId: "sess-2", title: "Other", ...second },
  ];
  return state;
}

const store = () => h.useStore.getState();

beforeEach(() => {
  h.useStore.setState({ settleUndo: [], settleToastId: null });
});

describe("settleSessions (issue #980)", () => {
  it("settles an idle live session as one undo entry and shows the toast", async () => {
    h.useStore.setState({ state: twoSessions() });

    await store().settleSessions([h.TAB]);

    expect(h.mockBackend.settleSession).toHaveBeenCalledWith(h.TAB);
    expect(store().settleUndo).toHaveLength(1);
    expect(store().settleUndo[0]!.sessions.map((s) => s.tabId)).toEqual([h.TAB]);
    expect(store().settleToastId).toBe(store().settleUndo[0]!.id);
  });

  it("never settles a session mid-turn — by the host latch or this renderer's own turn", async () => {
    h.useStore.setState({
      state: twoSessions({ turnRunning: true }),
      rpc: { [OTHER]: rpcTabState({ status: "running" }) },
    });

    await store().settleSessions([h.TAB, OTHER]);

    expect(h.mockBackend.settleSession).not.toHaveBeenCalled();
    expect(store().settleUndo).toEqual([]);
    expect(store().settleToastId).toBeNull();
  });

  it("settles a dormant row only to take it out of Snoozed, and only while the section is on", async () => {
    const state = twoSessions({ live: "dormant", snoozed: true }, { live: "dormant" });
    h.useStore.setState({ state: { ...state, snoozedSectionEnabled: false } });
    await store().settleSessions([h.TAB, OTHER]);
    expect(h.mockBackend.settleSession).not.toHaveBeenCalled();

    h.useStore.setState({ state: { ...state, snoozedSectionEnabled: true } });
    await store().settleSessions([h.TAB, OTHER]);
    expect(h.mockBackend.settleSession.mock.calls).toEqual([[h.TAB]]);
  });

  it("records no undo for a settle main skipped, and says so", async () => {
    h.useStore.setState({ state: twoSessions() });
    h.mockBackend.settleSession.mockResolvedValueOnce(false);

    await store().settleSessions([h.TAB]);

    expect(store().settleUndo).toEqual([]);
    expect(h.errorMessages()).toHaveLength(1);
  });
});

describe("undoSettle (issue #980)", () => {
  it("has nothing to undo before any settle", () => {
    expect(store().undoSettle()).toBe(false);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
  });

  it("undoes a bulk settle as one entry: resumes every session and restores its snooze", async () => {
    h.useStore.setState({
      state: twoSessions({ snoozed: true, snoozedUntilMs: 123 }),
      tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p" })],
    });
    await store().settleSessions([h.TAB, OTHER]);
    expect(store().settleUndo).toHaveLength(1);
    // Main reaped both and cleared the snooze.
    h.useStore.setState({ state: twoSessions({ live: "dormant" }, { live: "dormant" }) });

    expect(store().undoSettle()).toBe(true);
    await h.flushMicrotasks();
    await h.flushMicrotasks();

    expect(store().settleUndo).toEqual([]);
    expect(store().settleToastId).toBeNull();
    expect(h.mockBackend.setSessionSnoozed).toHaveBeenCalledWith(h.TAB, true, 123);
    const resumed = h.mockBackend.spawnSession.mock.calls.map(
      (call) => (call as unknown as [{ origin: string; resumeTabId: string }])[0],
    );
    expect(resumed.map((r) => [r.origin, r.resumeTabId])).toEqual([
      ["resume", h.TAB],
      ["resume", OTHER],
    ]);
    // A second Mod+Z has nothing left.
    expect(store().undoSettle()).toBe(false);
  });

  it("undoes newest first and skips a session already resumed by hand", async () => {
    h.useStore.setState({ state: twoSessions() });
    await store().settleSessions([h.TAB]);
    await store().settleSessions([OTHER]);
    // OTHER was resumed by hand before the undo.
    h.useStore.setState({ state: twoSessions({ live: "dormant" }, { live: "live" }) });

    expect(store().undoSettle()).toBe(true);
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(store().settleUndo.map((e) => e.sessions[0]!.tabId)).toEqual([h.TAB]);
  });
});
