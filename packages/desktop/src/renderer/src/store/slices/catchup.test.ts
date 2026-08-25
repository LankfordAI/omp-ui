import { beforeEach, describe, expect, it } from "vitest";
import { ADVISOR_STATS_KEY } from "@omp-ui/core/advisor-stats";
import { CATCHUP_THRESHOLD_MS } from "../../lib/catchup";
import type { RenderItem } from "../../lib/transcript";
import {
  backendState as makeBackendState,
  rpcTabState,
  tabInfo,
} from "../../test/fixtures";
import { h } from "../../test/store-harness";

describe("catch-up digest (issue #273)", () => {
  const AWAY = CATCHUP_THRESHOLD_MS + 60_000;
  const items = (): RenderItem[] => {
    // In-window: the staging baseline is ~16 minutes back, so the items
    // must post-date it or the digest window excludes them.
    const at = Date.now() - 10 * 60_000;
    return [
      { kind: "user", id: "u1", text: "hello", timestamp: at },
      {
        kind: "assistant",
        id: "a1",
        text: "hi",
        thinking: "",
        streaming: false,
        stopReason: "stop",
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 0.25 },
        timestamp: at + 1000,
      },
    ];
  };

  beforeEach(async () => {
    // Installs the activation watcher once per module; later calls no-op.
    await h.useStore.getState().init();
  });

  it("stages and settles from a stale in-memory baseline on a mounted tab", () => {
    const since = Date.now() - AWAY;
    h.useStore.setState({
      state: h.stateWithRecord("sess-1"),
      tabs: [tabInfo({ tabId: h.TAB }), tabInfo({ tabId: "tab-b" })],
      activeTabId: "tab-b",
      rpc: { [h.TAB]: rpcTabState({ items: items() }) },
      lastActiveAt: { [h.TAB]: since },
    });
    h.useStore.getState().focusTab(h.TAB);
    const entry = h.useStore.getState().catchup[h.TAB];
    expect(entry).toMatchObject({ since, settled: true });
    expect(entry?.digest).toMatchObject({
      turns: [{ prompt: "hello", outcome: "completed" }],
      cost: 0.25,
      tokens: { input: 100, output: 50, cacheRead: 0 },
      advisor: null,
      pendingPlan: null,
    });
  });

  it("falls back to the persisted lastViewedAt and settles an empty window to a null digest", () => {
    const state = h.stateWithRecord("sess-1");
    const rec = state.projects[0]!.sessions[0]!;
    const iso = new Date(Date.now() - AWAY).toISOString();
    rec.lastViewedAt = iso;
    h.useStore.setState({
      state,
      tabs: [tabInfo({ tabId: h.TAB })],
      activeTabId: null,
      rpc: { [h.TAB]: rpcTabState() },
    });
    h.useStore.getState().focusTab(h.TAB);
    const entry = h.useStore.getState().catchup[h.TAB];
    expect(entry).toMatchObject({ since: Date.parse(iso), settled: true, digest: null });
  });

  it("falls back to launchedAt when lastViewedAt is absent", () => {
    const state = h.stateWithRecord("sess-1");
    const rec = state.projects[0]!.sessions[0]!;
    rec.lastViewedAt = null;
    const iso = new Date(Date.now() - AWAY).toISOString();
    rec.launchedAt = iso;
    h.useStore.setState({
      state,
      tabs: [tabInfo({ tabId: h.TAB })],
      activeTabId: null,
      rpc: { [h.TAB]: rpcTabState() },
    });
    h.useStore.getState().focusTab(h.TAB);
    expect(h.useStore.getState().catchup[h.TAB]).toMatchObject({
      since: Date.parse(iso),
      settled: true,
      digest: null,
    });
  });

  it("does not stage under the threshold, but still records the activation", () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1"),
      tabs: [tabInfo({ tabId: h.TAB })],
      activeTabId: null,
      rpc: { [h.TAB]: rpcTabState() },
      lastActiveAt: { [h.TAB]: Date.now() - 60_000 },
    });
    h.useStore.getState().focusTab(h.TAB);
    expect(h.useStore.getState().catchup).toEqual({});
    const active = h.useStore.getState().lastActiveAt[h.TAB];
    expect(active).toBeTypeOf("number");
    expect(Date.now() - active).toBeLessThan(5_000);
  });

  it("never stages for terminal tabs", () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1"),
      tabs: [tabInfo({ tabId: h.TAB, mode: "pty" })],
      activeTabId: null,
      lastActiveAt: { [h.TAB]: Date.now() - AWAY },
    });
    h.useStore.getState().focusTab(h.TAB);
    expect(h.useStore.getState().catchup).toEqual({});
  });

  it("does not stage when neither a record nor an in-memory baseline exists", () => {
    h.useStore.setState({
      state: makeBackendState(),
      tabs: [tabInfo({ tabId: h.TAB })],
      activeTabId: null,
      rpc: { [h.TAB]: rpcTabState() },
    });
    h.useStore.getState().focusTab(h.TAB);
    expect(h.useStore.getState().catchup).toEqual({});
  });

  it("includes advisor totals already in the slot at settle time", () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1"),
      tabs: [tabInfo({ tabId: h.TAB })],
      activeTabId: null,
      rpc: {
        [h.TAB]: rpcTabState({
          items: items(),
          advisorStats: {
            available: true,
            configured: true,
            active: true,
            model: "m",
            subscription: false,
            contextWindow: 0,
            contextTokens: 0,
            cost: 0.5,
            totalTokens: 1200,
          },
        }),
      },
      lastActiveAt: { [h.TAB]: Date.now() - AWAY },
    });
    h.useStore.getState().focusTab(h.TAB);
    expect(h.useStore.getState().catchup[h.TAB]?.digest?.advisor).toEqual({
      cost: 0.5,
      tokens: 1200,
    });
  });

  it("stages on a booting tab and settles once at ready from the backfill", async () => {
    const since = Date.now() - AWAY;
    h.useStore.setState({
      state: h.stateWithRecord("sess-1"),
      tabs: [tabInfo({ tabId: h.TAB })],
      activeTabId: null,
      rpc: { [h.TAB]: rpcTabState({ status: "starting" }) },
      lastActiveAt: { [h.TAB]: since },
    });
    h.useStore.getState().focusTab(h.TAB);
    expect(h.useStore.getState().catchup[h.TAB]).toMatchObject({ since, settled: false });
    const at = Date.now() - 10 * 60_000;
    const messages = [
      { role: "user", content: [{ type: "text", text: "backfill me" }], timestamp: at },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: at + 1000,
        stopReason: "stop",
      },
    ];
    await h.driveBoot(h.TAB, { get_messages: { data: { messages } } });
    const entry = h.useStore.getState().catchup[h.TAB];
    expect(entry).toMatchObject({ settled: true });
    expect(entry?.digest).toMatchObject({
      turns: [{ prompt: "backfill me", outcome: "completed" }],
      advisor: null,
    });
  });

  it("does not re-settle a taken snapshot when the advisor frame arrives after ready", async () => {
    const since = Date.now() - AWAY;
    h.useStore.setState({
      state: h.stateWithRecord("sess-1"),
      tabs: [tabInfo({ tabId: h.TAB })],
      activeTabId: null,
      rpc: { [h.TAB]: rpcTabState({ status: "starting" }) },
      lastActiveAt: { [h.TAB]: since },
    });
    h.useStore.getState().focusTab(h.TAB);
    await h.driveBoot(h.TAB, { get_messages: { data: { messages: [] } } });
    const before = h.useStore.getState().catchup[h.TAB];
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      method: "setStatus",
      id: ADVISOR_STATS_KEY,
      statusKey: ADVISOR_STATS_KEY,
      statusText: JSON.stringify({
        available: true,
        configured: true,
        active: true,
        model: "m",
        subscription: false,
        contextWindow: 0,
        contextTokens: 0,
        cost: 0.5,
        totalTokens: 1200,
      }),
    });
    expect(h.useStore.getState().catchup[h.TAB]).toBe(before);
    expect(h.useStore.getState().rpc[h.TAB]?.advisorStats).toMatchObject({
      available: true,
      cost: 0.5,
    });
  });

  it("dismisses the card and stages a fresh nonce on the next qualifying resurface", () => {
    const since = Date.now() - AWAY;
    h.useStore.setState({
      state: h.stateWithRecord("sess-1"),
      tabs: [tabInfo({ tabId: h.TAB }), tabInfo({ tabId: "tab-b" })],
      activeTabId: "tab-b",
      rpc: { [h.TAB]: rpcTabState({ items: items() }) },
      lastActiveAt: { [h.TAB]: since },
    });
    h.useStore.getState().focusTab(h.TAB);
    const nonce1 = h.useStore.getState().catchup[h.TAB]!.nonce;
    h.useStore.getState().dismissCatchup(h.TAB);
    expect(h.useStore.getState().catchup[h.TAB]).toBeUndefined();
    // Leave, simulate the away interval, then resurface.
    h.useStore.setState({ activeTabId: "tab-b" });
    h.useStore.setState({
      lastActiveAt: { ...h.useStore.getState().lastActiveAt, [h.TAB]: Date.now() - AWAY },
    });
    h.useStore.getState().focusTab(h.TAB);
    const entry = h.useStore.getState().catchup[h.TAB];
    expect(entry).toMatchObject({ settled: true });
    expect(entry?.nonce).toBeGreaterThan(nonce1);
  });

  it("eraseSession drops the catch-up entry, the baseline, and the slot", async () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1"),
      tabs: [tabInfo({ tabId: h.TAB })],
      activeTabId: h.TAB,
      rpc: { [h.TAB]: rpcTabState() },
      lastActiveAt: { [h.TAB]: Date.now() - AWAY },
      catchup: { [h.TAB]: { since: 1, nonce: 1, settled: true, digest: null } },
    });
    h.useStore.getState().deleteSession(h.TAB);
    await h.flushMicrotasks();
    await h.useStore.getState().confirmDeleteSession(true);
    expect(h.useStore.getState().catchup[h.TAB]).toBeUndefined();
    expect(h.useStore.getState().lastActiveAt[h.TAB]).toBeUndefined();
    expect(h.useStore.getState().rpc[h.TAB]).toBeUndefined();
  });
});
