// resyncAfterReconnect (issue #890): after a browser socket re-pairs, the store
// refetches authoritative state and re-boots every visible live rpc-ui tab so
// missed frames are re-derived from omp — without a location.reload().
import { describe, expect, it } from "vitest";
import { tabInfo } from "./test/fixtures";
import { h } from "./test/store-harness";

function stateWith(rows: Array<{ tabId: string; mode: "pty" | "rpc-ui"; live: "live" | "dormant" }>) {
  const base = h.stateWithRecord("sid-1", "live");
  const template = base.projects[0]!.sessions[0]!;
  const sessions = rows.map((row) => ({
    ...template,
    tabId: row.tabId,
    mode: row.mode,
    live: row.live,
  }));
  return {
    ...base,
    projects: [{ ...base.projects[0]!, sessions }],
  };
}

describe("resyncAfterReconnect (issue #890)", () => {
  it("re-boots a visible live rpc-ui tab through its boot commands", async () => {
    h.backendState = stateWith([{ tabId: h.TAB, mode: "rpc-ui", live: "live" }]);
    h.useStore.setState({
      state: h.backendState,
      tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p" })],
    });

    await h.useStore.getState().resyncAfterReconnect();
    await h.flushMicrotasks();

    // The observable boot machinery: rpcCommand frames on the tab's socket.
    const booted = h.sent.filter((s) => s.tabId === h.TAB);
    expect(booted.length).toBeGreaterThan(0);
  });

  it("leaves a dormant record and a pty tab untouched", async () => {
    h.backendState = stateWith([
      { tabId: "rpc-dormant", mode: "rpc-ui", live: "dormant" },
      { tabId: "pty-live", mode: "pty", live: "live" },
    ]);
    h.useStore.setState({
      state: h.backendState,
      tabs: [
        tabInfo({ tabId: "rpc-dormant", mode: "rpc-ui", projectCwd: "/p" }),
        tabInfo({ tabId: "pty-live", mode: "pty", projectCwd: "/p" }),
      ],
    });

    await h.useStore.getState().resyncAfterReconnect();
    await h.flushMicrotasks();

    expect(h.sent.filter((s) => s.tabId === "rpc-dormant")).toEqual([]);
    expect(h.sent.filter((s) => s.tabId === "pty-live")).toEqual([]);
  });

  it("swallows a refetch failure — the next status(true) re-runs the resync", async () => {
    h.mockBackend.getState.mockRejectedValueOnce(new Error("remote connection lost"));
    h.useStore.setState({ tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui" })] });

    await expect(h.useStore.getState().resyncAfterReconnect()).resolves.toBeUndefined();
    expect(h.sent).toEqual([]);
  });
});
