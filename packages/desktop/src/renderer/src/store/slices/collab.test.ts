// The live-share slice (issue #686): the privacy gate, the optimistic chip a
// share leaves behind, the registry mirror's shape, and the per-tab teardown
// that retires a dead process's share state.
import { describe, expect, it } from "vitest";
import type { CollabTabState } from "@omp-ui/core/collab";
import { tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

function state(patch: Partial<CollabTabState> = {}): CollabTabState {
  return {
    status: "full",
    generation: 1,
    participants: 0,
    relayConnected: true,
    inputRequired: false,
    ...patch,
  };
}

function setup(): void {
  h.useStore.setState({ tabs: [tabInfo({ tabId: h.TAB, mode: "pty" })] });
}

describe("collab slice", () => {
  it("gates a first live share on the privacy dialog and starts on confirm", async () => {
    setup();
    const started = h.useStore.getState().startCollab(h.TAB, "full");
    await started;
    expect(h.mockBackend.collabShare).not.toHaveBeenCalled();
    expect(h.useStore.getState().shareLiveConfirmTab).toEqual({ tabId: h.TAB, access: "full" });

    h.useStore.getState().confirmShareLivePrivacy();
    await h.flushMicrotasks();
    expect(h.mockBackend.collabShare).toHaveBeenCalledWith(h.TAB, "full");
    expect(h.useStore.getState().shareLiveConfirmTab).toBeNull();
    // Optimistic until the registry poll replaces it.
    expect(h.useStore.getState().collab[h.TAB]).toEqual({
      kind: "sharing",
      state: { status: "full", generation: 0, participants: 0, relayConnected: true, inputRequired: false },
    });
    // The flag persists: the next share goes straight through.
    await h.useStore.getState().startCollab(h.TAB, "view");
    expect(h.useStore.getState().collab[h.TAB]?.kind).toBe("sharing");
  });

  it("a share failure lands in the error notices and leaves the tab off", async () => {
    setup();
    window.localStorage.setItem("omp-ui.sharePrivacySeen", "1");
    h.mockBackend.collabShare.mockRejectedValueOnce(new Error("not a live terminal tab"));
    await h.useStore.getState().startCollab(h.TAB, "full");
    expect(h.useStore.getState().collab[h.TAB]).toBeUndefined();
    expect(h.useStore.getState().errorNotices.some((n) => n.message.includes("not a live"))).toBe(
      true,
    );
  });

  it("mirrors the registry: a row is sharing, its absence is off", () => {
    setup();
    h.useStore.getState().applyCollabState(h.TAB, state({ participants: 2 }));
    expect(h.useStore.getState().collab[h.TAB]).toEqual({
      kind: "sharing",
      state: state({ participants: 2 }),
    });
    h.useStore.getState().applyCollabState(h.TAB, null);
    expect(h.useStore.getState().collab[h.TAB]).toEqual({ kind: "off" });
  });

  it("links ride the backend and refuse through the error notices", async () => {
    setup();
    await expect(h.useStore.getState().collabLink(h.TAB, true)).resolves.toBe(
      "https://my.omp.sh/s#k",
    );
    expect(h.mockBackend.collabLink).toHaveBeenCalledWith(h.TAB, true);
    h.mockBackend.collabLink.mockRejectedValueOnce(new Error("no active Collab host"));
    await expect(h.useStore.getState().collabLink(h.TAB, false)).rejects.toThrow("no active");
    expect(h.useStore.getState().errorNotices.some((n) => n.message.includes("no active"))).toBe(
      true,
    );
  });

  it("deleting a tab's session retires its share state and dialog", async () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "live"),
      tabs: [tabInfo({ tabId: h.TAB, mode: "pty" })],
      activeTabId: h.TAB,
    });
    h.useStore.getState().applyCollabState(h.TAB, state());
    h.useStore.getState().openShareLive(h.TAB);
    expect(h.useStore.getState().shareLiveTab).toBe(h.TAB);
    // Tab removal: the registry row died with the pid; the chip and the
    // dialog describing it retire with the tab, never haunting a reused id.
    await h.useStore.getState().deleteSession(h.TAB);
    await h.useStore.getState().confirmDeleteSession(false);
    expect(h.useStore.getState().shareLiveTab).toBeNull();
    expect(h.useStore.getState().collab[h.TAB]).toBeUndefined();
  });

  it("a dialog closes without touching the tab's share state", () => {
    setup();
    h.useStore.getState().applyCollabState(h.TAB, state());
    h.useStore.getState().openShareLive(h.TAB);
    h.useStore.getState().closeShareLive();
    expect(h.useStore.getState().shareLiveTab).toBeNull();
    expect(h.useStore.getState().collab[h.TAB]?.kind).toBe("sharing");
  });
});
