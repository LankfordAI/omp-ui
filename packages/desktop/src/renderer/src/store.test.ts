import { describe, expect, it, vi } from "vitest";
import type {
  BackendState,
  LiveState,
  OmpSettingsSnapshot,
  RemoteState,
} from "@omp-ui/core/types";
import { emptySessionRuntime } from "./lib/rpc-types";
import {
  backendState as makeBackendState,
  rpcTabState,
  tabInfo,
} from "./test/fixtures";
import { h } from "./test/store-harness";


describe("deriveSidebarSessionState", () => {
  const summary = () => h.stateWithRecord(null).projects[0]!.sessions[0]!;

  it("derives every lifecycle and native RPC activity state from authoritative inputs", () => {
    for (const live of ["dormant", "archived", "missing"] as const) {
      expect(
        h.deriveSidebarSessionState(
          { ...summary(), live },
          rpcTabState(),
          undefined,
        ),
      ).toBe(live);
    }

    expect(
      h.deriveSidebarSessionState(
        { ...summary(), mode: "pty" },
        rpcTabState({ status: "running" }),
        undefined,
      ),
    ).toBe("live");
    expect(h.deriveSidebarSessionState(summary(), undefined, undefined)).toBe(
      "live",
    );
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "running" }),
        0,
      ),
    ).toBe("dormant");

    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "starting" }),
        undefined,
      ),
    ).toBe("starting");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "error" }),
        undefined,
      ),
    ).toBe("error");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "running" }),
        undefined,
      ),
    ).toBe("working");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "ready" }),
        undefined,
      ),
    ).toBe("ready");

    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "ready", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("awaiting-answer");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({
          status: "running",
          planReview: {
            request: {
              title: "review",
              planFilePath: "local://p.md",
              planAbsPath: null,
            },
            frame: { id: "p" },
          },
        }),
        undefined,
      ),
    ).toBe("awaiting-answer");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "error", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("error");
    // Issue #248: a watchdog-aborted turn badges the row stalled, outranking
    // an awaiting answer — the user must prompt to continue either way.
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), streamStalled: true },
        rpcTabState({ status: "ready" }),
        undefined,
      ),
    ).toBe("stalled");
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), streamStalled: true },
        rpcTabState({ status: "ready", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("stalled");
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), streamStalled: true },
        rpcTabState({ status: "error" }),
        undefined,
      ),
    ).toBe("error");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "ready", busy: true }),
        undefined,
      ),
    ).toBe("ready");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({
          status: "ready",
          session: { ...emptySessionRuntime(), isStreaming: true },
        }),
        undefined,
      ),
    ).toBe("ready");
  });

  it("tracks queued answers in FIFO order through a complete agent turn", () => {
    const current = () =>
      h.deriveSidebarSessionState(
        summary(),
        h.useStore.getState().rpc[h.TAB],
        undefined,
      );
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    expect(current()).toBe("ready");

    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    expect(current()).toBe("working");
    for (const id of ["q1", "q2"]) {
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "extension_ui_request",
        id,
        method: "confirm",
        title: `confirm ${id}`,
      });
    }
    expect(current()).toBe("awaiting-answer");

    let request = h.useStore.getState().rpc[h.TAB]!.extensionQueue[0];
    h.useStore.getState().answerExtension(h.TAB, request, { confirmed: true });
    expect(current()).toBe("awaiting-answer");
    request = h.useStore.getState().rpc[h.TAB]!.extensionQueue[0];
    h.useStore.getState().answerExtension(h.TAB, request, { confirmed: true });
    expect(current()).toBe("working");

    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    expect(current()).toBe("ready");
  });

  it("tracks a plan-review gate until refinePlan answers it", () => {
    const current = () =>
      h.deriveSidebarSessionState(
        summary(),
        h.useStore.getState().rpc[h.TAB],
        undefined,
      );
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "plan-1",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "p", planFilePath: "local://p.md" }),
    });
    expect(current()).toBe("awaiting-answer");

    h.useStore.getState().refinePlan(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).toBeNull();
    expect(current()).toBe("working");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    expect(current()).toBe("ready");
  });

  it("does not mistake non-dialog extension traffic for a pending answer", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "notice-1",
      method: "notify",
      message: "done",
    });
    expect(
      h.deriveSidebarSessionState(
        summary(),
        h.useStore.getState().rpc[h.TAB],
        undefined,
      ),
    ).toBe("ready");
  });
});

describe("settings", () => {
  it("opens on general by default, honours an explicit page, and closes back to null", () => {
    h.useStore.getState().openSettings();
    expect(h.useStore.getState().settingsPage).toBe("general");

    h.useStore.getState().openSettings("memory");
    expect(h.useStore.getState().settingsPage).toBe("memory");

    h.useStore.getState().closeSettings();
    expect(h.useStore.getState().settingsPage).toBeNull();
  });

  it("caches the effective compaction threshold per project (issue #249)", async () => {
    h.mockBackend.readOmpSettings.mockResolvedValueOnce({
      ...h.emptyOmpSettings,
      entries: [
        { key: "compaction.thresholdPercent", type: "number", description: "", value: -1, options: null, layer: "default" },
        { key: "compaction.thresholdTokens", type: "number", description: "", value: -1, options: null, layer: "default" },
      ],
    });

    await h.useStore.getState().ensureCompactionSettings("/p");

    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledWith("/p");
    expect(h.useStore.getState().compactionSettings["/p"]).toEqual({
      thresholdPercent: -1,
      thresholdTokens: -1,
    });

    // A second ensure is a cache hit — no second backend round trip.
    await h.useStore.getState().ensureCompactionSettings("/p");
    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent compaction settings reads for one project", async () => {
    let resolveRead!: (snapshot: OmpSettingsSnapshot) => void;
    h.mockBackend.readOmpSettings.mockImplementationOnce(
      () => new Promise<OmpSettingsSnapshot>((resolve) => { resolveRead = resolve; }),
    );
    const inFlight = Promise.all([
      h.useStore.getState().ensureCompactionSettings("/p"),
      h.useStore.getState().ensureCompactionSettings("/p"),
    ]);
    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
    resolveRead(h.emptyOmpSettings);
    await inFlight;
    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
    expect(h.useStore.getState().compactionSettings["/p"]).toEqual({});
  });

  it("caches a failed compaction settings read as null, not a default", async () => {
    h.mockBackend.readOmpSettings.mockResolvedValueOnce({
      ...h.emptyOmpSettings,
      error: "omp binary not found",
    });

    await h.useStore.getState().ensureCompactionSettings("/p");

    expect(h.useStore.getState().compactionSettings["/p"]).toBeNull();
    // The failure is cached too: the next ensure must not hammer a missing
    // binary — the HUD only refetches after a compaction.* write or relaunch.
    await h.useStore.getState().ensureCompactionSettings("/p");
    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
  });

  it("clears the compaction cache on compaction.* writes only", async () => {
    await h.useStore.getState().ensureCompactionSettings("/p");
    expect("/p" in h.useStore.getState().compactionSettings).toBe(true);

    await h.useStore.getState().writeOmpSetting("advisor.enabled", true);
    expect("/p" in h.useStore.getState().compactionSettings).toBe(true);

    await h.useStore.getState().writeOmpSetting("compaction.thresholdPercent", 50);
    expect(h.useStore.getState().compactionSettings).toEqual({});
  });

  it("rejects writeOmpSetting to its caller instead of alerting", async () => {
    h.mockBackend.writeOmpSetting.mockRejectedValueOnce(
      new Error("unknown setting"),
    );

    // The omp settings page renders this inline, so the rejection must survive
    // the store rather than being swallowed into window.alert.
    await expect(
      h.useStore.getState().writeOmpSetting("advisor.enabled", true),
    ).rejects.toThrow("unknown setting");
    expect(h.alerts).toEqual([]);
  });
});

describe("remote access settings", () => {
  it("renders remote state only from the push, never an optimistic set", () => {
    // The pushed RemoteState IS the rendered one: main/remote-server.ts publishes a full state
    // per transition, so the store never patches a field itself.
    const push = (s: RemoteState): void => h.useStore.setState({ remote: s });
    push({ ...h.idleRemoteState, status: "starting", enabled: true });
    expect(h.useStore.getState().remote.status).toBe("starting");
    push({
      ...h.idleRemoteState,
      status: "listening",
      enabled: true,
      urls: ["http://127.0.0.1:4677/?t=t"],
    });
    expect(h.useStore.getState().remote.urls).toEqual([
      "http://127.0.0.1:4677/?t=t",
    ]);

    // An action's resolution changes nothing on its own — only the next push does.
    void h.useStore.getState().setRemoteEnabled(false);
    expect(h.useStore.getState().remote.enabled).toBe(true);
  });

  it("alerts a real remote-settings failure", async () => {
    h.mockBackend.setRemotePort.mockRejectedValueOnce(
      new Error("port must be a whole number between 1024 and 65535"),
    );
    await h.useStore.getState().setRemotePort(80);
    expect(h.alerts).toEqual([
      "port must be a whole number between 1024 and 65535",
    ]);
  });

  it("swallows the self-inflicted disconnect a remote client causes", async () => {
    // A REMOTE client changing bind/port/token restarts the server it is asking over, so its own
    // call never gets a reply. That is the requested outcome — the reconnect banner handles it,
    // and a modal alert would both lie and block the banner's reload.
    for (const [action, arg] of [
      ["setRemoteEnabled", true],
      ["setRemoteBind", "lan"],
      ["setRemotePort", 5000],
      ["regenerateRemoteToken", undefined],
      ["setRemotePassword", "short"],
      ["clearRemotePassword", undefined],
    ] as const) {
      h.mockBackend[action].mockRejectedValueOnce(
        new Error("remote connection lost"),
      );
      await (h.useStore.getState()[action] as (a?: unknown) => Promise<void>)(
        arg,
      );
    }
    expect(h.alerts).toEqual([]);
  });
});

describe("hibernation (issue #246)", () => {
  it("settles running tools and marks the tab hibernated, not crashed", async () => {
    // A fresh module: init latches per evaluation, and the earlier suites
    // already own the shared module's listener captures.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    fresh.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
    // A tool card mid-flight: the process is stopped with it still running.
    fresh.getState().handleRpcFrame(h.TAB, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    expect(fresh.getState().rpc[h.TAB]!.items).toHaveLength(1);

    const init = fresh.getState().init();
    const hibernateCb =
      h.mockBackend.onSessionHibernated.mock.calls[0]![0] as (tabId: string) => void;
    await init;

    hibernateCb(h.TAB);

    // The dead gates see a plain exit (code 0); the framing is hibernated.
    expect(fresh.getState().exited[h.TAB]).toBe(0);
    expect(fresh.getState().hibernated[h.TAB]).toBe(true);
    const [item] = fresh.getState().rpc[h.TAB]!.items;
    expect(item).toMatchObject({ kind: "tool", toolCallId: "t1", status: "aborted" });
    vi.useRealTimers();
  });
});

describe("viewed-tab reporter (issue #266)", () => {
  it("reports the active tab on init, on focus change, and on the heartbeat", async () => {
    // A fresh module — a static import cannot work: init latches per
    // evaluation, and the earlier suites already own the shared module's
    // listener captures.
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const { useStore: fresh } = await import("./store");
      const init = fresh.getState().init();
      await init;
      expect(h.mockBackend.tabViewed).toHaveBeenCalledTimes(1);
      expect(h.mockBackend.tabViewed).toHaveBeenLastCalledWith(expect.any(String), null);

      h.mockBackend.tabViewed.mockClear();
      fresh.getState().focusTab(h.TAB);
      expect(h.mockBackend.tabViewed).toHaveBeenCalledTimes(1);
      expect(h.mockBackend.tabViewed).toHaveBeenLastCalledWith(expect.any(String), h.TAB);

      h.mockBackend.tabViewed.mockClear();
      await vi.advanceTimersByTimeAsync(5 * 60_000); // heartbeat
      expect(h.mockBackend.tabViewed).toHaveBeenCalledTimes(1);
      expect(h.mockBackend.tabViewed).toHaveBeenLastCalledWith(expect.any(String), h.TAB);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("notification click focus (issue #271)", () => {
  // A fresh module evaluation per test: init() latches per evaluation, and the
  // earlier suites already own the shared module's listener capture.
  const projectState = (
    sessions: BackendState["projects"][0]["sessions"],
  ): BackendState =>
    makeBackendState({
      projects: [
        {
          project: {
            path: "/p",
            name: "p",
            addedAt: "t",
            lastModel: null,
            lastThinkingLevel: null,
            lastAdvisor: null,
            lastAdvisorModel: null,
            defaultModel: null,
            defaultAdvisorModel: null,
          },
          sessions,
        },
      ],
    });
  const rec = (tabId: string, live: LiveState = "live") => ({
    tabId,
    sessionId: `sid-${tabId}`,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui" as const,
    worktree: null,
    planImplementationSource: null,
    agentMode: "build" as const,
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    title: "New session",
    status: null,
    live,
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  });
  it("a notification click resurfaces and focuses a hidden tab", async () => {
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    h.backendState = projectState([rec(h.TAB)]);
    fresh.setState({
      state: h.backendState,
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p", hidden: true }),
      ],
      activeTabId: null,
    });

    const init = fresh.getState().init();
    await init;
    const cb = h.mockBackend.onFocusSession.mock.calls[0]![0] as (tabId: string) => void;

    void cb(h.TAB);
    await h.flushMicrotasks();

    const st = fresh.getState();
    expect(st.tabs.find((t) => t.tabId === h.TAB)?.hidden).toBe(false);
    expect(st.activeTabId).toBe(h.TAB);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
  });

  it("a notification click resumes a session the store has no tab for", async () => {
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    h.backendState = projectState([rec(h.TAB, "dormant")]);
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: h.TAB });
    fresh.setState({ state: h.backendState });

    const init = fresh.getState().init();
    await init;
    const cb = h.mockBackend.onFocusSession.mock.calls[0]![0] as (tabId: string) => void;

    void cb(h.TAB);
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "resume",
      resumeTabId: h.TAB,
      cols: 80,
      rows: 24,
    });
  });
});