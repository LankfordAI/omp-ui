// Frame reduction slice tests (moved verbatim from store.test.ts for #295).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppUpdateState,
  BackendState,
  OmpUpdateState,
  ProviderOAuthState,
  RemoteState,
} from "@omp-ui/core/types";
import {
  ADVISOR_REPLY_CAP_NOTICE,
  ADVISOR_REPLY_LEAD,
  ADVISOR_REPLY_SETTLE_MS,
} from "../../lib/advisor-reply";
import {
  STALL_CONTINUE_CAP_NOTICE,
  STALL_CONTINUE_LEAD,
  STALL_CONTINUE_SETTLE_MS,
} from "../../lib/stall-continue";
import { PLAN_STATUS_KEY } from "@omp-ui/core/plan";
import { MCP_RUNTIME_STATUS_KEY } from "@omp-ui/core/mcp-status";
import { emptySessionRuntime } from "../../lib/rpc-types";
import { commandItem, type NoticeItem } from "../../lib/transcript";
import {
  backendState as makeBackendState,
  rpcTabState,
} from "../../test/fixtures";
import { h } from "../../test/store-harness";
import { reduceAgentEvent } from "./reduce-agent-event";

describe("reduceAgentEvent", () => {
  const runtime = (slashCommandItems = new Map<string, string>()) => ({
    quietWedgeNotified: false,
    timedOutCommands: [],
    pendingNotices: [],
    slashCommandItems,
    lastFrameAt: 1_000,
  });

  it("returns agent_start intents without mutating its inputs", () => {
    const tab = rpcTabState({
      status: "ready",
      lastTurn: { stopReason: "error" },
    });
    const slashCommandItems = new Map([["request-1", "item-1"]]);
    const observedRuntime = runtime(slashCommandItems);

    const reduced = reduceAgentEvent(tab, observedRuntime, {
      type: "agent_start",
    });

    expect(tab.status).toBe("ready");
    expect(tab.lastTurn).toEqual({ stopReason: "error" });
    expect(slashCommandItems).toEqual(
      new Map([["request-1", "item-1"]]),
    );
    expect(reduced.patch.rpc).toMatchObject({
      status: "running",
      lastTurn: undefined,
    });
    expect(reduced.patch.runtime.slashCommandItems).toEqual(new Map());
    expect(reduced.effects.map(({ phase, type }) => `${phase}:${type}`)).toEqual([
      "before-commit:feed-concern-watcher",
      "before-commit:feed-advisor-reply-watcher",
      "after-commit:restart-stream-stall-timer",
      "after-commit:clear-queue-settle-timer",
      "after-commit:settle-slash-command-items",
    ]);
  });

  it("leaves agent state unchanged for an unknown event type", () => {
    const frame = { type: "future_event", payload: { opaque: true } };
    const reduced = reduceAgentEvent(rpcTabState(), runtime(), frame);

    expect(reduced.patch).toEqual({ runtime: { lastFrameAt: 1_000 } });
    expect(reduced.transcript).toEqual({ frame, stall: null });
  });
});

describe("handleRpcFrame routing", () => {
  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  it("omp_ui_error records a fatal process failure", () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, {
        type: "omp_ui_error",
        message: "handshake failed",
      });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.status).toBe("error");
    expect(tab.failure).toMatchObject({
      message: "handshake failed",
      kind: "process",
      fatal: true,
      sessionStatus: "error",
      recovery: expect.stringMatching(/Resume the session/),
    });
  });

  it("a successful loud command cannot clear a fatal process failure", async () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "omp_ui_error", message: "process gone" });
    const fatal = h.useStore.getState().rpc[h.TAB]!.failure;
    const command = h.useStore.getState().setThinkingLevel(h.TAB, "high");
    h.respond(h.TAB, h.sent.pop()!.cmd, {});
    await command;
    expect(h.useStore.getState().rpc[h.TAB]!.failure).toBe(fatal);
  });

  it("agent_end refreshes get_state and get_session_stats", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(true);
    // get_session_stats carries the HUD cost/token totals; without this the
    // boot-time snapshot (a fresh session reads $0) lingers forever.
    expect(h.sent.some((s) => s.cmd.type === "get_session_stats")).toBe(true);
  });

  it("agent_start flips status to running; prompt_result back to ready", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("running");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "prompt_result" });
    expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("ready");
  });

  it("refreshes get_state and get_session_stats live on message_end while the agent runs", () => {
    h.useStore.setState({
      rpc: { [`${h.TAB}-live`]: rpcTabState({ status: "running" }) },
    });
    h.useStore.getState().handleRpcFrame(`${h.TAB}-live`, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first turn" }],
      },
    });
    expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(true);
    // Spend lives on get_session_stats — without this tick the HUD cost
    // counter freezes for the whole run and only moves at agent_end.
    expect(h.sent.some((s) => s.cmd.type === "get_session_stats")).toBe(true);
  });

  it("throttles a burst of message_ends to one live usage snapshot", () => {
    h.useStore.setState({
      rpc: { [`${h.TAB}-burst`]: rpcTabState({ status: "running" }) },
    });
    const end = (text: string) =>
      h.useStore.getState().handleRpcFrame(`${h.TAB}-burst`, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    end("a");
    end("b");
    end("c");
    expect(h.sent.filter((s) => s.cmd.type === "get_state")).toHaveLength(1);
    expect(h.sent.filter((s) => s.cmd.type === "get_session_stats")).toHaveLength(
      1,
    );
  });

  it("does not refresh get_state on message_end while idle", () => {
    h.useStore.setState({
      rpc: { [`${h.TAB}-idle`]: rpcTabState({ status: "ready" }) },
    });
    h.useStore.getState().handleRpcFrame(`${h.TAB}-idle`, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(false);
  });

  describe("queue settle re-fetch (issue #181)", () => {
    const getStateCalls = () =>
      h.sent.filter((s) => s.cmd.type === "get_state");

    /** Fires agent_end mid-run and answers the immediate get_state refresh. */
    const endTurnWithCount = async (key: string, count: number) => {
      h.useStore.getState().handleRpcFrame(key, { type: "agent_end" });
      h.respond(key, getStateCalls().at(-1)!.cmd, {
        queuedMessageCount: count,
      });
      await h.flushMicrotasks();
    };

    it("re-fetches once when a turn ends with a nonzero queue count", async () => {
      vi.useFakeTimers();
      try {
        const key = `${h.TAB}-settle-once`;
        h.useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        await endTurnWithCount(key, 1);
        expect(getStateCalls()).toHaveLength(1);
        expect(h.useStore.getState().rpc[key]!.session.queuedMessageCount).toBe(
          1,
        );
        // omp-side settle work (advice reclaim, deferred flush) can land just
        // after agent_end — one delayed re-fetch catches it.
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS);
        await h.flushMicrotasks();
        expect(getStateCalls()).toHaveLength(2);
        // The re-fetch settles the count; no further polling once it clears.
        h.respond(key, getStateCalls().at(-1)!.cmd, { queuedMessageCount: 0 });
        await h.flushMicrotasks();
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS * 4);
        await h.flushMicrotasks();
        expect(getStateCalls()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not re-fetch when the turn ends with an empty queue", async () => {
      vi.useFakeTimers();
      try {
        const key = `${h.TAB}-settle-empty`;
        h.useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        await endTurnWithCount(key, 0);
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS * 2);
        await h.flushMicrotasks();
        expect(getStateCalls()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels the settle timer when a new turn starts", async () => {
      vi.useFakeTimers();
      try {
        const key = `${h.TAB}-settle-cancel`;
        h.useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        await endTurnWithCount(key, 1);
        h.useStore.getState().handleRpcFrame(key, { type: "agent_start" });
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS * 2);
        await h.flushMicrotasks();
        expect(getStateCalls()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-fetches when the agent_end get_state itself fails", async () => {
      vi.useFakeTimers();
      try {
        const key = `${h.TAB}-settle-fail`;
        h.useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        // Seed a nonzero last-known count through one clean cycle.
        await endTurnWithCount(key, 1);
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS);
        await h.flushMicrotasks();
        h.respond(key, getStateCalls().at(-1)!.cmd, { queuedMessageCount: 1 });
        await h.flushMicrotasks();
        // The next turn's closing refresh is lost: the settle timer is the
        // one retry, or the stale count would freeze in the composer.
        h.useStore.getState().handleRpcFrame(key, { type: "agent_start" });
        h.useStore.getState().handleRpcFrame(key, { type: "agent_end" });
        h.respond(key, getStateCalls().at(-1)!.cmd, "unavailable", false);
        await h.flushMicrotasks();
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS);
        await h.flushMicrotasks();
        expect(getStateCalls()).toHaveLength(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("folds session events into render items", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "yo" }] },
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({ kind: "user", text: "yo" }),
    ]);
  });

  it("queues dialog extension requests", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e1",
      method: "confirm",
      title: "sure?",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.extensionQueue).toHaveLength(1);
  });

  it("records a setWidget's text in extensionStatus AND still answers it", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e2",
      method: "setWidget",
      widgetKey: "ctx",
      widgetLines: ["ctx 12%", "cost $0.10"],
    });
    // omp blocks on the reply — recording the text must not replace answering.
    expect(h.sent.pop()!.cmd).toMatchObject({
      type: "extension_ui_response",
      id: "e2",
      cancelled: true,
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.extensionStatus).toEqual({ ctx: "ctx 12%\ncost $0.10" });
    expect(tab.extensionQueue).toHaveLength(0);
    // Displayed text is not transcript noise.
    expect(tab.items).toHaveLength(0);
  });

  it("records setStatus text and clears a widget when its lines go away", () => {
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e3",
      method: "setStatus",
      statusKey: "advisor",
      statusText: "reviewing",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.extensionStatus).toEqual({
      advisor: "reviewing",
    });
    store.handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e4",
      method: "setStatus",
      statusKey: "advisor",
      statusText: undefined,
    });
    expect(h.useStore.getState().rpc[h.TAB]!.extensionStatus).toEqual({});
  });

  it("auto-cancels a non-status extension request with a marker", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e5",
      method: "notify",
      message: "hi",
    });
    expect(h.sent.pop()!.cmd).toMatchObject({
      type: "extension_ui_response",
      id: "e5",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "marker",
        label: "extension notify auto-cancelled",
      }),
    ]);
  });

  it("open_url opens the system browser, confirms, and stamps a marker", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "u1",
      method: "open_url",
      url: "https://auth.example.com/login?state=1",
    });
    expect(h.openedUrls).toEqual(["https://auth.example.com/login?state=1"]);
    expect(h.sent.pop()!.cmd).toEqual({
      type: "extension_ui_response",
      id: "u1",
      confirmed: true,
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "marker",
        label: "opened browser: https://auth.example.com",
      }),
    ]);
  });

  it("open_url without a url string is cancelled, never opened", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "u2",
      method: "open_url",
    });
    expect(h.openedUrls).toHaveLength(0);
    expect(h.sent.pop()!.cmd).toMatchObject({
      type: "extension_ui_response",
      id: "u2",
      cancelled: true,
    });
  });

  it("claims the plan status frame as state, not as displayed text", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p1",
      method: "setStatus",
      statusKey: "omp-ui:plan",
      statusText: JSON.stringify({
        enabled: true,
        planFilePath: "local://a-plan.md",
        planAbsPath: "/lineage/local/a-plan.md",
        approved: false,
      }),
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.plan).toMatchObject({
      enabled: true,
      planFilePath: "local://a-plan.md",
    });
    // Plan state drives the toggle; it must never leak into the status chips.
    expect(tab.extensionStatus).toEqual({});
  });

  it("claims the advisor-stats frame as state, not as displayed text", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "a1",
      method: "setStatus",
      statusKey: "omp-ui:advisorStats",
      statusText: JSON.stringify({
        available: true,
        configured: true,
        active: true,
        model: "openrouter/anthropic/claude-opus-5",
        contextWindow: 200000,
        contextTokens: 40123,
        cost: 0.41,
        totalTokens: 900000,
      }),
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.advisorStats).toMatchObject({
      available: true,
      cost: 0.41,
      contextTokens: 40123,
      contextWindow: 200000,
    });
    // Advisor stats are state, never a status chip.
    expect(tab.extensionStatus).toEqual({});
    expect(tab.advisorStats?.active).toBe(true);
  });

  describe("MCP runtime failure state", () => {
    const statusFrame = (statusText: string, id = "mcp-status") => ({
      type: "extension_ui_request",
      id,
      method: "setStatus",
      statusKey: MCP_RUNTIME_STATUS_KEY,
      statusText,
    });

    it("derives one warning per new auth and connection failure", () => {
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame(JSON.stringify({
        pendingServers: [],
        connectedServers: [],
        failedServers: [
          { serverName: "oauth-broken", kind: "auth" },
          { serverName: "offline", kind: "connection" },
        ],
      })));

      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.items).toEqual([
        expect.objectContaining({
          kind: "notice",
          level: "warn",
          text: "MCP server “oauth-broken” failed authentication and is absent from this live session. Open the MCP manager, authenticate through omp’s TUI, then reload MCP in this session.",
        }),
        expect.objectContaining({
          kind: "notice",
          level: "warn",
          text: "MCP server “offline” failed to connect and is absent from this live session. Open the MCP manager to inspect its configuration, then reload MCP in this session.",
        }),
      ]);
      expect(tab.mcpStatus?.failedServers).toHaveLength(2);
      expect(tab.extensionStatus).toEqual({});
    });

    it("deduplicates repeated snapshots and clears active failure state on connection", () => {
      const failed = JSON.stringify({
        pendingServers: [],
        connectedServers: [],
        failedServers: [{ serverName: "remote", kind: "auth" }],
      });
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame(failed, "first"));
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame(failed, "repeat"));
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame(JSON.stringify({
        pendingServers: [],
        connectedServers: ["remote"],
        failedServers: [],
      }), "connected"));

      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.items.filter((item) => item.kind === "notice")).toHaveLength(1);
      expect(tab.mcpStatus).toEqual({
        pendingServers: [],
        connectedServers: ["remote"],
        failedServers: [],
      });
    });

    it("claims malformed status without changing state or creating a generic chip", () => {
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame("{not-json"));
      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.mcpStatus).toBeNull();
      expect(tab.items).toEqual([]);
      expect(tab.extensionStatus).toEqual({});
    });

    it("updates and warns a background tab", () => {
      h.useStore.setState({ activeTabId: "another-tab" });
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame(JSON.stringify({
        pendingServers: [],
        connectedServers: [],
        failedServers: [{ serverName: "background", kind: "connection" }],
      })));
      expect(h.useStore.getState().rpc[h.TAB]!.mcpStatus?.failedServers).toEqual([
        { serverName: "background", kind: "connection" },
      ]);
      expect(h.useStore.getState().rpc[h.TAB]!.items).toHaveLength(1);
    });
    it("clears process-scoped status and notices when the tab boots again", async () => {
      const relaunchTab = "mcp-relaunch-tab";
      const state = h.stateWithRecord("session-1");
      state.projects[0]!.sessions[0]!.tabId = relaunchTab;
      h.backendState = state;
      h.useStore.setState({
        state,
        rpc: {
          [relaunchTab]: rpcTabState({
            items: [{ kind: "notice", id: "old-mcp-notice", text: "old" }],
            mcpStatus: {
              pendingServers: [],
              connectedServers: [],
              failedServers: [{ serverName: "old-process", kind: "auth" }],
            },
          }),
        },
      });

      await h.driveBoot(relaunchTab);

      expect(h.useStore.getState().rpc[relaunchTab]!.mcpStatus).toBeNull();
      expect(h.useStore.getState().rpc[relaunchTab]!.items).toEqual([]);
    });
  });

  describe("provider stream stall notices (issue #100)", () => {
    const stallFrame = {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 10,
      delayMs: 2000,
      errorMessage:
        "OpenAI responses stream stalled while waiting for the next event",
    };

    it("reports idle watchdog time from the last model-stream checkpoint", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        const store = h.useStore.getState();
        store.handleRpcFrame(h.TAB, {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "x" },
        });
        vi.setSystemTime(1_000_000 + 123_000);
        h.useStore.getState().handleRpcFrame(h.TAB, stallFrame);
        const last = h.useStore.getState().rpc[h.TAB]!.items.at(-1);
        expect(last).toMatchObject({ kind: "notice", level: "warn" });
        if (last?.kind !== "notice") return;
        expect(last.text).toContain(
          "idle watchdog fired after 2m 03s since streaming text",
        );
        expect(last.text).toContain(
          "Upstream error: OpenAI responses stream stalled while waiting for the next event",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not let local tool frames replace the last model checkpoint", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        const store = h.useStore.getState();
        store.handleRpcFrame(h.TAB, {
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_end" },
        });
        vi.setSystemTime(1_120_000);
        store.handleRpcFrame(h.TAB, {
          type: "tool_execution_start",
          toolCallId: "t1",
        });
        vi.setSystemTime(1_123_000);
        store.handleRpcFrame(h.TAB, {
          type: "tool_execution_update",
          toolCallId: "t1",
        });
        store.handleRpcFrame(h.TAB, stallFrame);
        const last = h.useStore.getState().rpc[h.TAB]!.items.at(-1);
        if (last?.kind !== "notice") return;
        expect(last.text).toContain(
          "2m 03s since tool-call arguments complete",
        );
        expect(last.text).not.toContain("running tools");
      } finally {
        vi.useRealTimers();
      }
    });

    it("increments the per-tab stall counter across stalls", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        h.useStore.getState().handleRpcFrame(h.TAB, stallFrame);
        vi.setSystemTime(1_100_000);
        h.useStore.getState().handleRpcFrame(h.TAB, { ...stallFrame, attempt: 2 });
        const notices = h.useStore
          .getState()
          .rpc[h.TAB]!.items.filter((i) => i.kind === "notice");
        expect(notices).toHaveLength(2);
        if (notices[0]?.kind !== "notice" || notices[1]?.kind !== "notice")
          return;
        expect(notices[0].text).toContain("provider stream stall #1");
        expect(notices[1].text).toContain("provider stream stall #2");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stays silent for a non-stall retry (no Timeout bit, no watchdog message)", () => {
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 10,
        delayMs: 2000,
        errorMessage: "429 rate limit",
      });
      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.items.filter((i) => i.kind === "notice")).toEqual([]);
      const last = tab.items[tab.items.length - 1];
      expect(last).toMatchObject({
        kind: "marker",
        label: "auto-retry 1/10 started — retrying in 2.0s",
      });
    });

    it("admits an unknown stage when only the Timeout bit is available", () => {
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 10,
        delayMs: 2000,
        errorId: 0x0006_0000,
      });
      const notice = h.useStore
        .getState()
        .rpc[h.TAB]!.items.find((i) => i.kind === "notice");
      if (notice?.kind !== "notice") return;
      expect(notice.level).toBe("warn");
      expect(notice.text).toContain("supplied no watchdog stage");
      expect(notice.text).not.toContain("Upstream error:");
    });

    it("distinguishes first-event from idle and avoids unsupported attribution", () => {
      h.useStore.getState().handleRpcFrame(h.TAB, {
        ...stallFrame,
        errorMessage:
          "OpenAI responses stream timed out while waiting for the first event",
      });
      h.useStore.getState().handleRpcFrame(h.TAB, stallFrame);
      const notices = h.useStore
        .getState()
        .rpc[h.TAB]!.items.filter((i) => i.kind === "notice");
      if (notices[0]?.kind !== "notice" || notices[1]?.kind !== "notice")
        return;
      expect(notices[0].text).toContain("first-event watchdog fired");
      expect(notices[1].text).toContain("idle watchdog fired");
      for (const notice of notices) {
        expect(notice.text).not.toContain("defaults to 2m");
        expect(notice.text).not.toContain("provider leg");
        expect(notice.text).not.toContain("proxy or upstream model");
      }
    });
  });

  it("refreshAdvisorStats asks the extension over a slash command", async () => {
    const pending = h.useStore.getState().refreshAdvisorStats(h.TAB);
    const entry = h.sent.pop()!;
    expect(entry.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-advisor-stats",
    });
    // The extension answers by publishing a setStatus frame, not a response —
    // settle the command so the method promise resolves.
    h.respond(h.TAB, entry.cmd, {});
    await pending;
  });

  it("routes a plan review to the review pane instead of the generic dialog", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p2",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "add auth",
          planFilePath: "local://auth-plan.md",
          planAbsPath: "/lineage/local/auth-plan.md",
        }),
      options: ["approve", "refine"],
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.planReview?.request).toMatchObject({
      planFilePath: "local://auth-plan.md",
    });
    expect(tab.extensionQueue).toHaveLength(0);
    // The agent is blocked on this select — nothing may answer it early.
    expect(h.sent.some((s) => s.cmd.type === "extension_ui_response")).toBe(
      false,
    );
  });

  it("reads one file and flags an html plan for iframe rendering", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p2h",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "add auth",
          planFilePath: "local://auth-plan.html",
          planAbsPath: "/lineage/local/auth-plan.html",
        }),
    });
    await h.flushMicrotasks();
    const tab = h.useStore.getState().rpc[h.TAB]!;
    // The html file IS the plan — one read, and planHtml is only the flag that
    // says "render this text in an iframe", never a second document.
    expect(h.mockBackend.readPlanFile).toHaveBeenCalledTimes(1);
    expect(tab.planText).toBe("<h1>Plan</h1>");
    expect(tab.planHtml).toBe("<h1>Plan</h1>");
  });

  it("leaves planHtml null for a markdown plan", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p2m",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "add auth",
          planFilePath: "local://auth-plan.md",
          planAbsPath: "/lineage/local/auth-plan.md",
        }),
    });
    await h.flushMicrotasks();
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(h.mockBackend.readPlanFile).toHaveBeenCalledTimes(1);
    expect(tab.planText).toBe("# Plan\n\nstep one\n");
    expect(tab.planHtml).toBeNull();
  });

  it("clears both plan fields when an html plan cannot be read", async () => {
    h.mockBackend.readPlanFile.mockRejectedValueOnce(new Error("ENOENT"));
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p2f",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "add auth",
          planFilePath: "local://auth-plan.html",
          planAbsPath: "/lineage/local/auth-plan.html",
        }),
    });
    await h.flushMicrotasks();
    const tab = h.useStore.getState().rpc[h.TAB]!;
    // A failed read must not leave the pane flagged for iframe rendering with
    // nothing to render — the review itself stays open either way.
    expect(tab.planText).toBeNull();
    expect(tab.planHtml).toBeNull();
    expect(tab.planReview).not.toBeNull();
  });

  it("executing a review answers with the execute verdict and closes the pane", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p3",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    h.useStore.getState().executePlan(h.TAB, "existing");
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p3", value: "execute" });
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).toBeNull();
    await h.flushMicrotasks();
  });

  it("executing in the existing session queues an implementation prompt there", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p3b",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    h.useStore.getState().executePlan(h.TAB, "existing");
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    // followUp queues the prompt until the just-accepted plan turn ends, so it
    // races nothing — the implementer runs after the planner stops.
    expect(prompt!.cmd.streamingBehavior).toBe("followUp");
    await h.flushMicrotasks();
  });

  it("holds the implementation prompt until the session reports Build after execute (issue #165)", async () => {
    // The proposing session published armed status; the verdict's exit frame
    // is still in flight when the verdict is answered.
    h.useStore.setState((s) => ({
      rpc: {
        ...s.rpc,
        [h.TAB]: {
          ...s.rpc[h.TAB]!,
          plan: {
            enabled: true,
            planFilePath: "local://p.md",
            planAbsPath: "/p.md",
            approved: false,
          },
        },
      },
    }));
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p3c",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    h.useStore.getState().executePlan(h.TAB, "existing");
    // Verdict landed, but no implementation prompt yet — it waits for Build.
    expect(h.sent.find((s) => s.cmd.type === "prompt")).toBeUndefined();
    // The extension's in-process exit publishes its status frame.
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "st1",
      method: "setStatus",
      statusKey: PLAN_STATUS_KEY,
      statusText: JSON.stringify({
        enabled: false,
        planFilePath: null,
        planAbsPath: null,
        approved: true,
      }),
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    await h.flushMicrotasks();
  });

  it("forces plan mode off before dispatching when the verdict's exit never publishes (issue #165)", async () => {
    vi.useFakeTimers();
    try {
      h.useStore.setState((s) => ({
        rpc: {
          ...s.rpc,
          [h.TAB]: {
            ...s.rpc[h.TAB]!,
            plan: {
              enabled: true,
              planFilePath: "local://p.md",
              planAbsPath: "/p.md",
              approved: false,
            },
          },
        },
      }));
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "extension_ui_request",
        id: "p3d",
        method: "select",
        title:
          "omp-ui:plan-review:" +
          JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
      });
      h.useStore.getState().executePlan(h.TAB, "existing");
      // No exit frame ever arrives; the bounded wait expires and the mode
      // command is sent directly.
      await vi.advanceTimersByTimeAsync(15_000);
      await h.flushMicrotasks();
      const off = h.sent.find(
        (s) =>
          s.tabId === h.TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message) === "/omp-ui-plan off",
      );
      expect(off).toBeDefined();
      // The forced exit answers with its status frame; implementation follows.
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "extension_ui_request",
        id: "st2",
        method: "setStatus",
        statusKey: PLAN_STATUS_KEY,
        statusText: JSON.stringify({
          enabled: false,
          planFilePath: null,
          planAbsPath: null,
          approved: true,
        }),
      });
      await h.flushMicrotasks();
      expect(
        h.sent.find(
          (s) =>
            s.tabId === h.TAB &&
            s.cmd.type === "prompt" &&
            String(s.cmd.message).includes("execute the approved plan"),
        ),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refining a review answers with the refine verdict and sends no prompt", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p4",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    h.useStore.getState().refinePlan(h.TAB);
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p4", value: "refine" });
    expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
  });

  it("refining with notes steers the planner with the requested changes", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p4b",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    h.useStore.getState().refinePlan(h.TAB, { text: "drop the API layer" });
    const prompt = h.sent.find((s) => s.tabId === h.TAB && s.cmd.type === "prompt");
    expect(prompt).toBeDefined();
    expect(prompt!.cmd.streamingBehavior).toBe("steer");
    expect(prompt!.cmd.message).toContain("drop the API layer");
    await h.flushMicrotasks();
  });

  it("executing in a fresh session spawns a new tab seeded with the plan", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p7",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "t",
          planFilePath: "local://p.md",
          planAbsPath: "/lineage/local/p.md",
        }),
    });
    // Let the plan file read resolve so executePlan captures the plan text.
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p7", value: "execute" });
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === "fresh-tab" &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("# Plan"),
    );
    expect(prompt).toBeDefined();
    expect(prompt!.cmd.message).toContain("Implement it now");
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
    expect(
      h.useStore
        .getState()
        .rpc[h.TAB]!.items.some(
          (item) =>
            item.kind === "notice" && item.text.includes("implementation dispatched"),
        ),
    ).toBe(false);

    h.respond("fresh-tab", prompt!.cmd, {});
    await h.flushMicrotasks();

    expect(h.mockBackend.hibernatePlanSource).toHaveBeenCalledOnce();
    expect(h.mockBackend.hibernatePlanSource).toHaveBeenCalledWith(h.TAB, "fresh-tab");
    expect(
      h.useStore
        .getState()
        .rpc[h.TAB]!.items.some(
          (item) =>
            item.kind === "notice" && item.text.includes("implementation dispatched"),
        ),
    ).toBe(true);
    await rearmHandoffSource();
  });

  it("seeds a fresh session with an html plan's spec, not its stylesheet", async () => {
    const htmlPlan = [
      "<!doctype html>",
      "<html><head><style>",
      "  h1 { color: rebeccapurple; }",
      "</style></head>",
      "<body><h1>Ship the auth rewrite</h1></body>",
      "</html>",
    ].join("\n");
    h.mockBackend.readPlanFile.mockResolvedValueOnce(htmlPlan);
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p7h",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "t",
          planFilePath: "local://p-plan.html",
          planAbsPath: "/lineage/local/p-plan.html",
        }),
    });
    // Let the plan file read resolve so executePlan captures the plan text.
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) => s.tabId === "fresh-tab" && s.cmd.type === "prompt",
    );
    expect(prompt).toBeDefined();
    // The implementer needs the spec inline; the presentation layer is pure
    // token cost in a prompt.
    expect(String(prompt!.cmd.message)).toContain("Ship the auth rewrite");
    expect(String(prompt!.cmd.message)).not.toContain("rebeccapurple");
    await h.flushMicrotasks();
  });

  /** An advisor review card as it lands over the live stream. */
  const advisorReviewFrame = (
    note: string,
    severity: string,
    advisor: string,
  ) => ({
    type: "message_end",
    message: {
      role: "custom",
      customType: "advisor",
      content: "<advisory/>",
      details: { notes: [{ note, severity, advisor }] },
    },
  });

  /** Opens a plan review ready for a verdict. */
  const openReview = (id: string) => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id,
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
  };

  const dispatchFreshSeed = async (id: string): Promise<(typeof h.sent)[number]> => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReview(id);
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    h.useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    }));
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (entry) => entry.tabId === "fresh-tab" && entry.cmd.type === "prompt",
    );
    if (prompt === undefined) throw new Error("fresh implementation seed was not sent");
    return prompt;
  };

  const rearmHandoffSource = async (): Promise<void> => {
    const prompt = h.useStore.getState().sendPrompt(h.TAB, "test handoff cleanup", "prompt");
    const command = h.sent.at(-1);
    if (command?.tabId === h.TAB && command.cmd.type === "prompt") {
      h.respond(h.TAB, command.cmd, {});
    }
    await prompt;
  };

  it("does not hibernate after a fresh spawn failure or readiness timeout (issue #283)", async () => {
    h.mockBackend.spawnSession.mockRejectedValueOnce(new Error("spawn failed"));
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReview("handoff-spawn-failure");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "never-ready" });
      openReview("handoff-ready-timeout");
      await h.flushMicrotasks();
      h.useStore.getState().executePlan(h.TAB, "fresh");
      await h.flushMicrotasks();
      await vi.advanceTimersByTimeAsync(15_000);
      await h.flushMicrotasks();
      expect(
        h.sent.some((entry) => entry.tabId === "never-ready" && entry.cmd.type === "prompt"),
      ).toBe(false);
      expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("executing in a worktree session spawns in a dedicated checkout (issue #313)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "wt-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p-wt",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "t",
          planFilePath: "local://p.md",
          planAbsPath: "/lineage/local/p.md",
        }),
    });
    // Let the plan file read resolve so executePlan captures the plan text.
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "worktree", {
      worktree: { branch: "omp-ui/cafebabe", baseRef: "main" },
    });
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p-wt", value: "execute" });
    await h.flushMicrotasks();
    // The worktree spec rides the same spawn as the plan provenance.
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: { mint: { branch: "omp-ui/cafebabe", baseRef: "main" } },
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
    // Boot the worktree tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        "wt-tab": rpcTabState({ status: "ready", planText: null }),
      },
    }));
    await h.flushMicrotasks();
    const prompt = h.sent.find((s) => s.tabId === "wt-tab" && s.cmd.type === "prompt");
    expect(prompt).toBeDefined();
    expect(String(prompt!.cmd.message)).toContain("Implement it now");
    expect(String(prompt!.cmd.message)).toContain("# Plan");
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();

    h.respond("wt-tab", prompt!.cmd, {});
    await h.flushMicrotasks();
    expect(h.mockBackend.hibernatePlanSource).toHaveBeenCalledWith(h.TAB, "wt-tab");
    // The handoff notice names the worktree dispatch, not the plain fresh one.
    expect(
      h.useStore
        .getState()
        .rpc[h.TAB]!.items.some(
          (item) =>
            item.kind === "notice" &&
            item.text.includes("implementation dispatched to a fresh worktree session"),
        ),
    ).toBe(true);
    await rearmHandoffSource();
  });

  it("a refused worktree add alerts, sends no prompt, and hibernates nothing (issue #313)", async () => {
    h.mockBackend.spawnSession.mockRejectedValueOnce(
      new Error("fatal: a branch named 'omp-ui/cafebabe' already exists"),
    );
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReview("p-wt-refused");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "worktree", {
      worktree: { branch: "omp-ui/cafebabe", baseRef: "main" },
    });
    await h.flushMicrotasks();
    // The verdict answers the gate before the add is refused, so the plan is
    // already settled "executed"; the failure then rides the spawn-failure
    // contract: an error notice, no seed prompt, no hibernate.
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p-wt-refused", value: "execute" });
    expect(h.errorMessages()).toEqual(["fatal: a branch named 'omp-ui/cafebabe' already exists"]);
    expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
  });

  const REUSE_WT = { path: "/wt/reuse", branch: "omp-ui/deadbeef", base: "main" };

  it("a fresh dispatch from a worktree planning session reuses the planning checkout (issue #316)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null, "live", REUSE_WT) });
    openReview("handoff-reuse-fresh");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "handoff-reuse-fresh", value: "execute" });
    // The spawn reuses the planning checkout — no mint spec alongside.
    expect(h.mockBackend.spawnSession.mock.calls.at(-1)![0]).toEqual({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: { reuse: REUSE_WT },
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
    // Boot the fresh tab to ready and let the seed prompt land.
    h.useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    }));
    await h.flushMicrotasks();
    const prompt = h.sent.find((s) => s.tabId === "fresh-tab" && s.cmd.type === "prompt");
    expect(prompt).toBeDefined();
    expect(String(prompt!.cmd.message)).toContain("Implement it now");
    h.respond("fresh-tab", prompt!.cmd, {});
    await h.flushMicrotasks();
    expect(h.mockBackend.hibernatePlanSource).toHaveBeenCalledWith(h.TAB, "fresh-tab");
    // The handoff notice names the in-worktree dispatch.
    expect(
      h.useStore
        .getState()
        .rpc[h.TAB]!.items.some(
          (item) =>
            item.kind === "notice" &&
            item.text.includes("implementation dispatched to a fresh session in this worktree"),
        ),
    ).toBe(true);
    await rearmHandoffSource();
  });

  it("a worktree dispatch keeping the planning branch reuses the checkout (issue #316)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "wt-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null, "live", REUSE_WT) });
    openReview("handoff-reuse-worktree");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "worktree", {
      worktree: { branch: "omp-ui/deadbeef", baseRef: "main" },
    });
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession.mock.calls.at(-1)![0]).toEqual({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: { reuse: REUSE_WT },
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
  });

  it("a worktree dispatch renaming the branch still mints (issue #316)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "wt-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null, "live", REUSE_WT) });
    openReview("handoff-rename-mint");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "worktree", {
      worktree: { branch: "omp-ui/renamed", baseRef: "main" },
    });
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession.mock.calls.at(-1)![0]).toEqual({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: { mint: { branch: "omp-ui/renamed", baseRef: "main" } },
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
  });

  it("a vanished reused checkout alerts, seeds nothing, and hibernates nothing (issue #316)", async () => {
    h.mockBackend.spawnSession.mockRejectedValueOnce(
      new Error(
        "the planning session's worktree checkout is gone — delete the planning session from the sidebar",
      ),
    );
    h.useStore.setState({ state: h.stateWithRecord(null, "live", REUSE_WT) });
    openReview("handoff-reuse-gone");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    // The verdict answers the gate before the spawn is refused, so the plan
    // is already settled "executed"; the failure then rides the spawn-failure
    // contract: an error notice, no seed prompt, no hibernate.
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "handoff-reuse-gone", value: "execute" });
    expect(h.errorMessages()).toEqual([
      "the planning session's worktree checkout is gone — delete the planning session from the sidebar",
    ]);
    expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
  });

  it.each([
    ["set_model", { model: { id: "new", name: "New", provider: "provider" } }],
    ["set_thinking_level", { thinkingLevel: "high" }],
  ])("does not seed or hibernate after %s setup fails (issue #283)", async (command, options) => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReview(`handoff-${command}`);
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh", options);
    await h.flushMicrotasks();
    h.useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    }));
    await h.flushMicrotasks();
    const setupCommand = h.sent.find(
      (entry) => entry.tabId === "fresh-tab" && entry.cmd.type === command,
    );
    expect(setupCommand).toBeDefined();
    h.respond("fresh-tab", setupCommand!.cmd, "setup failed", false);
    await h.flushMicrotasks();

    expect(
      h.sent.some((entry) => entry.tabId === "fresh-tab" && entry.cmd.type === "prompt"),
    ).toBe(false);
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
  });

  it("does not hibernate or claim dispatch when the seed command fails (issue #283)", async () => {
    const prompt = await dispatchFreshSeed("handoff-seed-failure");
    h.respond("fresh-tab", prompt.cmd, "seed rejected", false);
    await h.flushMicrotasks();

    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
    expect(
      h.useStore
        .getState()
        .rpc[h.TAB]!.items.some(
          (item) =>
            item.kind === "notice" && item.text.includes("implementation dispatched"),
        ),
    ).toBe(false);
  });

  it("suppresses a second advisor reply while source hibernation is unresolved (issue #283)", async () => {
    vi.useFakeTimers();
    const hibernation = h.deferred<boolean>();
    h.mockBackend.hibernatePlanSource.mockImplementationOnce(() => hibernation.promise);
    try {
      h.useStore.setState({
        state: h.stateWithRecord(null),
        rpc: {
          [h.TAB]: rpcTabState({
            advisorStats: {
              available: true,
              configured: true,
              active: true,
              model: "advisor",
              subscription: false,
              contextWindow: 200_000,
              contextTokens: 0,
              cost: 0,
              totalTokens: 0,
            },
          }),
        },
      });
      h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
      openReview("handoff-advisor-race");
      h.useStore.getState().executePlan(h.TAB, "fresh");
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("first finding", "concern", "advisor"));
      await h.flushMicrotasks();
      h.useStore.setState((state) => ({
        rpc: {
          ...state.rpc,
          "fresh-tab": rpcTabState({ status: "ready", planText: null }),
        },
      }));
      await h.flushMicrotasks();
      const seed = h.sent.find(
        (entry) => entry.tabId === "fresh-tab" && entry.cmd.type === "prompt",
      );
      expect(seed).toBeDefined();
      h.respond("fresh-tab", seed!.cmd, {});
      await h.flushMicrotasks();
      expect(h.mockBackend.hibernatePlanSource).toHaveBeenCalledWith(h.TAB, "fresh-tab");

      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("late finding", "concern", "advisor"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
      await h.flushMicrotasks();
      expect(h.sent.some((entry) => entry.tabId === h.TAB && entry.cmd.type === "prompt")).toBe(
        false,
      );
    } finally {
      hibernation.resolve(false);
      await rearmHandoffSource();
      vi.useRealTimers();
    }
  });

  it("suppresses stall auto-continue after a successful fresh seed (issue #283)", async () => {
    vi.useFakeTimers();
    const hibernation = h.deferred<boolean>();
    h.mockBackend.hibernatePlanSource.mockImplementationOnce(() => hibernation.promise);
    try {
      const seed = await dispatchFreshSeed("handoff-stall");
      h.respond("fresh-tab", seed.cmd, {});
      await h.flushMicrotasks();
      h.useStore.setState((state) => ({
        rpc: { ...state.rpc, [h.TAB]: { ...state.rpc[h.TAB]!, status: "running" } },
      }));
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          stopReason: "error",
          errorMessage: "OpenAI responses stream stalled while waiting for the next event",
          errorId: 397312,
        },
      });
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
      await h.flushMicrotasks();

      expect(
        h.sent.some(
          (entry) => entry.tabId === h.TAB && entry.cmd.message === STALL_CONTINUE_LEAD,
        ),
      ).toBe(false);
    } finally {
      hibernation.resolve(false);
      await rearmHandoffSource();
      vi.useRealTimers();
    }
  });

  it.each([
    ["false result", async () => false],
    ["rejection", async () => Promise.reject(new Error("transport failed"))],
  ])("keeps source automation suppressed after backend %s (issue #283)", async (_case, result) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.mockBackend.hibernatePlanSource.mockImplementationOnce(result);
    try {
      const seed = await dispatchFreshSeed(`handoff-${_case}`);
      h.respond("fresh-tab", seed.cmd, {});
      await h.flushMicrotasks();
      h.useStore.setState((state) => ({
        rpc: { ...state.rpc, [h.TAB]: { ...state.rpc[h.TAB]!, status: "running" } },
      }));
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("late", "concern", "advisor"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
      await h.flushMicrotasks();

      expect(
        h.sent.filter((entry) => entry.tabId === "fresh-tab" && entry.cmd.type === "prompt"),
      ).toHaveLength(1);
      expect(h.sent.some((entry) => entry.tabId === h.TAB && entry.cmd.type === "prompt")).toBe(
        false,
      );
      expect(h.mockBackend.terminateSession).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rearmHandoffSource();
      vi.useRealTimers();
    }
  });

  it("a manual source prompt re-enables advisor replies after handoff (issue #283)", async () => {
    vi.useFakeTimers();
    h.mockBackend.hibernatePlanSource.mockResolvedValueOnce(false);
    try {
      const seed = await dispatchFreshSeed("handoff-manual-resume");
      h.respond("fresh-tab", seed.cmd, {});
      await h.flushMicrotasks();
      const manual = h.useStore.getState().sendPrompt(h.TAB, "new human direction", "prompt");
      const manualCommand = h.sent.find(
        (entry) => entry.tabId === h.TAB && entry.cmd.message === "new human direction",
      );
      h.respond(h.TAB, manualCommand!.cmd, {});
      await expect(manual).resolves.toBe(true);
      h.useStore.setState((state) => ({
        rpc: { ...state.rpc, [h.TAB]: { ...state.rpc[h.TAB]!, status: "running" } },
      }));
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("review human work", "concern", "advisor"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
      await h.flushMicrotasks();

      expect(
        h.sent.some(
          (entry) =>
            entry.tabId === h.TAB &&
            entry.cmd.type === "prompt" &&
            String(entry.cmd.message).includes("review human work"),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("booting the source re-enables advisor replies after handoff (issue #283)", async () => {
    vi.useFakeTimers();
    h.mockBackend.hibernatePlanSource.mockResolvedValueOnce(false);
    try {
      const seed = await dispatchFreshSeed("handoff-boot-resume");
      h.respond("fresh-tab", seed.cmd, {});
      await h.flushMicrotasks();
      h.sent.length = 0;
      await h.driveBoot(h.TAB);
      h.useStore.setState((state) => ({
        rpc: { ...state.rpc, [h.TAB]: { ...state.rpc[h.TAB]!, status: "running" } },
      }));
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("review resumed work", "concern", "advisor"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
      await h.flushMicrotasks();

      expect(
        h.sent.some(
          (entry) =>
            entry.tabId === h.TAB &&
            entry.cmd.type === "prompt" &&
            String(entry.cmd.message).includes("review resumed work"),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never requests source hibernation for existing or compacted execution (issue #283)", async () => {
    openReview("handoff-existing");
    h.useStore.getState().executePlan(h.TAB, "existing");
    openReview("handoff-compacted");
    h.useStore.getState().executePlan(h.TAB, "compacted");
    await h.flushMicrotasks();

    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
  });

  it("holds execute for the drafting turn's advisor review, then folds its concerns", async () => {
    // Fake timers for the whole test: the same review that feeds the fold also
    // arms the idle auto-reply, and only a fake clock can advance past its
    // settle window to prove the fold's dispatch stays the only prompt.
    vi.useFakeTimers();
    try {
      // Configured advisor = a review of the plan turn is on its way after the verdict.
      h.useStore.setState({
        rpc: {
          [h.TAB]: rpcTabState({
            advisorStats: {
              available: true,
              configured: true,
              active: true,
              model: "m",
              subscription: false,
              contextWindow: 200000,
              contextTokens: 0,
              cost: 0,
              totalTokens: 0,
            },
          }),
        },
      });
      openReview("c1");
      h.useStore.getState().executePlan(h.TAB, "existing");
      // The verdict lands immediately — omp's agent is blocked on it.
      const verdict = h.sent.find((s) => s.cmd.type === "extension_ui_response");
      expect(verdict!.cmd).toMatchObject({ id: "c1", value: "execute" });
      // …but the implementation waits for the review: the turn that produced the
      // plan is still ending, so its review cannot have landed yet.
      expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
      // The advisor reviews the now-finished plan turn.
      h.useStore
        .getState()
        .handleRpcFrame(
          h.TAB,
          advisorReviewFrame("Hardcoded key", "blocker", "security"),
        );
      await h.flushMicrotasks();
      const prompt = h.sent.find(
        (s) =>
          s.tabId === h.TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      );
      expect(prompt).toBeDefined();
      expect(String(prompt!.cmd.message)).toContain("advisor flagged");
      expect(String(prompt!.cmd.message)).toContain("Hardcoded key");
      expect(String(prompt!.cmd.message)).toContain("[blocker]");
      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.items.at(-1)).toMatchObject({
        kind: "notice",
        text: expect.stringContaining("1 concern"),
      });
      // The fold already answered this review; the auto-reply must not send a second.
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
      await h.flushMicrotasks();
      expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a review that lands on an idle session with a follow-up prompt", async () => {
    // The armed settle timer must be the fake one, so install before the frame.
    vi.useFakeTimers();
    try {
      // The production frame sequence, and it is load-bearing: an advisory can
      // only follow a turn, so `agent_end` always precedes it. The watcher feed
      // runs *before* that frame's status patch (store.ts), so the tab still
      // reads `running` there — which is exactly what baselines the cursor onto
      // the `agent finished` marker and leaves the next frame's advisory above
      // it. Feeding the advisory first would instead seed the baseline past it,
      // as a resumed tab's history correctly is.
      h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("ready");
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("Do it now", "concern", "ops"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
    const replies = h.sent.filter((s) => s.cmd.type === "prompt");
    expect(replies).toHaveLength(1);
    // followUp keeps the reply on the same session without restarting its turn.
    expect(replies[0]!.cmd).toMatchObject({ streamingBehavior: "followUp" });
    expect(String(replies[0]!.cmd.message)).toContain("Do it now");
    expect(String(replies[0]!.cmd.message)).toContain("[concern]");
    // The transcript says why a prompt nobody typed appeared.
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    const announcement = items.find(
      (i) => i.kind === "notice" && /answering it \(1 finding\)/.test(i.text),
    );
    expect(announcement).toBeDefined();
  });

  it("sends nothing when the session has advisor auto-reply switched off", async () => {
    vi.useFakeTimers();
    try {
      // Same production sequence as the case above, so the only thing
      // suppressing the reply here is the opt-out.
      h.useStore.setState({
        rpc: { [h.TAB]: rpcTabState({ status: "running", advisorReply: false }) },
      });
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("Do it now", "concern", "ops"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
    expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("answering it")),
    ).toBe(false);
  });

  it("executes immediately, and reads no transcript, when the fold is off", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          items: [
            {
              kind: "advisory",
              id: "advisory-stale",
              notes: [
                {
                  note: "old unrelated nit",
                  severity: "nit",
                  advisor: "style",
                },
              ],
            },
          ],
          advisorStats: {
            available: true,
            configured: true,
            active: true,
            model: "m",
            subscription: false,
            contextWindow: 200000,
            contextTokens: 0,
            cost: 0,
            totalTokens: 0,
          },
        }),
      },
    });
    openReview("c2");
    h.useStore.getState().executePlan(h.TAB, "existing", { addressAdvisor: false });
    await h.flushMicrotasks();
    const prompt = h.sent.find((s) => s.tabId === h.TAB && s.cmd.type === "prompt");
    expect(prompt).toBeDefined();
    // Stale pre-verdict advisories are never folded onto a fresh verdict.
    expect(String(prompt!.cmd.message)).not.toContain("old unrelated nit");
  });

  it("skips the wait entirely when the session has no configured advisor", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ advisorStats: null }) } });
    openReview("c3");
    h.useStore.getState().executePlan(h.TAB, "existing");
    expect(h.sent.find((s) => s.cmd.type === "prompt")).toBeDefined();
  });

  it("refine stays immediate: user notes steer at once, never waiting on a review", () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          advisorStats: {
            available: true,
            configured: true,
            active: true,
            model: "m",
            subscription: false,
            contextWindow: 200000,
            contextTokens: 0,
            cost: 0,
            totalTokens: 0,
          },
        }),
      },
    });
    openReview("c4");
    h.useStore.getState().refinePlan(h.TAB, { text: "drop the API layer" });
    expect(
      h.sent.find((s) => s.cmd.type === "extension_ui_response")!.cmd,
    ).toMatchObject({
      id: "c4",
      value: "refine",
    });
    // The planner revises in this same turn (the extension tells it to), so
    // there is no review to wait for — the user's notes steer immediately.
    const steer = h.sent.find((s) => s.tabId === h.TAB && s.cmd.type === "prompt");
    expect(steer!.cmd.streamingBehavior).toBe("steer");
    expect(String(steer!.cmd.message)).toContain("drop the API layer");
  });

  it("times out the execute concern wait and implements without concerns", async () => {
    vi.useFakeTimers();
    try {
      h.useStore.setState({
        rpc: {
          [h.TAB]: rpcTabState({
            advisorStats: {
              available: true,
              configured: true,
              active: true,
              model: "m",
              subscription: false,
              contextWindow: 200000,
              contextTokens: 0,
              cost: 0,
              totalTokens: 0,
            },
          }),
        },
      });
      openReview("c5");
      h.useStore.getState().executePlan(h.TAB, "existing");
      // The review never lands; the bounded deadline settles the wait.
      await vi.advanceTimersByTimeAsync(15_000);
      await h.flushMicrotasks();
      const prompt = h.sent.find(
        (s) =>
          s.tabId === h.TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      );
      expect(prompt).toBeDefined();
      expect(String(prompt!.cmd.message)).not.toContain("advisor flagged");
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds a fresh implementation session with the folded concerns", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          advisorStats: {
            available: true,
            configured: true,
            active: true,
            model: "m",
            subscription: false,
            contextWindow: 200000,
            contextTokens: 0,
            cost: 0,
            totalTokens: 0,
          },
        }),
      },
    });
    openReview("c6");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).toBeNull();
    h.useStore
      .getState()
      .handleRpcFrame(
        h.TAB,
        advisorReviewFrame("pin the toolchain", "concern", "ops"),
      );
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === "fresh-tab" &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("Implement it now"),
    );
    expect(prompt).toBeDefined();
    expect(String(prompt!.cmd.message)).toContain("pin the toolchain");
    await h.flushMicrotasks();
  });

  it("fresh implementation spawns with the app default advisor when none is staged (issue #174)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({
      tabId: "fresh-default-on",
    });
    h.useStore.setState({
      state: { ...h.stateWithRecord(null), defaultAdvisor: true },
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    openReview("d1");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-default-on": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
  });

  it("fresh implementation defaults the advisor off against omp config when none is staged (issue #174)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({
      tabId: "fresh-default-off",
    });
    h.useStore.setState({
      state: h.stateWithRecord(null),
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });
    openReview("d2");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-default-off": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
  });

  /** Staged model with efforts, distinct from anything seeded on the tab. */
  const MODEL_X = {
    id: "mx",
    name: "MX",
    provider: "p2",
    thinking: { efforts: ["low", "high"] },
  };

  /** Review frame whose plan file read resolves — fresh spawns seed from it. */
  const openReviewWithPlan = (id: string) => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id,
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "t",
          planFilePath: "local://p.md",
          planAbsPath: "/lineage/local/p.md",
        }),
    });
  };

  it("prepends the orchestrate keyword to the implementation prompt (existing context)", async () => {
    openReview("o1");
    h.useStore.getState().executePlan(h.TAB, "existing", { orchestrate: true });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    expect(
      String(prompt!.cmd.message).startsWith(
        "orchestrate\n\nThe plan review is complete",
      ),
    ).toBe(true);
  });

  it("prepends the ultrathink keyword to the implementation prompt (existing context)", async () => {
    openReview("o1u");
    h.useStore.getState().executePlan(h.TAB, "existing", { ultrathink: true });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    expect(
      String(prompt!.cmd.message).startsWith(
        "ultrathink\n\nThe plan review is complete",
      ),
    ).toBe(true);
  });

  it("prepends armed keywords in notice order, not arming order", async () => {
    openReview("o1w");
    h.useStore.getState().executePlan(h.TAB, "existing", { workflowz: true, ultrathink: true });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    expect(
      String(prompt!.cmd.message).startsWith(
        "ultrathink\n\nworkflowz\n\nThe plan review is complete",
      ),
    ).toBe(true);
  });

  it("leaves the keyword off by default", async () => {
    openReview("o2");
    h.useStore.getState().executePlan(h.TAB, "existing");
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    expect(String(prompt!.cmd.message).startsWith("orchestrate")).toBe(false);
  });

  it("prepends the orchestrate keyword to a fresh session's seed", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReviewWithPlan("o3");
    // Let the plan file read resolve so executePlan captures the plan text.
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh", { orchestrate: true });
    await h.flushMicrotasks();
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) => s.tabId === "fresh-tab" && s.cmd.type === "prompt",
    );
    expect(prompt).toBeDefined();
    expect(
      String(prompt!.cmd.message).startsWith(
        "orchestrate\n\nA plan was approved",
      ),
    ).toBe(true);
  });

  it("prepends the workflowz keyword to a fresh session's seed", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReviewWithPlan("o3w");
    // Let the plan file read resolve so executePlan captures the plan text.
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh", { workflowz: true });
    await h.flushMicrotasks();
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) => s.tabId === "fresh-tab" && s.cmd.type === "prompt",
    );
    expect(prompt).toBeDefined();
    expect(
      String(prompt!.cmd.message).startsWith(
        "workflowz\n\nA plan was approved",
      ),
    ).toBe(true);
  });

  it("applies staged model and thinking level before the same-session prompt", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          model: { id: "m1", name: "M1", provider: "p" },
          session: { ...emptySessionRuntime(), thinkingLevel: "low" },
        }),
      },
    });
    openReview("m1");
    h.useStore.getState().executePlan(h.TAB, "existing", {
      model: MODEL_X,
      thinkingLevel: "high",
      advisor: false,
      advisorModel: null,
    });
    await h.flushMicrotasks();
    const onTab = (s: (typeof h.sent)[number]) => s.tabId === h.TAB;
    // The staged pair applies over RPC first; each awaited command stalls the
    // chain until the test answers it.
    const setModel = h.sent.find((s) => onTab(s) && s.cmd.type === "set_model");
    expect(setModel?.cmd).toMatchObject({ provider: "p2", modelId: "mx" });
    h.respond(h.TAB, setModel!.cmd, {});
    await h.flushMicrotasks();
    const setLevel = h.sent.find(
      (s) => onTab(s) && s.cmd.type === "set_thinking_level",
    );
    expect(setLevel?.cmd).toMatchObject({ level: "high" });
    h.respond(h.TAB, setLevel!.cmd, {});
    await h.flushMicrotasks();
    const modelIdx = h.sent.findIndex(
      (s) => onTab(s) && s.cmd.type === "set_model",
    );
    const levelIdx = h.sent.findIndex(
      (s) => onTab(s) && s.cmd.type === "set_thinking_level",
    );
    const promptIdx = h.sent.findIndex(
      (s) =>
        onTab(s) &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeLessThan(levelIdx);
    expect(levelIdx).toBeLessThan(promptIdx);
    // setModel persists the then-current level first; setThinkingLevel
    // re-persists with the new one, so the last call carries the final pair.
    expect(h.mockBackend.setSessionModel).toHaveBeenLastCalledWith(
      h.TAB,
      "p2/mx",
      "high",
    );
  });

  it("an unchanged staged tuple is a no-op", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          model: { id: "m1", name: "M1", provider: "p" },
          session: { ...emptySessionRuntime(), thinkingLevel: "low" },
        }),
      },
    });
    openReview("m2");
    h.useStore.getState().executePlan(h.TAB, "existing", {
      model: { id: "m1", name: "M1", provider: "p" },
      thinkingLevel: "low",
      advisor: false,
      advisorModel: null,
    });
    await h.flushMicrotasks();
    expect(h.sent.some((s) => s.cmd.type === "set_model")).toBe(false);
    expect(h.sent.some((s) => s.cmd.type === "set_thinking_level")).toBe(false);
    expect(h.mockBackend.setSessionAdvisor).not.toHaveBeenCalled();
    // Staging what is already live must preserve today's behavior exactly.
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
  });

  it("an advisor change relaunches the session before dispatching", async () => {
    h.useStore.setState({
      state: h.stateWithRecord(null),
      rpc: { [h.TAB]: rpcTabState() },
    });
    openReview("a1");
    h.useStore.getState().executePlan(h.TAB, "existing", {
      advisor: true,
      advisorModel: "openrouter/a/b:high",
    });
    await h.flushMicrotasks();
    expect(h.mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      h.TAB,
      true,
      "openrouter/a/b:high",
    );
    const implementationPrompt = () =>
      h.sent.find(
        (s) =>
          s.tabId === h.TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      );
    // The relaunch parked the tab at "starting" — the prompt waits on readiness.
    expect(implementationPrompt()).toBeUndefined();
    h.useStore.setState({
      rpc: { [h.TAB]: { ...h.useStore.getState().rpc[h.TAB]!, status: "ready" } },
    });
    await h.flushMicrotasks();
    const prompt = implementationPrompt();
    expect(prompt).toBeDefined();
    // A relaunched session has no plan turn in flight, so the prompt steers.
    expect(prompt!.cmd.streamingBehavior).toBe("steer");
  });

  it("a failed advisor relaunch never dispatches the prompt", async () => {
    h.useStore.setState({
      state: h.stateWithRecord(null),
      rpc: { [h.TAB]: rpcTabState() },
    });
    openReview("a2");
    h.useStore.getState().executePlan(h.TAB, "existing", {
      advisor: true,
      advisorModel: "openrouter/a/b:high",
    });
    await h.flushMicrotasks();
    expect(h.mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      h.TAB,
      true,
      "openrouter/a/b:high",
    );
    h.useStore.setState({
      rpc: { [h.TAB]: { ...h.useStore.getState().rpc[h.TAB]!, status: "error" } },
    });
    await h.flushMicrotasks();
    expect(
      h.sent.some(
        (s) =>
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      ),
    ).toBe(false);
  });

  it("a fresh session receives the staged advisor tuple and model", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReviewWithPlan("a3");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh", {
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      model: MODEL_X,
      thinkingLevel: "high",
    });
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
      worktree: null,
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const onFresh = (s: (typeof h.sent)[number]) => s.tabId === "fresh-tab";
    const setModel = h.sent.find((s) => onFresh(s) && s.cmd.type === "set_model");
    expect(setModel?.cmd).toMatchObject({ provider: "p2", modelId: "mx" });
    h.respond("fresh-tab", setModel!.cmd, {});
    await h.flushMicrotasks();
    const setLevel = h.sent.find(
      (s) => onFresh(s) && s.cmd.type === "set_thinking_level",
    );
    expect(setLevel?.cmd).toMatchObject({ level: "high" });
    h.respond("fresh-tab", setLevel!.cmd, {});
    await h.flushMicrotasks();
    const modelIdx = h.sent.findIndex(
      (s) => onFresh(s) && s.cmd.type === "set_model",
    );
    const levelIdx = h.sent.findIndex(
      (s) => onFresh(s) && s.cmd.type === "set_thinking_level",
    );
    const promptIdx = h.sent.findIndex(
      (s) => onFresh(s) && s.cmd.type === "prompt",
    );
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeLessThan(levelIdx);
    expect(levelIdx).toBeLessThan(promptIdx);
  });

  it("still shows a plain select dialog when the title is not a plan review", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p5",
      method: "select",
      title: "pick one",
      options: ["a", "b"],
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.planReview).toBeNull();
    expect(tab.extensionQueue).toHaveLength(1);
  });

  it("answers stray host_tool_call with an error result", () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "host_tool_call", id: "h1", name: "x" });
    expect(h.sent.pop()!.cmd).toMatchObject({
      type: "host_tool_result",
      id: "h1",
    });
  });

  it("answers host_uri_request instead of leaving the agent blocked", () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, {
        type: "host_uri_request",
        id: "u1",
        operation: "read",
        url: "db://x",
      });
    expect(h.sent.pop()!.cmd).toMatchObject({
      type: "host_uri_result",
      id: "u1",
      error: "omp-ui registers no uri schemes",
    });
  });

  it("command_output attaches to the newest running command row", () => {
    const first = commandItem("usage", "");
    const second = commandItem("context", "");
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ items: [first, second] }) },
    });
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "command_output", text: "out-1" });
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "command_output", text: "out-2" });
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(items[0]).toBe(first);
    expect(items[1]).toMatchObject({ id: second.id, output: "out-1\nout-2" });
  });

  it("command_output with no running command row falls back to a notice", () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "command_output", text: "stray reply" });
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "notice",
      text: "stray reply",
      level: "info",
    });
  });

  it("command_output accumulation is capped, head-preserving", () => {
    const item = commandItem("usage", "");
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ items: [item] }) } });
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "command_output", text: "x".repeat(64 * 1024) });
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "command_output", text: "tail" });
    const updated = h.useStore.getState().rpc[h.TAB]!.items[0]!;
    expect(updated.kind).toBe("command");
    const output = updated.kind === "command" ? updated.output! : "";
    expect(output.length).toBeLessThanOrEqual(64 * 1024 + 24);
    expect(output.startsWith("xxx")).toBe(true);
    expect(output.endsWith("… output truncated")).toBe(true);
  });

  it("available_commands_update replaces the command palette", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "available_commands_update",
      commands: [
        { name: "stats", description: "show stats", source: "builtin" },
        {
          name: "model",
          aliases: ["m"],
          description: "pick model",
          source: "builtin",
        },
        { name: 42 },
      ],
    });
    const { commands } = h.useStore.getState().rpc[h.TAB]!;
    expect(commands.map((c) => c.name)).toEqual(["stats", "model"]);
    expect(commands[1]).toMatchObject({
      aliases: ["m"],
      description: "pick model",
    });
  });

  it("extension_error surfaces as a rose-worthy error notice", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_error",
      extensionPath: "/ext/foo.ts",
      error: "boom",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "notice",
        text: "boom",
        level: "error",
        source: "/ext/foo.ts",
      }),
    ]);
  });

  it("subagent frames mark the transcript and refresh the roster", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "subagent_lifecycle",
      payload: { id: "s1", agent: "scout", status: "started", index: 0 },
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "marker",
        label: "subagent scout: started",
        tone: "copper",
      }),
    ]);
    expect(h.sent.some((s) => s.cmd.type === "get_subagents")).toBe(true);
  });

  it("thinking_level_changed patches the session as well as the transcript", () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, {
        type: "thinking_level_changed",
        thinkingLevel: "max",
      });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.session.thinkingLevel).toBe("max");
    expect(tab.items).toEqual([
      expect.objectContaining({ kind: "marker", label: "thinking level: max" }),
    ]);
  });

  it("session_info_update and config_update merge into session/model", () => {
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "session_info_update",
      title: "Renamed",
      sessionId: "sess-9",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.session.sessionId).toBe("sess-9");
    store.handleRpcFrame(h.TAB, {
      type: "config_update",
      model: { id: "m2", name: "M Two", provider: "openai" },
      thinkingLevel: "low",
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.model).toMatchObject({ id: "m2", provider: "openai" });
    // A partial frame must not wipe what get_state already established.
    expect(tab.session).toMatchObject({
      sessionId: "sess-9",
      thinkingLevel: "low",
    });
  });
});

describe("stall auto-continue (issue #251)", () => {
  // The loop-guard state lives in module-scoped watchers keyed by tab id, so
  // each test owns its own tab: a shared id would leak counts between cases.
  /** The incident's terminal message_end: the provider watchdog's stall abort. */
  const stallEndFrame = () => ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Findings: …" }],
      stopReason: "error",
      errorMessage: "OpenAI responses stream stalled while waiting for the next event",
      errorId: 397312, // 0x4000 timeout bit set
    },
  });

  const continuePrompts = () =>
    h.sent.filter((s) => s.cmd.type === "prompt" && s.cmd.message === STALL_CONTINUE_LEAD);

  it("continues a stalled turn end with a bounded follow-up prompt (incident replay)", async () => {
    const T = "tab-stall-a";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      // The real frame sequence of session 01a024fc (issue #250's incident):
      // the ask's args are still streaming when the model stream goes silent.
      store.handleRpcFrame(T, {
        type: "tool_execution_start",
        toolCallId: "tA",
        toolName: "ask",
        args: { i: "Choosing radiance build path" },
      });
      store.handleRpcFrame(T, {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "Choosing radiance build path",
          partial: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tA",
                name: "ask",
                arguments: { i: "Choosing radiance build path" },
              },
            ],
          },
        },
      });
      // Ninety seconds of silence later, omp's provider watchdog aborts.
      store.handleRpcFrame(T, stallEndFrame());
      store.handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();

    // The in-flight ask card reads aborted, not cancelled.
    const items = h.useStore.getState().rpc[T]!.items;
    const tools = items.filter((i) => i.kind === "tool");
    expect(tools).not.toHaveLength(0);
    for (const t of tools) expect(t).toMatchObject({ status: "aborted" });

    // The #100 diagnostic posted at the error turn-end.
    const diagnostic = items.find(
      (i): i is NoticeItem =>
        i.kind === "notice" && i.level === "warn" && i.text.includes("provider stream stall"),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.text).toContain("OpenAI responses stream stalled");

    // The continue announced itself, then went out as a followUp prompt.
    const announced = items.find(
      (i) => i.kind === "notice" && i.level === "info" && i.text.includes("stall auto-continue #1"),
    );
    expect(announced).toBeDefined();
    const prompts = continuePrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.cmd).toMatchObject({ streamingBehavior: "followUp" });
  });

  it("posts the diagnostic but sends no continue when the app switch is off", async () => {
    const T = "tab-stall-b";
    vi.useFakeTimers();
    try {
      h.backendState = { ...h.backendState, stallAutoContinue: false };
      h.useStore.setState({
        state: h.backendState,
        rpc: { [T]: rpcTabState({ status: "running" }) },
      });
      const store = h.useStore.getState();
      store.handleRpcFrame(T, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
      });
      store.handleRpcFrame(T, stallEndFrame());
      store.handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    const items = h.useStore.getState().rpc[T]!.items;
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(true);
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("stall auto-continue")),
    ).toBe(false);
  });

  it("does not continue a user interrupt: the card cancels, no diagnostic, no prompt", async () => {
    const T = "tab-stall-c";
    h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
    const store = h.useStore.getState();
    store.handleRpcFrame(T, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    store.handleRpcFrame(T, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "on it" }],
        stopReason: "aborted",
      },
    });
    store.handleRpcFrame(T, { type: "agent_end" });
    await h.flushMicrotasks();
    const items = h.useStore.getState().rpc[T]!.items;
    const tool = items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ status: "cancelled" });
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(false);
  });

  it("aborts cards on a non-stall error end, with no diagnostic and no continue", async () => {
    const T = "tab-stall-d";
    h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
    const store = h.useStore.getState();
    store.handleRpcFrame(T, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    store.handleRpcFrame(T, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "half done" }],
        stopReason: "error",
        errorMessage: "provider 500",
      },
    });
    store.handleRpcFrame(T, { type: "agent_end" });
    await h.flushMicrotasks();
    const items = h.useStore.getState().rpc[T]!.items;
    const tool = items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ status: "aborted" });
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(false);
  });

  it("a watchdog abort notice feeds auto-continue", async () => {
    const T = "tab-stall-w1";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      // Main's stall watchdog aborted the turn and reported it (issue #253);
      // the tagged notice frame is the only stall marker — the turn itself
      // ends with stopReason "aborted", invisible to isStreamStallEnd.
      store.handleRpcFrame(T, {
        type: "omp_ui_notice",
        level: "warn",
        source: "omp-ui",
        reason: "stall-abort",
        message: "omp-ui aborted a stalled turn #1 — no stream events for 90s",
      });
      store.handleRpcFrame(T, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "half done" }],
          stopReason: "aborted",
        },
      });
      store.handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();

    const items = h.useStore.getState().rpc[T]!.items;
    // Main's notice is the diagnostic — no provider-stall diagnostic on top.
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(false);
    expect(
      items.some(
        (i) =>
          i.kind === "notice" && i.level === "info" && i.text.includes("stall auto-continue #1"),
      ),
    ).toBe(true);
    const prompts = continuePrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.cmd).toMatchObject({ streamingBehavior: "followUp" });
    // Consumed at the turn boundary: a later non-stall end must not continue.
    expect(h.useStore.getState().rpc[T]!.stallAbortPending ?? false).toBe(false);
  });

  it("the app switch also gates watchdog-abort continues", async () => {
    const T = "tab-stall-w2";
    vi.useFakeTimers();
    try {
      h.backendState = { ...h.backendState, stallAutoContinue: false };
      h.useStore.setState({
        state: h.backendState,
        rpc: { [T]: rpcTabState({ status: "running" }) },
      });
      const store = h.useStore.getState();
      store.handleRpcFrame(T, {
        type: "omp_ui_notice",
        level: "warn",
        source: "omp-ui",
        reason: "stall-abort",
        message: "omp-ui aborted a stalled turn #1 — no stream events for 90s",
      });
      store.handleRpcFrame(T, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "half done" }],
          stopReason: "aborted",
        },
      });
      store.handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();

    const items = h.useStore.getState().rpc[T]!.items;
    // The abort report still lands in the transcript; only the continue is gated.
    expect(
      items.some(
        (i) =>
          i.kind === "notice" && i.level === "warn" && i.text.includes("aborted a stalled turn"),
      ),
    ).toBe(true);
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
  });

  it("an untagged omp_ui_notice does not arm auto-continue", async () => {
    const T = "tab-stall-w3";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      store.handleRpcFrame(T, {
        type: "omp_ui_notice",
        level: "warn",
        source: "omp-ui",
        message: "omp-ui: some unrelated advisory",
      });
      store.handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();

    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    expect(h.useStore.getState().rpc[T]!.stallAbortPending ?? false).toBe(false);
  });

  it("caps consecutive continues, then re-arms on a user prompt", async () => {
    const T = "tab-stall-e";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      // One stalled turn end: the continue prompt goes out, then its turn
      // (simulated) dies to a stall again.
      const stalledTurn = async () => {
        h.useStore.setState((s) => ({
          rpc: { ...s.rpc, [T]: { ...s.rpc[T]!, status: "running" } },
        }));
        h.useStore.getState().handleRpcFrame(T, stallEndFrame());
        h.useStore.getState().handleRpcFrame(T, { type: "agent_end" });
        await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
      };

      await stalledTurn();
      expect(continuePrompts()).toHaveLength(1);
      await stalledTurn();
      expect(continuePrompts()).toHaveLength(2);

      // A third consecutive stall hits the cap: explained once, nothing sent.
      await stalledTurn();
      expect(continuePrompts()).toHaveLength(2);
      const capped = h.useStore
        .getState()
        .rpc[T]!.items.filter(
          (i) => i.kind === "notice" && i.text === STALL_CONTINUE_CAP_NOTICE,
        );
      expect(capped).toHaveLength(1);

      // The OS-notification cap report latched exactly once, and clears on the
      // user prompt that re-arms the guard.
      expect(h.mockBackend.reportStallCap).toHaveBeenCalledTimes(1);
      expect(h.mockBackend.reportStallCap).toHaveBeenCalledWith(T, true);

      // The per-session stall counter (issue #100 numbering) advanced across
      // stalls — stallNotice must mutate the live tab, not the frame-start
      // capture the ready patch above it replaced.
      const stallNotices = h.useStore
        .getState()
        .rpc[T]!.items.filter(
          (i): i is NoticeItem =>
            i.kind === "notice" && i.text.includes("provider stream stall"),
        );
      expect(stallNotices.map((n) => n.text)).toEqual([
        expect.stringContaining("provider stream stall #1"),
        expect.stringContaining("provider stream stall #2"),
        expect.stringContaining("provider stream stall #3"),
      ]);

      // A user prompt re-arms the guard: the next stall gets its continue.
      void h.useStore.getState().sendPrompt(T, "carry on");
      await stalledTurn();
      expect(continuePrompts()).toHaveLength(3);
      expect(h.mockBackend.reportStallCap).toHaveBeenCalledTimes(2);
      expect(h.mockBackend.reportStallCap).toHaveBeenLastCalledWith(T, false);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
  });

  it("a user prompt inside the settle window wins the race", async () => {
    const T = "tab-stall-f";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      store.handleRpcFrame(T, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
      });
      store.handleRpcFrame(T, stallEndFrame());
      store.handleRpcFrame(T, { type: "agent_end" });
      // The user sees the error and types their own continuation.
      void h.useStore.getState().sendPrompt(T, "carry on where you stopped");
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
    const prompts = h.sent.filter((s) => s.cmd.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.cmd.message).toBe("carry on where you stopped");
  });

  it("does not dispatch into a process that died inside the settle window", async () => {
    const T = "tab-stall-g";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      store.handleRpcFrame(T, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
      });
      store.handleRpcFrame(T, stallEndFrame());
      store.handleRpcFrame(T, { type: "agent_end" });
      // The session process dies before the settle window closes.
      h.useStore.setState((s) => ({ exited: { ...s.exited, [T]: 1 } }));
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
  });

  it("the auto-continue does not reset the advisor-reply streak", async () => {
    const T = "tab-stall-h";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      // The production sequence, load-bearing for the advisor watcher's cursor:
      // the reviewed turn's agent_end lands while the tab still reads running
      // (seeding the baseline past the marker), then the review arrives on the
      // idle session.
      const review = async (note: string) => {
        h.useStore.setState((s) => ({
          rpc: { ...s.rpc, [T]: { ...s.rpc[T]!, status: "running" } },
        }));
        h.useStore.getState().handleRpcFrame(T, { type: "agent_end" });
        h.useStore.getState().handleRpcFrame(T, {
          type: "message_end",
          message: {
            role: "custom",
            customType: "advisor",
            content: "<advisory/>",
            details: { notes: [{ note, severity: "concern", advisor: "ops" }] },
          },
        });
        await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
      };
      const advisorReplies = () =>
        h.sent.filter(
          (s) => s.cmd.type === "prompt" && String(s.cmd.message).startsWith(ADVISOR_REPLY_LEAD),
        );

      // Two reviews fill the reply guard's budget.
      await review("first finding");
      expect(advisorReplies()).toHaveLength(1);
      await review("second finding");
      expect(advisorReplies()).toHaveLength(2);

      // A stall end dispatches its continue; the advisor guard must not reset.
      h.useStore.setState((s) => ({
        rpc: { ...s.rpc, [T]: { ...s.rpc[T]!, status: "running" } },
      }));
      h.useStore.getState().handleRpcFrame(T, stallEndFrame());
      h.useStore.getState().handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
      expect(continuePrompts()).toHaveLength(1);

      // A third review arrives: the guard is still capped, so it explains
      // instead of answering. Had the continue reset it, the reply would go out.
      await review("third finding");
      expect(advisorReplies()).toHaveLength(2);
      const capNotice = h.useStore.getState().rpc[T]!.items.find(
        (i) => i.kind === "notice" && i.text === ADVISOR_REPLY_CAP_NOTICE,
      );
      expect(capNotice).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
  });
});

describe("initialization snapshot ordering", () => {
  it("registers listeners first, starts all reads together, and commits only after the slowest", async () => {
    const stateRead = h.deferred<BackendState>();
    const appRead = h.deferred<AppUpdateState>();
    const ompRead = h.deferred<OmpUpdateState>();
    const remoteRead = h.deferred<RemoteState>();
    const oauthRead = h.deferred<ProviderOAuthState>();
    const initialState = makeBackendState();
    const initialApp = { ...h.idleAppUpdate, currentVersion: "9.8.7" };
    const initialOmp = { ...h.idleOmpUpdate, installedVersion: "1.2.3" };
    const initialRemote = { ...h.idleRemoteState, enabled: true };
    const initialOauth = { ...h.idleProviderOAuth, phase: "done" as const };
    h.mockBackend.getState.mockImplementationOnce(() => stateRead.promise);
    h.mockBackend.getAppUpdateState.mockImplementationOnce(() => appRead.promise);
    h.mockBackend.getOmpUpdateState.mockImplementationOnce(() => ompRead.promise);
    h.mockBackend.getRemoteState.mockImplementationOnce(() => remoteRead.promise);
    h.mockBackend.getProviderOAuthState.mockImplementationOnce(() => oauthRead.promise);
    // init's StrictMode latch is module-scoped; an earlier routing test initializes
    // the shared store, so this contract test intentionally needs a fresh evaluation.
    vi.resetModules();
    const { useStore: freshStore } = await import("../../store");

    const init = freshStore.getState().init();
    const duplicate = freshStore.getState().init();

    const listeners = [
      h.mockBackend.onStateChanged,
      h.mockBackend.onPtyData,
      h.mockBackend.onPtyExit,
      h.mockBackend.onSessionHibernated,
      h.mockBackend.onShellData,
      h.mockBackend.onShellExit,
      h.mockBackend.onRpcFrame,
      h.mockBackend.onAppUpdateState,
      h.mockBackend.onOmpUpdateState,
      h.mockBackend.onRemoteState,
      h.mockBackend.onProviderOAuthState,
    ];
    const reads = [
      h.mockBackend.getState,
      h.mockBackend.getAppUpdateState,
      h.mockBackend.getOmpUpdateState,
      h.mockBackend.getRemoteState,
      h.mockBackend.getProviderOAuthState,
    ];
    expect(
      listeners.every((listener) => listener.mock.calls.length === 1),
    ).toBe(true);
    expect(reads.every((read) => read.mock.calls.length === 1)).toBe(true);
    expect(
      Math.max(
        ...listeners.map((listener) => listener.mock.invocationCallOrder[0]!),
      ),
    ).toBeLessThan(
      Math.min(...reads.map((read) => read.mock.invocationCallOrder[0]!)),
    );

    stateRead.resolve(initialState);
    appRead.resolve(initialApp);
    ompRead.resolve(initialOmp);
    await h.flushMicrotasks();
    expect(freshStore.getState()).toMatchObject({
      state: null,
      appUpdate: h.idleAppUpdate,
      ompUpdate: h.idleOmpUpdate,
      remote: { ...h.idleRemoteState, token: "" },
      providerOAuth: h.idleProviderOAuth,
    });

    remoteRead.resolve(initialRemote);
    oauthRead.resolve(initialOauth);
    await Promise.all([init, duplicate]);
    expect(freshStore.getState()).toMatchObject({
      state: initialState,
      appUpdate: initialApp,
      ompUpdate: initialOmp,
      remote: initialRemote,
      providerOAuth: initialOauth,
    });
  });
});

describe("transcript commit batching (issue #187)", () => {
  // The file-level window stub executes rAF synchronously so every other
  // suite sees committed items immediately. These tests capture the frame
  // instead and run it by hand, which is what proves the coalescing.
  let rafQueue: FrameRequestCallback[];
  let syncRaf: typeof window.requestAnimationFrame;
  let syncCancel: typeof window.cancelAnimationFrame;

  const runFrame = (): void => {
    const callbacks = rafQueue.splice(0);
    for (const cb of callbacks) cb(0);
  };

  const advisorFrame = (note: string) => ({
    type: "message_end",
    message: {
      role: "custom",
      customType: "advisor",
      content: "<advisory/>",
      details: { notes: [{ note, severity: "concern", advisor: "ops" }] },
    },
  });

  beforeEach(() => {
    rafQueue = [];
    syncRaf = window.requestAnimationFrame;
    syncCancel = window.cancelAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
      rafQueue.push(cb);
    window.cancelAnimationFrame = (): void => {};
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  afterEach(() => {
    window.requestAnimationFrame = syncRaf;
    window.cancelAnimationFrame = syncCancel;
    // Never leak a pending batch into the next test's state.
    runFrame();
  });

  it("coalesces a burst of transcript frames into one render commit", () => {
    const commits: number[] = [];
    const unsub = h.useStore.subscribe((state, prev) => {
      if (state.rpc[h.TAB]?.items !== prev.rpc[h.TAB]?.items)
        commits.push(state.rpc[h.TAB]!.items.length);
    });
    try {
      const store = h.useStore.getState();
      store.handleRpcFrame(h.TAB, {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      });
      store.handleRpcFrame(h.TAB, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "a" },
      });
      store.handleRpcFrame(h.TAB, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "b" },
      });
      // Nothing committed yet — the renderer stays free for input mid-burst.
      expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);
      expect(rafQueue).toHaveLength(1);
      runFrame();
      expect(commits).toEqual([2]);
      const items = h.useStore.getState().rpc[h.TAB]!.items;
      expect(items[0]).toMatchObject({ kind: "user", text: "go" });
      expect(items[1]).toMatchObject({
        kind: "assistant",
        text: "ab",
        streaming: true,
      });
    } finally {
      unsub();
    }
  });

  it("commits each later burst separately with frame order preserved", () => {
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "q1" }] },
    });
    runFrame();
    store.handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "q2" }] },
    });
    expect(
      h.useStore.getState().rpc[h.TAB]!.items.map((i) => i.kind),
    ).toEqual(["user"]);
    runFrame();
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(items.map((i) => (i.kind === "user" ? i.text : ""))).toEqual([
      "q1",
      "q2",
    ]);
  });

  it("keeps control frames immediate while a transcript commit is pending", async () => {
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    });
    expect(rafQueue).toHaveLength(1);
    // A dialog request must not wait for the flush — omp blocks on its reply.
    store.handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e1",
      method: "confirm",
      title: "sure?",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.extensionQueue).toHaveLength(1);
    // A command response also resolves without waiting for the flush.
    const cmd = store.rpcCommand(h.TAB, { type: "get_state" });
    h.respond(h.TAB, h.sent.pop()!.cmd, {});
    await expect(cmd).resolves.toBeDefined();
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);
    runFrame();
    expect(h.useStore.getState().rpc[h.TAB]!.items).toHaveLength(1);
  });

  it("settles running tools from the pending batch on process death", () => {
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "make" },
    });
    // The card exists only in the pending batch.
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);
    store.handleRpcFrame(h.TAB, { type: "omp_ui_error", message: "process gone" });
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(items).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "t1",
        status: "aborted",
      }),
    ]);
    // The aborted commit landed immediately; the dead batch is gone.
    runFrame();
    expect(h.useStore.getState().rpc[h.TAB]!.items).toHaveLength(1);
  });

  it("drops a pending batch on relaunch so stale frames cannot land", async () => {
    h.useStore.setState({ state: h.stateWithRecord(null) });
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "old" },
    });
    expect(rafQueue).toHaveLength(1);
    h.mockBackend.restartSession.mockResolvedValueOnce(undefined);
    await store.restartSession(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);
    runFrame();
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);
  });

  it("feeds the advisor reply watcher from the pending batch, not the commit", async () => {
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      store.handleRpcFrame(h.TAB, { type: "agent_end" });
      runFrame(); // commits only the "agent finished" marker
      store.handleRpcFrame(h.TAB, advisorFrame("Do it now"));
      // The advisory lives only in the pending batch — never flushed here.
      expect(
        h.useStore.getState().rpc[h.TAB]!.items.some((i) => i.kind === "advisory"),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
      await h.flushMicrotasks();
      const replies = h.sent.filter((s) => s.cmd.type === "prompt");
      expect(replies).toHaveLength(1);
      expect(String(replies[0]!.cmd.message)).toContain("Do it now");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("live stream-stall indicator (issue #228)", () => {
  const BLOCK_EVENTS = [
    "text_start",
    "text_end",
    "thinking_start",
    "thinking_end",
  ] as const;

  const BLOCK_LABELS = [
    "text block started",
    "text block complete",
    "thinking block started",
    "thinking block complete",
  ] as const;

  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  /** agent_start plus an open assistant response: the stall gate is armed. */
  const openAssistant = (): void => {
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "turn_start" });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
  };

  afterEach(() => {
    // Terminate any armed interval before the fake clock is discarded; a
    // stale map entry would block re-arming in a later test.
    if (vi.isFakeTimers()) {
      h.useStore.setState({ rpc: {} });
      vi.advanceTimersByTime(1_000);
    }
    vi.useRealTimers();
  });

  it("pins the 30s threshold and 1Hz tick from the plan", () => {
    expect(h.STREAM_STALL_THRESHOLD_MS).toBe(30_000);
    expect(h.STREAM_STALL_TICK_MS).toBe(1_000);
  });

  it("arms at the threshold and ticks once per second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    vi.advanceTimersByTime(2_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS + 2_000,
    );
  });

  it("clears within one tick when a model-stream frame resumes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    vi.advanceTimersByTime(1_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
  });

  it("classifies each block start/end event as its own checkpoint", () => {
    vi.useFakeTimers();
    for (const [i, type] of BLOCK_EVENTS.entries()) {
      // A distinct time per event: an unclassified event would leave the
      // previous checkpoint in place and fail both assertions.
      vi.setSystemTime(1_000_000 + i * 10_000);
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 0 },
      });
      expect(h.useStore.getState().rpc[h.TAB]!.streamCheckpoint).toMatchObject({
        at: 1_000_000 + i * 10_000,
        label: BLOCK_LABELS[i],
      });
    }
  });

  it("publishes whole-second (floor) values for off-boundary checkpoints", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    // The response opens 37ms after the interval armed, so every 1s tick
    // boundary sees an off-boundary silence (ceil would overstate it).
    vi.advanceTimersByTime(37);
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
    // Until the first tick that reaches the threshold (silence 30,963ms).
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS + 963);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
  });

  it("block start/end frames reset the silence clock mid-stall", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    for (const type of BLOCK_EVENTS) {
      // Each classified block event restarts the silence clock...
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 0 },
      });
      vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
      expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
        h.STREAM_STALL_THRESHOLD_MS,
      );
      // ...and the next frame clears the indicator within one tick.
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 0 },
      });
      vi.advanceTimersByTime(1_000);
      expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    }
  });

  it("keeps ticking while an auto-retry notice is on screen", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    // omp gives up and schedules a retry: the #100 notice lands...
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 10,
      delayMs: 2000,
      errorMessage:
        "OpenAI responses stream stalled while waiting for the next event",
    });
    // ...and the live indicator keeps ticking on the same clock (the retry
    // frame does not reset it).
    vi.advanceTimersByTime(1_000);
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.streamStallMs).toBe(h.STREAM_STALL_THRESHOLD_MS + 1_000);
    expect(tab.items.at(-1)).toMatchObject({ kind: "notice", level: "warn" });
  });

  it("never arms during local tool execution, then re-arms on the next response", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_end",
      message: { role: "assistant" },
    });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    vi.advanceTimersByTime(60_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    // The next assistant response in the same run re-arms the clock:
    // every frame while "running" defensively arms it.
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
  });

  it("agent_end clears the field and stops the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.streamStallMs).toBeUndefined();
    expect(tab.status).toBe("ready");
    // The clock is stopped: no re-arm, no re-patch, ever.
    vi.advanceTimersByTime(120_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
  });

  it("relaunch resets the field and the checkpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openAssistant();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    expect(h.useStore.getState().rpc[h.TAB]!.streamCheckpoint).toBeDefined();
    // The explicit stop is observable without advancing the clock: the armed
    // interval is gone the moment the relaunch lands (self-termination would
    // only remove it on the next tick).
    const timersBefore = vi.getTimerCount();
    h.mockBackend.restartSession.mockResolvedValueOnce(undefined);
    await h.useStore.getState().restartSession(h.TAB);
    expect(vi.getTimerCount()).toBe(timersBefore - 1);
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.status).toBe("starting");
    expect(tab.streamStallMs).toBeUndefined();
    expect(tab.streamCheckpoint).toBeUndefined();
    // The clock is stopped: nothing can re-arm it while "starting".
    vi.advanceTimersByTime(120_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
  });

  it("does not claim a stall before it has seen a checkpoint (late joiner)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    // A client that joined mid-response: the transcript shows an open
    // assistant, but this client has seen no model-stream frame — it cannot
    // time what it never saw.
    h.useStore.setState((s) => {
      const t = s.rpc[h.TAB]!;
      return {
        rpc: {
          ...s.rpc,
          [h.TAB]: {
            ...t,
            items: [
              {
                kind: "assistant",
                id: "a-late",
                text: "",
                thinking: "",
                streaming: true,
              },
            ],
          },
        },
      };
    });
    vi.advanceTimersByTime(60_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    // The first frame this client sees sets the clock — and arms it.
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
  });

  it("omp_ui_error clears the field and sets the error status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "omp_ui_error",
      message: "boom",
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.streamStallMs).toBeUndefined();
    expect(tab.status).toBe("error");
  });

  it("silent process death stops the clock and clears the field", async () => {
    // A fresh module: init latches per evaluation, and the shell-routing
    // suite already owns the shared module's listener captures.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.resetModules();
    const { useStore: fresh } = await import("../../store");
    fresh.setState({ rpc: { [h.TAB]: rpcTabState() } });
    fresh.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    fresh.getState().handleRpcFrame(h.TAB, { type: "turn_start" });
    fresh.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
    const init = fresh.getState().init();
    // No tool cards were running — the pure-text-stall shape.
    const exitCb = h.mockBackend.onPtyExit.mock.calls[0]![0] as (
      tabId: string,
      code: number,
    ) => void;
    await init;
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(fresh.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    exitCb(h.TAB, 1);
    expect(fresh.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    expect(fresh.getState().exited[h.TAB]).toBe(1);
    vi.advanceTimersByTime(120_000);
    expect(fresh.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
  });
});

