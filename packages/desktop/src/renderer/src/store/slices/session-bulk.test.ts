// Bulk sidebar actions (issue #988).
import { describe, expect, it } from "vitest";
import type { BackendState, SessionSummary } from "@omp-ui/core/types";
import { rpcTabState } from "../../test/fixtures";
import { h } from "../../test/store-harness";

/** The harness record plus extra sessions, each patchable. */
function sessions(...rows: Array<Partial<SessionSummary> & { tabId: string }>): BackendState {
  const state = h.stateWithRecord("sess-1", "live");
  const base = state.projects[0]!.sessions[0]!;
  state.projects[0]!.sessions = rows.map((row) => ({ ...base, sessionId: `sess-${row.tabId}`, title: row.tabId, ...row }));
  return state;
}

const store = () => h.useStore.getState();

describe("deleteSessions (issue #988)", () => {
  it("asks once for every row, then erases each and drops every deleted tab", async () => {
    h.useStore.setState({ state: sessions({ tabId: "a" }, { tabId: "b", live: "dormant" }) });

    await store().deleteSessions(["a", "b"]);
    expect(h.mockBackend.deleteSession).not.toHaveBeenCalled();
    expect(store().bulkDeleteConfirmation?.rows.map((r) => [r.tabId, r.running])).toEqual([
      ["a", true],
      ["b", false],
    ]);

    await store().confirmDeleteSessions(false);
    expect(h.mockBackend.deleteSession.mock.calls).toEqual([
      ["a", false],
      ["b", false],
    ]);
    expect(store().bulkDeleteConfirmation).toBeNull();
  });

  it("leaves a selected plan descendant to its source's cascade", async () => {
    h.useStore.setState({ state: sessions({ tabId: "plan" }, { tabId: "impl" }) });
    // Previews resolve in selection order: "plan" first, then "impl".
    h.mockBackend.deleteSessionPreview
      .mockResolvedValueOnce({ descendants: [{ tabId: "impl", title: "impl", running: true, worktree: false }] })
      .mockResolvedValueOnce({ descendants: [] });

    await store().deleteSessions(["plan", "impl"]);
    expect(store().bulkDeleteConfirmation?.rows.map((r) => r.tabId)).toEqual(["plan"]);
    await store().confirmDeleteSessions(false);
    expect(h.mockBackend.deleteSession.mock.calls).toEqual([["plan", true]]);
  });

  it("reports every failed row together in one notice, in selection order", async () => {
    h.useStore.setState({ state: sessions({ tabId: "a" }, { tabId: "b" }, { tabId: "c" }) });
    // Calls run in selection order: a, b, c.
    h.mockBackend.deleteSession
      .mockRejectedValueOnce(new Error("files locked"))
      .mockResolvedValueOnce({ deleted: ["b"], failed: [] })
      .mockRejectedValueOnce(new Error("host unreachable"));

    await store().deleteSessions(["a", "b", "c"]);
    await store().confirmDeleteSessions(false);

    expect(h.errorMessages()).toEqual(["2 of 3 sessions failed:\na: files locked\nc: host unreachable"]);
  });

  it("skips the dialog only when the opt-out covers every row", async () => {
    const state = sessions(
      { tabId: "a" },
      { tabId: "wt", worktree: { path: "/w/wt", branch: "omp-ui/wt", base: null } },
    );
    h.useStore.setState({ state: { ...state, skipDeleteConfirmation: true } });

    await store().deleteSessions(["a", "wt"]);
    expect(store().bulkDeleteConfirmation).not.toBeNull();
    expect(h.mockBackend.deleteSession).not.toHaveBeenCalled();

    h.useStore.setState({ bulkDeleteConfirmation: null });
    await store().deleteSessions(["a"]);
    // One row takes the single-delete path, which the opt-out covers.
    expect(h.mockBackend.deleteSession.mock.calls).toEqual([["a", false]]);
  });
});

describe("snoozeSessions / retitleSessions (issue #988)", () => {
  it("snoozes only the rows not already snoozed, keeping the two-argument call for an indefinite snooze", async () => {
    const state = sessions({ tabId: "a" }, { tabId: "b", snoozed: true });
    h.useStore.setState({ state: { ...state, snoozedSectionEnabled: true } });

    await store().snoozeSessions(["a", "b"], null);
    expect(h.mockBackend.setSessionSnoozed.mock.calls).toEqual([["a", true]]);
  });

  it("retitles only live native rows this window runs", async () => {
    h.useStore.setState({
      state: sessions({ tabId: "a" }, { tabId: "b", live: "dormant" }, { tabId: "c", mode: "pty" }),
      rpc: {},
    });
    const regenerate = h.useStore.getState().regenerateSessionTitle;
    const asked: string[] = [];
    h.useStore.setState({
      regenerateSessionTitle: async (tabId: string) => {
        asked.push(tabId);
      },
    });
    // No rpc slot for "a" yet: nothing this window can run /rename through.
    await store().retitleSessions(["a", "b", "c"]);
    expect(asked).toEqual([]);

    // A pty row never retitles, even with a slot; a dormant row has no process.
    h.useStore.setState({ rpc: { a: rpcTabState(), b: rpcTabState(), c: rpcTabState() } });
    await store().retitleSessions(["a", "b", "c"]);
    expect(asked).toEqual(["a"]);
    h.useStore.setState({ regenerateSessionTitle: regenerate });
  });
});
