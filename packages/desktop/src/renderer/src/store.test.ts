import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendState,
  BranchList,
  LiveState,
  OmpSettingsSnapshot,
  RemoteState,
  SessionSummary,
} from "@omp-ui/core/types";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
import type { LivePhase, LiveSnapshot } from "@omp-ui/core/live-voice";
import type { TabRuntime } from "./store/slices/shared";
import { emptySessionRuntime } from "./lib/rpc-types";
import { applyTheme, resolveTheme } from "./lib/themes";
import {
  backendState as makeBackendState,
  remoteInstance,
  rpcTabState,
  tabInfo,
} from "./test/fixtures";
import { h } from "./test/store-harness";

const platformMocks = vi.hoisted(() => ({ electron: false }));

// store.ts gates the first-run checklist auto-open on the Electron shell; the
// auto-open tests flip this per fresh-module evaluation (issue #623).
vi.mock("./lib/platform", () => ({
  get IS_ELECTRON() {
    return platformMocks.electron;
  },
  IS_MAC: false,
  IS_WINDOWS: false,
}));


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
        rpcTabState({
          status: "ready",
          experimentProposal: {
            proposal: {
              goal: "faster",
              metric: "t",
              unit: "",
              direction: "lower",
              command: null,
              scopePaths: [],
              offLimits: [],
              constraints: [],
              maxIterations: null,
              brief: null,
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

  // Issue #434: the owning instance's turn latch is level state and outranks
  // this renderer's edge-derived status — a row that joined the stream
  // mid-turn, or never mounted it, must not read as idle.
  it("lets the host's turn level outrank the renderer's stream edge", () => {
    const gate = {
      title: "p",
      planFilePath: "local://p.md",
      planAbsPath: null,
      frameId: "f",
      proposedAt: "2026-09-09T00:00:00.000Z",
    };
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), turnRunning: true },
        undefined,
        undefined,
      ),
    ).toBe("working");
    expect(
      h.deriveSidebarSessionState(summary(), undefined, undefined),
    ).toBe("live");
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), turnRunning: true },
        rpcTabState({ status: "ready" }),
        undefined,
      ),
    ).toBe("working");
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), mode: "pty", turnRunning: true },
        undefined,
        undefined,
      ),
    ).toBe("live");
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), pendingPlan: gate, turnRunning: true },
        rpcTabState({ status: "ready" }),
        undefined,
      ),
    ).toBe("awaiting-answer");
  });

  // Issue #436: the host's human-answer level is published level state, not a
  // stream edge — a remote row whose tab was never mounted still reads
  // awaiting-answer, and the level outranks `running` exactly as the local
  // answer queue does. error and stalled keep their precedence (#248).
  it("lets the host's human-answer level outrank the stream edge (#436)", () => {
    const awaiting = { ...summary(), awaitingHumanAnswer: true };
    expect(h.deriveSidebarSessionState(awaiting, undefined, undefined)).toBe(
      "awaiting-answer",
    );
    expect(
      h.deriveSidebarSessionState(awaiting, rpcTabState({ status: "ready" }), undefined),
    ).toBe("awaiting-answer");
    expect(
      h.deriveSidebarSessionState(
        awaiting,
        rpcTabState({ status: "running" }),
        undefined,
      ),
    ).toBe("awaiting-answer");
    expect(
      h.deriveSidebarSessionState(
        awaiting,
        rpcTabState({ status: "error" }),
        undefined,
      ),
    ).toBe("error");
    expect(
      h.deriveSidebarSessionState(
        { ...awaiting, streamStalled: true },
        rpcTabState({ status: "ready" }),
        undefined,
      ),
    ).toBe("stalled");
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), mode: "pty", awaitingHumanAnswer: true },
        undefined,
        undefined,
      ),
    ).toBe("live");
    // An old host publishes no level: unchanged #434 behaviour.
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), turnRunning: true },
        undefined,
        undefined,
      ),
    ).toBe("working");
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

describe("plan review relaunch lifetime", () => {
  it("preparing a resume retires loaded review bytes, readiness, and reactive voice state", async () => {
    h.useStore.setState({
      state: h.stateWithRecord("saved-session", "dormant"),
      tabs: [tabInfo({ tabId: h.TAB })],
      rpc: { [h.TAB]: rpcTabState() },
    });
    h.useStore.getState().acceptPlanReview(h.TAB, {
      request: { title: "old process plan", planFilePath: "local://old.html", planAbsPath: "/l/old.html" },
      frame: { id: "old-process-gate" },
    });
    await h.flushMicrotasks();
    const sourceKey = h.useStore.getState().rpc[h.TAB]!.planSourceKey!;
    h.useStore.getState().setPlanReadiness(h.TAB, { sourceKey, status: "ready" });
    const spawning = h.deferred<{ tabId: string }>();
    h.mockBackend.spawnSession.mockReturnValueOnce(spawning.promise);
    const resuming = h.useStore.getState().resumeDead(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]!).toMatchObject({
      status: "starting", planReview: null, planText: null, planHtml: null,
      planSourceKey: null, planReadiness: null, planDeferred: false,
      planVoice: { ready: false, busy: false, error: null },
    });
    h.useStore.getState().setPlanReadiness(h.TAB, { sourceKey, status: "ready" });
    expect(h.useStore.getState().rpc[h.TAB]!.planReadiness).toBeNull();
    expect(h.sent.some((s) => s.cmd.type === "live_start")).toBe(false);
    spawning.resolve({ tabId: h.TAB });
    await resuming;
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
        { key: "compaction.thresholdPercent", type: "number", description: "", value: -1, globalValue: undefined, options: null, layer: "default" },
        { key: "compaction.thresholdTokens", type: "number", description: "", value: -1, globalValue: undefined, options: null, layer: "default" },
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

  it("rejects writeOmpSetting to its caller instead of noticing it", async () => {
    h.mockBackend.writeOmpSetting.mockRejectedValueOnce(
      new Error("unknown setting"),
    );

    // The omp settings page renders this inline, so the rejection must survive
    // the store rather than being swallowed into an error notice.
    await expect(
      h.useStore.getState().writeOmpSetting("advisor.enabled", true),
    ).rejects.toThrow("unknown setting");
    expect(h.useStore.getState().errorNotices).toEqual([]);
  });

  it("repaints native window chrome with each applied theme, including a rollback", async () => {
    // Pin the starting theme: earlier cases may have left another applied.
    applyTheme(resolveTheme("graphite"));
    h.mockBackend.setWindowChrome.mockClear();
    h.mockBackend.setThemeId.mockRejectedValueOnce(new Error("registry locked"));

    await h.useStore.getState().setThemeId("light");

    // The optimistic switch and its rollback each reach main's titlebar
    // overlay (issue #657 moved this from lib/themes.ts into the store).
    const chrome = (id: string) => {
      const { tokens } = resolveTheme(id);
      return [tokens["--color-void"], tokens["--color-ink-mid"]];
    };
    expect(h.mockBackend.setWindowChrome.mock.calls).toEqual([chrome("light"), chrome("graphite")]);
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

  it("reports a real remote-settings failure as an error notice", async () => {
    h.mockBackend.setRemotePort.mockRejectedValueOnce(
      new Error("port must be a whole number between 1024 and 65535"),
    );
    await h.useStore.getState().setRemotePort(80);
    expect(h.errorMessages()).toEqual([
      "port must be a whole number between 1024 and 65535",
    ]);
  });

  it("swallows the self-inflicted disconnect a remote client causes", async () => {
    // A REMOTE client changing bind/port/token restarts the server it is asking over, so its own
    // call never gets a reply. That is the requested outcome — the reconnect banner handles it;
    // a blocking alert would both lie and stall that reload.
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
    expect(h.useStore.getState().errorNotices).toEqual([]);
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

describe("live voice park/resume (issue #811)", () => {
  // A fresh module evaluation per test: init latches per evaluation, and the
  // park/resume guard subscriber installs there, so each case observes its
  // own guard and its own `h.sent` log (same convention as the #801 suite
  // this replaces).
  const A = "tab-801-a";
  const B = "tab-801-b";

  // #816: dispatching live verbs requires the Electron-shell signal; the
  // whole suite opts in (per-test try/finally below stays harmless).
  beforeEach(() => {
    platformMocks.electron = true;
  });

  afterEach(() => {
    platformMocks.electron = false;
  });

  const version = (ompVersion: string): CapabilitySnapshot =>
    ({ ompVersion }) as unknown as CapabilitySnapshot;
  const liveSnap = (phase: LivePhase | null, ended = false): LiveSnapshot => ({
    phase,
    levels: null,
    turns: [],
    ended,
    error: null,
    connectionId: null,
  });

  /** Fresh store with the guard installed (init ran), plus the runtime seam. */
  const freshGuardedStore = async (): Promise<{
    fresh: typeof h.useStore;
    peek: (tabId: string) => TabRuntime | undefined;
  }> => {
    // Dynamic import is the module-boundary test itself: init latches per
    // evaluation, so each case needs its own store and its own shared-module
    // instance (a static import would peek the previous evaluation's map).
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    const { peekTabRuntime } = await import("./store/slices/shared");
    await fresh.getState().init();
    h.sent.length = 0;
    return { fresh, peek: peekTabRuntime };
  };

  /** Ack every command recorded so far, without leaving one pending.
   *  Acks instead of splicing so commands fired by an ack (the resume's
   *  re-mute) stay assertable afterwards; re-acking a settled id is a
   *  no-op — the pending lookup misses. */
  const settleSends = async (fresh: typeof h.useStore): Promise<void> => {
    for (let wave = 0; wave < 3; wave++) {
      await h.flushMicrotasks();
      for (const { tabId, cmd } of h.sent) {
        fresh.getState().handleRpcFrame(tabId, {
          type: "response",
          id: cmd.id,
          command: cmd.type,
          success: true,
          data: {},
        });
      }
    }
    await h.flushMicrotasks();
  };

  const sentOf = (type: string) => h.sent.filter((s) => s.cmd.type === type);

  /** Arm a tab through the real start path (owner + armed ride the ack). */
  const arm = async (fresh: typeof h.useStore, tabId: string): Promise<void> => {
    const starting = fresh.getState().startLiveVoice(tabId);
    await h.flushMicrotasks();
    // The start must be on the wire before its ack; a silently no-op'ed
    // start would otherwise hang here instead of failing at the gate.
    const start = h.sent.find((s) => s.tabId === tabId && s.cmd.type === "live_start");
    if (start === undefined) throw new Error(`startLiveVoice dispatched nothing for ${tabId}`);
    fresh.getState().handleRpcFrame(tabId, {
      type: "response",
      id: start.cmd.id,
      command: "live_start",
      success: true,
      data: {},
    });
    await starting;
    // The ack lands `live: null` on the rpc entry; a live_phase frame
    // reopens the snapshot so the guard's isLiveSessionActive sees a call
    // (the truth omp delivers the same way in the app).
    fresh.getState().handleRpcFrame(tabId, { type: "live_phase", phase: "listening" });
    h.sent.length = 0;
  };

  const seedRpc = (
    fresh: typeof h.useStore,
    aLive: LiveSnapshot | null,
    bLive: LiveSnapshot | null = null,
  ): void => {
    fresh.setState({
      tabs: [tabInfo({ tabId: A }), tabInfo({ tabId: B })],
      rpc: {
        [A]: rpcTabState({ capabilities: version("18.7.0"), live: aLive }),
        [B]: rpcTabState({ capabilities: version("18.7.0"), live: bLive }),
      },
      activeTabId: A,
    });
  };

  it("deferring and reopening a reviewed source preserve the healthy call and overview accounting", async () => {
    const { fresh, peek } = await freshGuardedStore();
    seedRpc(fresh, null);
    await arm(fresh, A);
    const gate = {
      request: { title: "held plan", planFilePath: "local://held.html", planAbsPath: "/l/held.html" },
      frame: { id: "held" },
    };
    const gateKey = JSON.stringify(["held", "/l/held.html", null]);
    const sourceKey = JSON.stringify([gateKey, 1]);
    const runtime = peek(A)!;
    runtime.liveReviewAppliedSourceKey = sourceKey;
    runtime.liveReviewAutoRequestedGateKey = gateKey;
    runtime.liveReviewExplicitBriefingKey = gateKey;
    runtime.liveReviewTextCache = { sourceKey, text: "Held plan purpose" };
    runtime.livePendingFeedback.push("An undelivered final answer");
    fresh.setState({ rpc: {
      ...fresh.getState().rpc,
      [A]: {
        ...fresh.getState().rpc[A]!,
        planReview: gate,
        planText: "<p>Held plan purpose</p>",
        planHtml: "<p>Held plan purpose</p>",
        planSourceKey: sourceKey,
        planReadiness: { sourceKey, status: "ready" },
        planVoice: { ready: true, busy: false, error: null },
      },
    } });
    fresh.getState().deferPlanReview(A);
    await h.flushMicrotasks();
    expect(fresh.getState().rpc[A]!.planDeferred).toBe(true);
    expect(fresh.getState().rpc[A]!.live?.phase).toBe("listening");
    expect(runtime.liveArmed).toBe(true);
    expect(runtime.liveReviewAppliedSourceKey).toBe(sourceKey);
    expect(runtime.liveReviewAutoRequestedGateKey).toBe(gateKey);
    expect(runtime.liveReviewExplicitBriefingKey).toBe(gateKey);
    expect(runtime.livePendingFeedback).toEqual(["An undelivered final answer"]);
    fresh.getState().showPlanReview(A);
    await h.flushMicrotasks();
    expect(fresh.getState().rpc[A]!.planDeferred).toBe(false);
    expect(fresh.getState().rpc[A]!.planSourceKey).toBe(sourceKey);
    expect(sentOf("live_stop")).toEqual([]);
    expect(sentOf("live_start")).toEqual([]);
    expect(runtime.liveReviewAutoRequestedGateKey).toBe(gateKey);
    const stopping = fresh.getState().stopLiveVoice(A);
    await settleSends(fresh);
    await stopping;
    expect(runtime.liveReviewAutoRequestedGateKey).toBeUndefined();
    expect(runtime.liveReviewAppliedSourceKey).toBeNull();
    expect(runtime.liveReviewTextCache).toBeUndefined();
  });

  it("leaving an armed session closes the call, keeps the intent (AC 1)", async () => {
    // #816: `startLiveVoice` gates on the live-audio hardware check, so every
    // arm/resume below needs the desktop shell; the mock pattern is #623's.
    platformMocks.electron = true;
    try {
      const { fresh, peek } = await freshGuardedStore();
      // Seeded with no live snapshot: arm's real start opens the call, and
      // the guard's isLiveSessionActive sees it through the phase frame.
      seedRpc(fresh, null);
      await arm(fresh, A);

      fresh.getState().focusTab(B);

      expect(sentOf("live_stop")).toEqual([
        { tabId: A, cmd: expect.objectContaining({ type: "live_stop" }) },
      ]);
      // The mute dispatch died with #801: parking closes the call.
      expect(sentOf("live_mute")).toEqual([]);
      expect(peek(A)?.liveParked).toBe(true);
      expect(peek(A)?.liveArmed).toBe(true);
      expect(fresh.getState().liveVoice[A]).toEqual({ armed: true, parked: true, pending: false });
      await settleSends(fresh);
      // The parked snapshot reads ended, so the control shows idle.
      expect(fresh.getState().rpc[A]?.live?.ended).toBe(true);
    } finally {
      platformMocks.electron = false;
    }
  });

  it("returning resumes with the recap inside instructions (AC 2)", async () => {
    platformMocks.electron = true;
    try {
      const { fresh, peek } = await freshGuardedStore();
      seedRpc(fresh, null);
      await arm(fresh, A);
      fresh.getState().handleRpcFrame(A, {
        type: "live_transcript",
        role: "user",
        turn: 0,
        text: "deploy the preview",
        final: true,
      });
      fresh.getState().handleRpcFrame(A, {
        type: "live_transcript",
        role: "assistant",
        turn: 1,
        text: "Deployed the preview build",
        final: true,
      });

      fresh.getState().focusTab(B);
      await settleSends(fresh);
      h.sent.length = 0;
      fresh.getState().focusTab(A);

      const starts = sentOf("live_start");
      expect(starts).toHaveLength(1);
      // `cmd` is the harness's untyped record; stringContaining narrows at
      // the assertion instead of a cast at the read.
      expect(starts[0]!.cmd.instructions).toEqual(expect.stringContaining("<voice-recap>"));
      expect(starts[0]!.cmd.instructions).toEqual(
        expect.stringContaining("User: deploy the preview"),
      );
      expect(starts[0]!.cmd.instructions).toEqual(
        expect.stringContaining("Assistant: Deployed the preview build"),
      );
      await settleSends(fresh);
      expect(peek(A)?.liveParked).toBe(false);
      expect(fresh.getState().rpc[A]?.live?.phase).toBe("connecting");
    } finally {
      platformMocks.electron = false;
    }
  });

  it("switching between two armed sessions leaves exactly one call open (AC 6)", async () => {
    platformMocks.electron = true;
    try {
      const { fresh } = await freshGuardedStore();
      seedRpc(fresh, null, null);
      await arm(fresh, A);
      fresh.getState().focusTab(B);
      await settleSends(fresh);
      h.sent.length = 0;
      await arm(fresh, B);
      fresh.getState().focusTab(A);
      await settleSends(fresh);
      expect(fresh.getState().rpc[A]?.live?.ended).toBe(false);
      expect(fresh.getState().rpc[B]?.live?.ended).toBe(true);
      h.sent.length = 0;

      fresh.getState().focusTab(B);

      // Both were armed while viewed: A parks as the parked B resumes.
      expect(sentOf("live_stop")).toEqual([
        { tabId: A, cmd: expect.objectContaining({ type: "live_stop" }) },
      ]);
      expect(sentOf("live_start")).toEqual([
        { tabId: B, cmd: expect.objectContaining({ type: "live_start" }) },
      ]);
      expect(fresh.getState().rpc[A]?.live?.ended).toBe(false); // stop not acked yet
      await settleSends(fresh);
      expect(fresh.getState().rpc[A]?.live?.ended).toBe(true);
      expect(fresh.getState().rpc[B]?.live?.ended).toBe(false);
    } finally {
      platformMocks.electron = false;
    }
  });

  it("a user-muted park re-mutes the resumed call (AC 7a)", async () => {
    platformMocks.electron = true;
    try {
      const { fresh } = await freshGuardedStore();
      seedRpc(fresh, null);
      await arm(fresh, A);
      // The user muted while listening: omp's truth lands before the leave.
      fresh.getState().handleRpcFrame(A, { type: "live_phase", phase: "muted" });

      fresh.getState().focusTab(B);
      await settleSends(fresh);
      h.sent.length = 0;
      fresh.getState().focusTab(A);

      expect(sentOf("live_start")).toHaveLength(1);
      await settleSends(fresh);
      expect(sentOf("live_mute")).toEqual([
        { tabId: A, cmd: expect.objectContaining({ type: "live_mute", muted: true }) },
      ]);
      await settleSends(fresh);
    } finally {
      platformMocks.electron = false;
    }
  });

  it("an explicit stop disarms and never resumes (AC 7b)", async () => {
    platformMocks.electron = true;
    try {
      const { fresh, peek } = await freshGuardedStore();
      seedRpc(fresh, null);
      await arm(fresh, A);
      fresh.getState().focusTab(B);
      await settleSends(fresh);

      // Stop from the parked capsule: no dispatch (the call is closed), the
      // clear is the job (AC 8 covers the hand-off with the same path).
      h.sent.length = 0;
      await fresh.getState().stopLiveVoice(A);
      expect(sentOf("live_stop")).toEqual([]);
      expect(peek(A)?.liveArmed).toBe(false);
      expect(peek(A)?.liveParked).toBe(false);
      expect(fresh.getState().liveVoice[A]).toBeUndefined();

      fresh.getState().focusTab(A);
      expect(sentOf("live_start")).toEqual([]);
    } finally {
      platformMocks.electron = false;
    }
  });

  it("a non-owner renderer never dispatches on a switch (AC 9)", async () => {
    const { fresh } = await freshGuardedStore();
    // A live snapshot with no local start: no runtime owner exists.
    seedRpc(fresh, liveSnap("listening"));

    fresh.getState().focusTab(B);

    expect(sentOf("live_stop")).toEqual([]);
    expect(sentOf("live_mute")).toEqual([]);
  });

  it("an ended session behind us is left alone", async () => {
    const { fresh } = await freshGuardedStore();
    seedRpc(fresh, liveSnap("listening", true));

    fresh.getState().focusTab(B);

    expect(sentOf("live_stop")).toEqual([]);
  });

  it("an omp below the live floor dispatches nothing", async () => {
    // The shell passes so the version floor — not the #816 hardware gate —
    // is what silences the arm.
    platformMocks.electron = true;
    try {
      const { fresh } = await freshGuardedStore();
      fresh.setState({
        tabs: [tabInfo({ tabId: A }), tabInfo({ tabId: B })],
        rpc: {
          [A]: rpcTabState({ capabilities: version("18.5.0"), live: liveSnap("listening") }),
          [B]: rpcTabState({ capabilities: version("18.5.0") }),
        },
        activeTabId: A,
      });

      // Even the arm no-ops below the floor, so nothing is armed to park.
      await fresh.getState().startLiveVoice(A);
      fresh.getState().focusTab(B);

      expect(h.sent).toEqual([]);
    } finally {
      platformMocks.electron = false;
    }
  });

  it("a PTY tab is untouched and gains no runtime from a tab switch", async () => {
    const { fresh, peek } = await freshGuardedStore();
    fresh.setState({
      tabs: [tabInfo({ tabId: A, mode: "pty" }), tabInfo({ tabId: B, mode: "rpc-ui" })],
      rpc: { [B]: rpcTabState({ capabilities: version("18.7.0") }) },
      activeTabId: A,
    });

    fresh.getState().focusTab(B);

    expect(h.sent).toEqual([]);
    expect(peek(A)).toBeUndefined();
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
            browserClock: false,
            reviewRoster: null,
            knowledgeHome: null,
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
    planImplementationSource: null, experiment: null,
    agentMode: "build" as const,
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
 proposedPlans: [],
 autoTitled: false,
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

describe("mounted tab reconciliation (issues #416 and #510)", () => {
  const INSTANCE = "inst-a";
  const RPC = "remote-rpc";
  const PTY = "remote-pty";
  const LOCAL_RPC = "local-rpc";
  const LOCAL_PTY = "local-pty";
  const SURVIVOR = "local-survivor";
  const record = (
    tabId: string,
    mode: "rpc-ui" | "pty",
    projectCwd = "/p",
  ): SessionSummary => ({
    tabId,
    sessionId: `sid-${tabId}`,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd,
    launchedAt: "t",
    mode,
    worktree: null,
    planImplementationSource: null, experiment: null,
    agentMode: "build",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
 proposedPlans: [],
 autoTitled: false,
    cachedTitle: null,
    cachedModified: null,
    title: "New session",
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  });
  const withInstance = (
    status: "joined" | "unreachable",
    sessions: SessionSummary[],
  ): BackendState =>
    makeBackendState({
      remoteInstances: [
        remoteInstance({
          id: INSTANCE,
          status,
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
                browserClock: false,
                reviewRoster: null,
                knowledgeHome: null,
              },
              sessions,
            },
          ],
        }),
      ],
    });
  const localState = (sessions: SessionSummary[]): BackendState =>
    makeBackendState({
      projects: ["/gone", "/keep"].map((path) => ({
        project: {
          path,
          name: path.slice(1),
          addedAt: "t",
          lastModel: null,
          lastThinkingLevel: null,
          lastAdvisor: null,
          lastAdvisorModel: null,
          defaultModel: null,
          defaultAdvisorModel: null,
          browserClock: false,
          reviewRoster: null,
          knowledgeHome: null,
        },
        sessions: sessions.filter((session) => session.projectCwd === path),
      })),
    });


  // A fresh module per test: init() latches per evaluation, and the earlier
  // suites already own the shared module's onStateChanged capture.
  async function seeded(initial: BackendState) {
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    h.backendState = initial;
    fresh.setState({
      state: initial,
      tabs: [
        tabInfo({ tabId: RPC, mode: "rpc-ui", projectCwd: "/p", instanceId: INSTANCE }),
        tabInfo({ tabId: PTY, mode: "pty", projectCwd: "/p", instanceId: INSTANCE }),
      ],
      rpc: { [RPC]: rpcTabState({ status: "ready" }) },
      activeTabId: RPC,
      focusedTabByProject: { [`${INSTANCE}::/p`]: RPC },
    });
    const bootRpcTab = vi.fn(async () => {});
    fresh.setState({ bootRpcTab });
    await fresh.getState().init();
    const onState = h.mockBackend.onStateChanged.mock.calls[0]![0] as (s: BackendState) => void;
    return { fresh, onState, bootRpcTab };
  }
  it("derives persisted handoff suppression and preserves a human release", async () => {
    const source = record("plan-source", "rpc-ui", "/keep");
    const implementation = {
      ...record("plan-implementation", "rpc-ui", "/keep"),
      planImplementationSource: {
        sourceTabId: source.tabId,
        planTitle: "Ship it",
        planFilePath: "local://plan.md",
      },
    };
    const snapshot = localState([source, implementation]);
    const { fresh, onState } = await seeded(snapshot);

    onState(snapshot);
    expect(fresh.getState().handedOffFor).toEqual({
      [source.tabId]: implementation.tabId,
    });

    fresh.setState({ handedOffFor: {} });
    onState(snapshot);
    expect(fresh.getState().handedOffFor).toEqual({});

    const replacement = {
      ...implementation,
      tabId: "plan-implementation-2",
    };
    onState(localState([source, replacement]));
    expect(fresh.getState().handedOffFor).toEqual({
      [source.tabId]: replacement.tabId,
    });
  });

  it("keeps the newest launch across reordered activity broadcasts and a human release", async () => {
    const source = record("plan-source", "rpc-ui", "/keep");
    const provenance = {
      sourceTabId: source.tabId,
      planTitle: "Ship it",
      planFilePath: "local://plan.md",
    };
    const older = {
      ...record("implementation-old", "rpc-ui", "/keep"),
      launchedAt: "2026-10-09T10:00:00.000Z",
      cachedModified: "2026-10-09T12:00:00.000Z",
      planImplementationSource: provenance,
    };
    const newer = {
      ...older,
      tabId: "implementation-new",
      launchedAt: "2026-10-09T11:00:00.000Z",
      cachedModified: "2026-10-09T11:00:00.000Z",
    };
    const { fresh, onState } = await seeded(localState([source, older]));
    onState(localState([newer, source, older]));
    expect(fresh.getState().handedOffFor).toEqual({ [source.tabId]: newer.tabId });

    fresh.setState({
      tabs: [tabInfo({ tabId: newer.tabId, projectCwd: "/keep" })],
      activeTabId: newer.tabId,
      focusedTabByProject: { "/keep": newer.tabId },
    });
    const startLiveVoice = vi.spyOn(fresh.getState(), "startLiveVoice");
    onState(localState([older, newer, source]));
    expect(fresh.getState().observedPlanHandoffs).toEqual({ [source.tabId]: newer.tabId });
    expect(fresh.getState().handedOffFor).toEqual({ [source.tabId]: newer.tabId });
    expect(fresh.getState().activeTabId).toBe(newer.tabId);
    expect(fresh.getState().focusedTabByProject["/keep"]).toBe(newer.tabId);
    expect(startLiveVoice).not.toHaveBeenCalled();

    fresh.setState({ handedOffFor: {} });
    onState(localState([newer, older, source]));
    onState(localState([source, older, newer]));
    expect(fresh.getState().handedOffFor).toEqual({});
    expect(fresh.getState().observedPlanHandoffs).toEqual({ [source.tabId]: newer.tabId });

    const newest = { ...newer, tabId: "implementation-newest", launchedAt: "2026-10-09T13:00:00.000Z" };
    onState(localState([newest, newer, older, source]));
    expect(fresh.getState().handedOffFor).toEqual({ [source.tabId]: newest.tabId });
    startLiveVoice.mockRestore();
  });

  it("resolves launch ties deterministically across local and remote project order", async () => {
    const source = record("plan-source", "rpc-ui", "/keep");
    const implementation = {
      ...record("implementation-a", "rpc-ui", "/keep"),
      launchedAt: "2026-10-09T11:00:00.000Z",
      planImplementationSource: { sourceTabId: source.tabId, planTitle: "Ship it", planFilePath: "local://plan.md" },
    };
    const tied = { ...implementation, tabId: "implementation-z", projectCwd: "/p" };
    const snapshot = {
      ...localState([source, implementation]),
      remoteInstances: withInstance("joined", [tied]).remoteInstances,
    };
    const { fresh, onState } = await seeded(snapshot);
    expect(fresh.getState().observedPlanHandoffs).toEqual({ [source.tabId]: tied.tabId });
    onState({
      ...localState([source, { ...tied, projectCwd: "/keep" }]),
      remoteInstances: withInstance("joined", [{ ...implementation, projectCwd: "/p" }]).remoteInstances,
    });
    expect(fresh.getState().observedPlanHandoffs).toEqual({ [source.tabId]: tied.tabId });
    expect(fresh.getState().handedOffFor).toEqual({ [source.tabId]: tied.tabId });
  });

  it("drops locally owned tabs omitted from the authoritative project snapshot", async () => {
    const localRpc = record(LOCAL_RPC, "rpc-ui", "/gone");
    const localPty = record(LOCAL_PTY, "pty", "/gone");
    const survivor = record(SURVIVOR, "rpc-ui", "/keep");
    const { fresh, onState, bootRpcTab } = await seeded(
      localState([localRpc, localPty, survivor]),
    );
    fresh.setState({
      tabs: [
        tabInfo({ tabId: LOCAL_RPC, mode: "rpc-ui", projectCwd: "/gone" }),
        tabInfo({ tabId: LOCAL_PTY, mode: "pty", projectCwd: "/gone" }),
        tabInfo({ tabId: SURVIVOR, mode: "rpc-ui", projectCwd: "/keep" }),
      ],
      rpc: {
        [LOCAL_RPC]: rpcTabState({ status: "ready" }),
        [SURVIVOR]: rpcTabState({ status: "ready" }),
      },
      exited: { [LOCAL_RPC]: 1, [LOCAL_PTY]: 2 },
      hibernated: { [LOCAL_RPC]: true, [LOCAL_PTY]: true },
      tuiHandoff: {
        [LOCAL_RPC]: { line: "/mcp reauth one", key: 1, phase: "running" },
        [LOCAL_PTY]: { line: "/mcp reauth two", key: 2, phase: "running" },
      },
      activeTabId: SURVIVOR,
      focusedTabByProject: { "/gone": LOCAL_RPC, "/keep": SURVIVOR },
    });

    onState(localState([survivor]));

    let state = fresh.getState();
    expect(state.tabs.map((tab) => tab.tabId)).toEqual([SURVIVOR]);
    expect(state.activeTabId).toBe(SURVIVOR);
    expect(state.rpc[LOCAL_RPC]).toBeUndefined();
    expect(state.exited[LOCAL_RPC]).toBeUndefined();
    expect(state.exited[LOCAL_PTY]).toBeUndefined();
    expect(state.hibernated[LOCAL_RPC]).toBeUndefined();
    expect(state.hibernated[LOCAL_PTY]).toBeUndefined();
    expect(state.tuiHandoff[LOCAL_RPC]).toBeUndefined();
    expect(state.tuiHandoff[LOCAL_PTY]).toBeUndefined();
    expect(state.focusedTabByProject).toEqual({ "/keep": SURVIVOR });
    expect(bootRpcTab).not.toHaveBeenCalled();
    expect(state.ptyRedrawRevision[LOCAL_PTY]).toBeUndefined();

    onState(localState([]));

    state = fresh.getState();
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.focusedTabByProject).toEqual({});
    expect(bootRpcTab).not.toHaveBeenCalled();
  });


  it("a rejoin re-boots rpc tabs, redraws pty tabs, and drops a tab the instance no longer lists", async () => {
    const both = [record(RPC, "rpc-ui"), record(PTY, "pty")];
    const { fresh, onState, bootRpcTab } = await seeded(withInstance("unreachable", both));
    // While unreachable nothing moves: the tabs stay mounted as they were.
    onState(withInstance("unreachable", both));
    expect(bootRpcTab).not.toHaveBeenCalled();
    expect(fresh.getState().ptyRedrawRevision[PTY]).toBeUndefined();

    // Rejoined, and the remote deleted the pty session while it was away.
    onState(withInstance("joined", [record(RPC, "rpc-ui")]));
    expect(bootRpcTab).toHaveBeenCalledWith(RPC);
    expect(fresh.getState().tabs.map((t) => t.tabId)).toEqual([RPC]);
    expect(fresh.getState().ptyRedrawRevision[PTY]).toBeUndefined();

    // A second rejoin with both sessions present bumps the pty tab.
    fresh.setState({
      tabs: [
        ...fresh.getState().tabs,
        tabInfo({ tabId: PTY, mode: "pty", projectCwd: "/p", instanceId: INSTANCE }),
      ],
    });
    onState(withInstance("unreachable", both));
    onState(withInstance("joined", both));
    expect(fresh.getState().ptyRedrawRevision[PTY]).toBe(1);
    expect(bootRpcTab).toHaveBeenCalledTimes(2);
    // Steady state: another joined broadcast is not a rejoin.
    onState(withInstance("joined", both));
    expect(fresh.getState().ptyRedrawRevision[PTY]).toBe(1);
    expect(bootRpcTab).toHaveBeenCalledTimes(2);
  });

  it("removing the instance drops every tab it owned, including focus and rpc state", async () => {
    const both = [record(RPC, "rpc-ui"), record(PTY, "pty")];
    const { fresh, onState } = await seeded(withInstance("joined", both));
    onState(makeBackendState());
    const st = fresh.getState();
    expect(st.tabs).toEqual([]);
    expect(st.activeTabId).toBeNull();
    expect(st.rpc[RPC]).toBeUndefined();
    expect(st.focusedTabByProject).toEqual({});
  });
});
// #498: the store listens for branch:changed and re-reads local refs for the
// project whose checkout moved — never the network, and never a project it
// holds no snapshot of (that chip fetches on mount).
describe("branch:changed subscription (issue #498)", () => {
  const list = (current: string): BranchList => ({
    repoRoot: "/p",
    current,
    branches: [current],
    defaultBranch: "main",
    upstreamRef: null,
    upstreamRemote: null,
    hasUpstream: false,
    ahead: 0,
    behind: 0,
    mergeInProgress: false,
    upstreamFetchedAt: null,
    upstreamRefreshError: null,
    defaultRemote: null,
  });

  // A fresh module per test: init() latches per evaluation.
  async function subscribed(branches: Record<string, BranchList>) {
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    fresh.setState({ branches });
    await fresh.getState().init();
    const onBranch = h.mockBackend.onBranchChanged.mock.calls[0]![0] as (
      projectCwd: string,
      instanceId: string | null,
    ) => void;
    return { fresh, onBranch };
  }

  it("a host event refreshes the local snapshot with local refs only", async () => {
    const { fresh, onBranch } = await subscribed({ "/p": list("main") });
    h.mockBackend.listBranches.mockResolvedValue(list("feature"));

    onBranch("/p", null);

    await vi.waitFor(() => expect(fresh.getState().branches["/p"]?.current).toBe("feature"));
    expect(h.mockBackend.listBranches).toHaveBeenCalledWith("/p", { fetchUpstream: false });
  });

  it("a re-stamped joined-instance event routes through the proxy", async () => {
    const INSTANCE = "inst-a";
    const { fresh, onBranch } = await subscribed({ [`${INSTANCE}::/p`]: list("main") });
    h.mockBackend.remoteInstanceRequest.mockResolvedValue(list("feature"));

    onBranch("/p", INSTANCE);

    await vi.waitFor(() =>
      expect(fresh.getState().branches[`${INSTANCE}::/p`]?.current).toBe("feature"),
    );
    expect(h.mockBackend.remoteInstanceRequest).toHaveBeenCalledWith(INSTANCE, "branch:list", [
      "/p",
      { fetchUpstream: false },
    ]);
  });

  it("a project with no snapshot triggers no git call", async () => {
    const { onBranch } = await subscribed({});

    onBranch("/p", null);
    onBranch("/p", "inst-a");

    await new Promise((resolve) => setImmediate(resolve));
    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
    expect(h.mockBackend.remoteInstanceRequest).not.toHaveBeenCalled();
  });
});

describe("project picker registration target (issue #624)", () => {
  it("coerces a non-string first argument to the local registry", () => {
    // The defect's exact shape: React hands click handlers the event, and
    // an event-like object must never become an instance id.
    h.useStore.getState().openProjectPicker({} as unknown as string);
    expect(h.useStore.getState().projectPickerOpen).toBe(true);
    expect(h.useStore.getState().projectPickerInstanceId).toBeNull();
    h.useStore.getState().closeProjectPicker();
    // A real instance id still registers remotely.
    h.useStore.getState().openProjectPicker("inst-a");
    expect(h.useStore.getState().projectPickerInstanceId).toBe("inst-a");
    h.useStore.getState().closeProjectPicker();
  });
});

describe("getting-started checklist (issue #623)", () => {
  it("open flips visibility without any backend write", () => {
    h.useStore.getState().openGettingStarted();
    expect(h.useStore.getState().gettingStartedOpen).toBe(true);
    expect(h.mockBackend.setGettingStartedSeen).not.toHaveBeenCalled();
  });

  it("dismiss closes and marks the authoritative flag seen exactly once", () => {
    h.useStore.setState({
      state: makeBackendState({ gettingStartedSeen: false }),
      gettingStartedOpen: true,
    });
    h.useStore.getState().dismissGettingStarted();
    expect(h.useStore.getState().gettingStartedOpen).toBe(false);
    expect(h.mockBackend.setGettingStartedSeen).toHaveBeenCalledTimes(1);
    expect(h.mockBackend.setGettingStartedSeen).toHaveBeenCalledWith(true);
  });

  it("dismiss on an install already marked seen writes nothing", () => {
    h.useStore.setState({
      state: makeBackendState({ gettingStartedSeen: true }),
      gettingStartedOpen: true,
    });
    h.useStore.getState().dismissGettingStarted();
    expect(h.useStore.getState().gettingStartedOpen).toBe(false);
    expect(h.mockBackend.setGettingStartedSeen).not.toHaveBeenCalled();
  });

  // Fresh modules: init() latches per evaluation, and the auto-open reads the
  // fetched state through the Electron-shell gate the platform mock exposes.
  it("init auto-opens when the desktop shell's fetched state is unseen", async () => {
    vi.resetModules();
    platformMocks.electron = true;
    try {
      h.backendState = makeBackendState({ gettingStartedSeen: false });
      const { useStore: fresh } = await import("./store");
      await fresh.getState().init();
      expect(fresh.getState().gettingStartedOpen).toBe(true);
    } finally {
      platformMocks.electron = false;
    }
  });

  it("init stays closed when the fetched state is already seen", async () => {
    vi.resetModules();
    platformMocks.electron = true;
    try {
      h.backendState = makeBackendState({ gettingStartedSeen: true });
      const { useStore: fresh } = await import("./store");
      await fresh.getState().init();
      expect(fresh.getState().gettingStartedOpen).toBe(false);
    } finally {
      platformMocks.electron = false;
    }
  });

  it("a remote renderer never auto-opens", async () => {
    vi.resetModules();
    platformMocks.electron = false;
    h.backendState = makeBackendState({ gettingStartedSeen: false });
    const { useStore: fresh } = await import("./store");
    await fresh.getState().init();
    expect(fresh.getState().gettingStartedOpen).toBe(false);
  });
});

// #816: live audio is the session host's hardware, so a web client's
// startLiveVoice no-ops at the store-level gate while stopLiveVoice — pure
// mic release — stays version-gated. The hand-off is the case that proves
// both halves: the planner's call closes, the fresh tab never arms a mic.
describe("live voice handoff on a web client (issue #816)", () => {
  const version = (ompVersion: string): CapabilitySnapshot =>
    ({ ompVersion }) as unknown as CapabilitySnapshot;
  const liveSnap = (phase: LivePhase | null, ended = false): LiveSnapshot => ({
    phase,
    levels: null,
    turns: [],
    ended,
    error: null,
    connectionId: null,
  });

  it("releases the source's mic and never starts a call on the fresh tab", async () => {
    // The web client: the platform mock's default, stated explicitly so the
    // gate — not test order — owns the outcome.
    platformMocks.electron = false;
    h.useStore.setState((state) => ({
      state: state.state ?? h.stateWithRecord(null),
      rpc: {
        ...state.rpc,
        [h.TAB]: rpcTabState({
          capabilities: version("18.7.0"),
          live: liveSnap("listening"),
        }),
      },
    }));
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "carry-web-client",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    h.useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        "fresh-tab": rpcTabState({
          status: "ready",
          planText: null,
          capabilities: version("18.7.0"),
        }),
      },
    }));
    await h.flushMicrotasks();
    const seed = h.sent.find(
      (entry) => entry.tabId === "fresh-tab" && entry.cmd.type === "prompt",
    );
    expect(seed).toBeDefined();
    h.respond("fresh-tab", seed!.cmd, {});
    // Ack every follow-on command in waves, as the #808 carry-over tests do.
    for (let wave = 0; wave < 3; wave++) {
      await h.flushMicrotasks();
      for (const { tabId, cmd } of h.sent) h.respond(tabId, cmd, {});
      await h.flushMicrotasks();
    }

    // The mic release lands on the source (stopLiveVoice is version-gated
    // only); the hardware gate silences the destination's start entirely.
    expect(
      h.sent
        .filter((s) => s.cmd.type === "live_stop" || s.cmd.type === "live_start")
        .map((s) => ({ tabId: s.tabId, type: s.cmd.type })),
    ).toEqual([{ tabId: h.TAB, type: "live_stop" }]);
    expect(
      h.sent.some((s) => s.tabId === "fresh-tab" && s.cmd.type === "live_start"),
    ).toBe(false);
    // The hand-off itself is undisturbed by the gate.
    expect(h.mockBackend.hibernatePlanSource).toHaveBeenCalledWith(h.TAB, "fresh-tab");
  });
});
