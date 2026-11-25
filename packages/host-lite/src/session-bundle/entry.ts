/**
 * The headless session cluster (issue #1010): the REAL desktop
 * `SessionManager` — the same sources the desktop ships, unedited — composed
 * for a windowless lite fleet member. Bundled by `scripts/bundle-session.mjs`,
 * which swaps the closure's runtime-Electron leaf (`browser-pane-contents.ts`)
 * for a shim and fails loudly on any other Electron reach (the drift gate).
 *
 * The shape is `RemoteHost`-ready (`packages/server`): the owning slice wires
 * `handlers()` + `on` into `startRemoteServer`. Channels that are physically
 * impossible without a window — browser/device panes, OS dialogs, updates,
 * auth-pick, fleet terminals — are ABSENT from the tables, never denied
 * (#449): `dispatchRequest` rejects an absent request channel and
 * `dispatchNotify` ignores an absent notify channel.
 */
import * as os from "node:os";
import * as path from "node:path";
import {
  CH,
  FLEET_LABEL_MAX,
  RoutineRunHistory,
  RoutineStore,
  formatModelRole,
  hydrateSessionFile,
  isInChatsRoot,
  parseRoutineSpendDefaults,
  providerKeyEnv,
  readModelCatalog,
  readModelsFileModelProviders,
  reclaimCheckouts,
  resolveProjectPath,
  resolveSessionLocation,
  routineInputFromAgentCreate,
  withoutProviderKeys,
  type ApprovalMode,
  type BackendState,
  type CapabilitySnapshot,
  type ChannelTable,
  type CollabAccess,
  type ConsoleProgram,
  type DocumentAttachment,
  type HeldPromptRequest,
  type ImageAttachment,
  type LiveState,
  type ModelCatalogSnapshot,
  type OwnedSessionRecord,
  type PlanReviewVerdict,
  type ProjectGroup,
  type RoutineDryRunRequest,
  type RoutineInput,
  type RoutinePatch,
  type RoutineTestScriptRequest,
  type RpcFrame,
  type ScheduledPromptRequest,
  type ServiceTier,
  type SessionMode,
  type SessionSummary,
  type SpawnGateState,
  type SpawnRequest,
  type SubagentModelMap,
  type WorktreeReleaseOptions,
} from "@omp-ui/core";
import { readConfinedPlanFile } from "../../../desktop/src/main/plan-file";
import { RoutineCatalogService } from "../../../desktop/src/main/routine-catalog";
import { RoutineLifecycleManager } from "../../../desktop/src/main/routine-lifecycle";
import { ROUTINES_DISABLED_ERROR } from "../../../desktop/src/main/routine-scheduler";
import { runRoutineScript } from "../../../desktop/src/main/routine-scripts";
import { RoutineService } from "../../../desktop/src/main/routine-service";
import {
  SessionManager,
  type SessionManagerDependencies,
} from "../../../desktop/src/main/session-manager";
import { SnoozeClock } from "../../../desktop/src/main/snooze-clock";
import type { LiteRoutinesControl, LiteSessions } from "../seams";
import { createLocalRoutineDispatch } from "./local-routine-dispatch";

/** One rebroadcast frame; the seam's sink signature (RemoteHost addSink). */
type LiteSink = (channel: string, args: unknown[]) => void;

/**
 * The seam shape plus the manager and routine handles: `startLiteFleetMember({ sessions })`
 * consumes it as a plain LiteSessions; the composition slice may reach the
 * real SessionManager and RoutineService behind it for its own getters.
 */
export interface LiteSessionBundle extends LiteSessions {
  readonly sessions: SessionManager;
  readonly routines: RoutineService;
  readonly routinesControl: LiteRoutinesControl;
}

// The bundle owns the two event seams every desktop caller injects (`send`,
// `broadcast`) and the host-internal routine hooks (`routineLifecycle`,
// `routines`), so the composition root passes everything EXCEPT these four.
export type LiteSessionBundleDependencies = Omit<
  SessionManagerDependencies,
  "send" | "broadcast" | "routineLifecycle" | "routines"
> & {
  /** Member's stable instance id (<dataDir>/instance-id); defaults to registry instanceId. */
  instanceId?: string;
  /** Process env used for provider-probe commands; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override paths for routines.json / routine-runs.json (defaults beside registryFile). */
  routinesFile?: string;
  routineRunsFile?: string;
  /** Host label shown in Routines header ("Routines on <machine>"); defaults to os.hostname(). */
  machineLabel?: () => string;
  /** Optional catalog/model-probe overrides for deterministic unit tests. */
  routineCatalog?: Pick<RoutineCatalogService, "list">;
  readChatModels?: () => Promise<ModelCatalogSnapshot>;
};
/** Settings `BackendState` must never carry (the BackendBroadcastSettings omit list). */
const NON_BROADCAST_SETTINGS: readonly string[] = [
  "memoryDefaultsSeeded",
  "autoThinkingDefaultSeeded",
  "telemetryThemesConsentId",
  "hibernateManualDefaultSeeded",
  "themeAgentAccessDefaultOnSeeded",
  "remoteEnabled",
  "remoteBind",
  "remotePort",
  "remoteToken",
  "remotePasswordHash",
  "remotePasswordSalt",
  "instanceId",
  "councilRoster",
  "chatLastModel",
  "chatLastThinkingLevel",
  "webhooksEnabled",
  "mcpEndpointEnabled",
];

/**
 * Builds the lite session cluster over a real `SessionManager`.
 *
 * The caller supplies the same dependency bag the desktop backend builds —
 * registry, provider keys, roots, and the pane/verifier picks — minus `send`
 * and `broadcast`, which belong to this bundle's sink fan-out. Pane seams are
 * still forwarded: SessionManager constructs its pane hosts internally, but
 * every window-touching path behind them (page factory, encoders) only runs
 * when a pane channel is dispatched, and lite ships none of those channels.
 */
export function createSessionBundle(input: LiteSessionBundleDependencies): LiteSessionBundle {
  const sinks = new Set<LiteSink>();
  const emit = (channel: string, ...args: unknown[]): void => {
    for (const sink of [...sinks]) sink(channel, args);
  };

  const sessionsRoot = input.getSessionsRoot();
  const archiveRoot = input.getArchiveRoot();

  /** Single-flight coalescing broadcast loop mirroring desktop MainBackend (#1286). */
  let broadcastRequests = 0;
  let broadcastInFlight = false;
  const broadcastWaiters: { order: number; settle: PromiseWithResolvers<void> }[] = [];

  const runBroadcastLoop = async (): Promise<void> => {
    broadcastInFlight = true;
    try {
      while (broadcastWaiters.length > 0) {
        await Promise.resolve();
        const coversThrough = broadcastRequests;
        let failure: unknown = null;
        try {
          emit(CH.onStateChanged, await buildState());
        } catch (error) {
          failure = error;
        }
        const covered: { order: number; settle: PromiseWithResolvers<void> }[] = [];
        while (broadcastWaiters.length > 0 && broadcastWaiters[0]!.order <= coversThrough) {
          covered.push(broadcastWaiters.shift()!);
        }
        for (const w of covered) {
          if (failure === null) w.settle.resolve();
          else w.settle.reject(failure);
        }
      }
    } finally {
      broadcastInFlight = false;
    }
  };

  const broadcast = (): Promise<void> => {
    const waiter = { order: ++broadcastRequests, settle: Promise.withResolvers<void>() };
    broadcastWaiters.push(waiter);
    if (!broadcastInFlight) void runBroadcastLoop();
    return waiter.settle.promise;
  };

  const baseEnv = input.env ?? process.env;
  const dataDir = path.dirname(input.registryFile);
  const routineHistory = new RoutineRunHistory(input.routineRunsFile ?? path.join(dataDir, "routine-runs.json"));
  const machineLabel =
    input.machineLabel ?? (() => [...os.hostname()].slice(0, FLEET_LABEL_MAX).join("") || "omp-ui");

  const providerKeyOverlay = (): NodeJS.ProcessEnv =>
    providerKeyEnv((envName) => input.providerKeys.rolloutValue(envName));
  const providerProbeEnv = (): NodeJS.ProcessEnv => ({
    ...withoutProviderKeys(baseEnv),
    ...providerKeyOverlay(),
  });
  const readChatModels =
    input.readModelCatalog ??
    input.readChatModels ??
    (() => readModelCatalog({ ompPath: input.getOmpPath(), env: providerProbeEnv() }));
  const hasConfiguredModelsFileProvider =
    input.hasConfiguredModelsFileProvider ?? (() => readModelsFileModelProviders().length > 0);

  let managerRef: SessionManager | null = null;
  let routinesRef: RoutineService | null = null;
  let routineLifecycle: RoutineLifecycleManager | null = null;

  const snoozeClock = new SnoozeClock({
    sessions: () => input.registry.sessions,
    updateSession: (tabId, patch) => {
      const updated = input.registry.updateSession(tabId, patch);
      if (patch.snoozed === false) void managerRef?.cancelSnoozePark(tabId);
      return updated;
    },
    broadcast: () => void broadcast(),
  });

  // Windowless default where a desktop default would reach Electron: the
  // partition clearer's fallback dynamic-imports browser-pane-contents (the
  // bundle shims it anyway; this keeps a unit-tested desktop build honest).
  const manager = new SessionManager({
    ...input,
    send: emit,
    broadcast,
    readModelCatalog: readChatModels,
    hasConfiguredModelsFileProvider,
    planFormatOverride: input.planFormatOverride ?? "md",
    vaultsEnabled: false,
    onSnoozeCleared: () => snoozeClock.sync(),
    browserPane: {
      ...input.browserPane,
      clearPartition: async () => {},
    },
    routines: {
      create: async (_tabId, args) => {
        const record = await routinesRef!.create(routineInputFromAgentCreate(args, new Date().toISOString()));
        return { id: record.id, name: record.name };
      },
      update: async (_tabId, args) => {
        const { record, wasEnabled } = await routinesRef!.updateFromAgent(args, new Date().toISOString());
        return { id: record.id, name: record.name, wasEnabled, enabled: record.enabled };
      },
      state: () => routinesRef!.state(),
      remove: (id) => routinesRef!.remove(id),
      runNow: (id) => routinesRef!.runNow(id),
      dryRun: (req) => routinesRef!.dryRun(req),
      toolCatalog: (projectCwd) => routinesRef!.toolCatalog(projectCwd),
      testScript: (req) => routinesRef!.testScript(req),
    },
    routineLifecycle: (access) => {
      routineLifecycle = new RoutineLifecycleManager({
        ...access,
        runDirectory: access.routineRunDirectory,
        runScript: (command, cwd, env) => runRoutineScript(command, cwd, env),
        history: routineHistory,
        isEnabled: () => input.registry.getSetting("routinesEnabled"),
        publish: () => routinesRef?.publish(),
      });
      return routineLifecycle;
    },
  });
  managerRef = manager;
  snoozeClock.sync();

  const liveRoutineCapabilities = (projectCwd: string): CapabilitySnapshot | null => {
    let best: CapabilitySnapshot | null = null;
    for (const s of input.registry.sessions) {
      if (s.projectCwd !== projectCwd || s.chat) continue;
      const snap = manager.capabilitySnapshot(s.tabId);
      if (snap !== null && snap.tools.status === "available" && (best === null || snap.updatedAt > best.updatedAt)) {
        best = snap;
      }
    }
    return best;
  };

  const routines = new RoutineService({
    store: new RoutineStore(input.routinesFile ?? path.join(dataDir, "routines.json")),
    history: routineHistory,
    catalog:
      input.routineCatalog ??
      new RoutineCatalogService({
        hasVaults: () => false,
        liveCapabilities: liveRoutineCapabilities,
        getOmpPath: input.getOmpPath,
        probeEnv: providerKeyOverlay,
      }),
    lifecycle: routineLifecycle!,
    isEnabled: () => input.registry.getSetting("routinesEnabled"),
    defaultWarnCostUsd: () => input.registry.getSetting("routineWarnCostUsd"),
    defaultMaxCostUsd: () => input.registry.getSetting("routineMaxCostUsd"),
    hasProject: (projectCwd) => input.registry.projects.some((p) => p.path === projectCwd),
    sessions: () => input.registry.sessions,
    clearSessionRoutine: (tabId) => input.registry.updateSession(tabId, { routine: null }),
    markSessionSettled: (tabId, settledAtMs) =>
      input.registry.updateSession(tabId, {
        settledAtMs,
        snoozed: false,
        snoozedUntilMs: null,
        reminderAtMs: null,
      }),
    isLive: (tabId) => manager.isLive(tabId),
    isTurnRunning: (tabId) => manager.isTurnRunning(tabId),
    awaitingHumanAnswer: (tabId) => manager.pendingAnswer(tabId),
    deleteSession: (tabId, cascade) => manager.deleteSession(tabId, cascade),
    dispatch: createLocalRoutineDispatch({
      registry: input.registry,
      instanceId: () => input.instanceId ?? input.registry.getSetting("instanceId"),
      machineLabel,
      providerReady: (cwd) => manager.modelProviderReady(cwd),
      spawnLocal: (req) => manager.spawn(req),
      settleOrphan: (tabId) => manager.settleSession(tabId),
    }),
    artifactRefreshBlocked: () => "The artifact library is disabled",
    machineLabel,
    send: (state) => emit(CH.onRoutinesState, state),
    broadcast: () => void broadcast(),
  });
  routinesRef = routines;
  routines.boot();

  const routinesControl: LiteRoutinesControl = {
    state: () => routines.state(),
    enable: async (caps) => {
      const patch: { routinesEnabled: boolean; routineWarnCostUsd?: number; routineMaxCostUsd?: number } = {
        routinesEnabled: true,
      };
      if (caps !== undefined && (caps.warnUsd !== undefined || caps.maxUsd !== undefined)) {
        const validated = parseRoutineSpendDefaults({
          warnUsd: caps.warnUsd ?? input.registry.getSetting("routineWarnCostUsd"),
          maxUsd: caps.maxUsd ?? input.registry.getSetting("routineMaxCostUsd"),
        });
        patch.routineWarnCostUsd = validated.warnUsd;
        patch.routineMaxCostUsd = validated.maxUsd;
      }
      // Single atomic write BEFORE arming scheduler timers so an overdue fire
      // immediately sees the new spend caps.
      input.registry.setSettings(patch);
      routines.onEnabledChanged(true);
      await broadcast();
      return routines.state();
    },
    disable: async () => {
      input.registry.setSetting("routinesEnabled", false);
      routines.onEnabledChanged(false);
      await broadcast();
      return routines.state();
    },
    setSpendDefaults: async (caps) => {
      if (!input.registry.getSetting("routinesEnabled")) {
        throw new Error(ROUTINES_DISABLED_ERROR);
      }
      const validated = parseRoutineSpendDefaults({
        warnUsd: caps.warnUsd ?? input.registry.getSetting("routineWarnCostUsd"),
        maxUsd: caps.maxUsd ?? input.registry.getSetting("routineMaxCostUsd"),
      });
      input.registry.setSettings({
        routineWarnCostUsd: validated.warnUsd,
        routineMaxCostUsd: validated.maxUsd,
      });
      routines.publish();
      await broadcast();
      return routines.state();
    },
  };

  const gate = input.spawnGate;

  const spawnGateState: SpawnGateState = {
    model: gate !== undefined && gate.model !== null ? formatModelRole(gate.model) : null,
    advisorModel: gate !== undefined && gate.advisorModel !== null ? formatModelRole(gate.advisorModel) : null,
  };

  /** backend.ts `summarize`, copied: the ephemeral fields all read SessionManager/registry. */
  async function summarize(record: OwnedSessionRecord): Promise<SessionSummary> {
    const loc = await resolveSessionLocation(sessionsRoot, archiveRoot, record.lineageDir, record.sessionId);
    const live: LiveState = manager.isLive(record.tabId)
      ? "live"
      : loc.where === "active"
        ? "dormant"
        : loc.where === "archived"
          ? "archived"
          : "missing";
    const streamStalled = manager.isStreamStalled(record.tabId);
    const turnRunning = manager.isTurnRunning(record.tabId);
    const turnAwaitingAsyncWork = manager.isTurnAwaitingAsyncWork(record.tabId);
    const awaitingHumanAnswer = manager.pendingAnswer(record.tabId);
    let title = record.cachedTitle;
    let status: SessionSummary["status"] = null;
    if (loc.where === "active") {
      try {
        const h = await hydrateSessionFile(loc.filePath);
        if (h.title?.trim()) title = h.title;
        status = h.status;
        const patch: Partial<Omit<OwnedSessionRecord, "tabId">> = {};
        if (h.id && h.id !== record.sessionId) patch.sessionId = h.id;
        const headTitle = h.title?.trim() ? h.title : null;
        if (headTitle !== record.cachedTitle) patch.cachedTitle = headTitle;
        const modified = h.mtime.toISOString();
        if (modified !== record.cachedModified) patch.cachedModified = modified;
        if (Object.keys(patch).length > 0) {
          record = input.registry.updateSession(record.tabId, patch) ?? record;
        }
      } catch {
        // Vanished mid-hydrate — render from cached fields.
      }
    }
    const gate = manager.planGate(record.tabId);
    const goal = manager.goalState(record.tabId);
    const vibe = manager.vibeSnapshot(record.tabId);
    const autoresearch = manager.autoresearchSnapshot(record.tabId);
    const bridgeAvailability = manager.bridgeAvailability(record.tabId);
    return {
      ...record,
      title: title?.trim() || "New session",
      status,
      live,
      pendingPlan: gate?.pending ?? null,
      planSettle: gate?.settle ?? null,
      ...(bridgeAvailability === undefined ? {} : { bridgeAvailability }),
      streamStalled,
      turnRunning,
      turnAwaitingAsyncWork,
      awaitingHumanAnswer,
      pendingDialogs: manager.pendingDialogs(record.tabId),
      ...(goal === undefined ? {} : { goal }),
      ...(autoresearch === undefined ? {} : { autoresearch }),
      ...(vibe === undefined ? {} : { vibe }),
      modelHold: manager.modelHold(record.tabId),
    };
  }

  /** backend.ts `buildState`, copied: settingsSnapshot minus the never-broadcast keys (secrets). */
  async function buildState(): Promise<BackendState> {
    const byProject = new Map<string, OwnedSessionRecord[]>();
    const chatRecords: OwnedSessionRecord[] = [];
    for (const record of input.registry.sessions) {
      if (record.chat) {
        chatRecords.push(record);
        continue;
      }
      const group = byProject.get(record.projectCwd);
      if (group) group.push(record);
      else byProject.set(record.projectCwd, [record]);
    }
    const groups: ProjectGroup[] = [];
    for (const project of input.registry.projects) {
      const sessions = await Promise.all(
        (byProject.get(project.path) ?? []).map((record) => summarize(record)),
      );
      groups.push({ project, sessions });
    }
    const chats = await Promise.all(chatRecords.map((record) => summarize(record)));
    // Strip internal settings from the persisted snapshot before broadcasting.
    const settings: Record<string, unknown> = { ...input.registry.settingsSnapshot() };
    for (const key of NON_BROADCAST_SETTINGS) delete settings[key];
    const broadcastSettings = settings as unknown as Omit<
      BackendState,
      "projects" | "chats" | "spawnGate" | "remoteInstances" | "fleetPending" | "fleetTerminals" | "telemetryThemesEnabled"
    >;
    return {
      ...broadcastSettings,
      artifactLibraryEnabled: false,
      telemetryThemesEnabled: false,
      projects: groups,
      chats,
      spawnGate: spawnGateState,
      // A join-only member never owns the owner-side rosters (#1010): it is
      // seen by owners, and its own joins live in the index slice's store.
      remoteInstances: [],
      fleetPending: [],
      fleetTerminals: [],
    };
  }

  // ---------------------------------------------------------------------------
  // The handler subset: every `this.sessions.*` and `this.routines.*` mapping
  // of backend.ts `handlers()` that needs no window, copied with its argument
  // shape (plus `models:readChat` and lineage-confined `plan:read`). Omitted by
  // rule, absent not denied: browserPane*/devicePane* (panes need a window),
  // reportStallCap/OS notifications (DesktopNotifier is an injected desktop
  // seam), the auth-bundle pick/import file channels (native dialogs),
  // app/omp update + restartForAppUpdate (electron-updater), project open /
  // vscode targets (window + OS integrations), fleetTerminal* / remoteInstance*
  // (the owner side), auth carry/pack/ingest transfers, settings setters
  // (including settings:setRoutinesEnabled and settings:setRoutineSpendDefaults,
  // which remain strictly host-local off the LAN WebSocket table per ADR-0100),
  // vault / artifact / stt / audio / diagnostics channels. The fleet provenance
  // rung on spawnSession is the index slice's gate (fleetServer), not the
  // cluster's, so raw `spawn` rides here.
  // ---------------------------------------------------------------------------
  const request = {
    [CH.getState]: () => buildState(),
    // Finding 3: every host-lite client is remote; directory browsing lists
    // arbitrary host paths and is desktop-only (omitted = unknown channel).
    [CH.addProject]: async (raw: string) => {
      const resolved = await resolveProjectPath(raw);
      if (isInChatsRoot(input.getChatsRoot(), resolved)) {
        throw new Error("omp-ui's chats folder can't be registered as a project");
      }
      const record = input.registry.addProject(resolved);
      // No head watcher / icon probe here (desktop backend extras, issue #904
      ///#1000): the lite index slice owns those polls; the add itself is core.
      await broadcast();
      return record;
    },
    [CH.removeProject]: async (projectPath: string) => {
      if (manager.hasLiveInProject(projectPath)) {
        throw new Error("project has live sessions — settle them first");
      }
      manager.stopProjectWatchers(projectPath);
      const sessions = input.registry.sessions;
      const checkouts = sessions.flatMap((session) =>
        session.projectCwd === projectPath && session.worktree !== null
          ? [{ projectCwd: projectPath, worktree: session.worktree }]
          : [],
      );
      await reclaimCheckouts(checkouts, {
        worktreesRoot: input.getWorktreesRoot(),
        survivingSessions: sessions.filter((session) => session.projectCwd !== projectPath),
        warn: (message, error) =>
          error === undefined ? console.warn(`[lite] ${message}`) : console.warn(`[lite] ${message}`, error),
      });
      input.registry.removeProject(projectPath);
      await broadcast();
    },
    [CH.toggleFavorite]: async (key: string) => {
      input.registry.toggleFavorite(key);
      await broadcast();
    },
    [CH.spawnSession]: (req: SpawnRequest) => manager.spawn(req),
    [CH.restartSession]: (tabId: string, carryoverContext?: string) =>
      manager.restart(tabId, carryoverContext === "" ? undefined : carryoverContext),
    [CH.settleSession]: (tabId: string) => manager.settleSession(tabId),
    [CH.unsettleSession]: (tabId: string) => {
      input.registry.updateSession(tabId, { settledAtMs: null });
      void broadcast();
    },
    [CH.hibernatePlanSource]: (sourceTabId: string, implementationTabId: string) =>
      manager.hibernatePlanSource(sourceTabId, implementationTabId),
    [CH.switchMode]: (tabId: string, mode: SessionMode) => manager.switchMode(tabId, mode),
    [CH.forkSession]: (tabId: string) => manager.forkSession(tabId),
    [CH.deleteSessionPreview]: (tabId: string) => manager.deleteSessionPreview(tabId),
    [CH.deleteSession]: (tabId: string, cascade: boolean) => manager.deleteSession(tabId, cascade),
    [CH.setSessionModel]: (tabId: string, model: string | null, thinkingLevel: string | null) => {
      // The #932 hold guard backend.ts carries: an echo of omp's fallback must
      // never replace the pin the next spawn retries.
      if (manager.modelHold(tabId) !== null) return;
      if (input.registry.setSessionModel(tabId, model, thinkingLevel)) {
        manager.syncModelOverlay(tabId);
      }
      void broadcast();
    },
    [CH.setSessionAutoTitled]: (tabId: string, autoTitled: boolean) => {
      input.registry.updateSession(tabId, { autoTitled });
      void broadcast();
    },
    // First-title ownership (issue #1090): the same atomic claim desktop
    // main answers — joined renderers of a host-lite-owned session race here.
    [CH.claimFirstTitle]: (tabId: string) => manager.claimFirstTitle(tabId),
    [CH.setSessionSnoozed]: async (tabId: string, snoozed: boolean, untilMs?: number | null) => {
      input.registry.updateSession(tabId, {
        snoozed,
        snoozedUntilMs: snoozed ? (untilMs ?? null) : null,
        reminderAtMs: null,
        ...(snoozed ? { settledAtMs: null } : {}),
      });
      snoozeClock.sync();
      const stillSnoozed = input.registry.sessions.find((s) => s.tabId === tabId)?.snoozed === true;
      if (snoozed && stillSnoozed) {
        manager.requestSnoozePark(tabId);
      } else {
        await manager.cancelSnoozePark(tabId);
      }
      void broadcast();
    },
    [CH.setSessionPinned]: async (tabId: string, pinned: boolean) => {
      const record = input.registry.sessions.find((s) => s.tabId === tabId);
      if (record === undefined) return;
      const clearSnooze = pinned && record.snoozed;
      input.registry.updateSession(tabId, {
        pinnedAtMs: pinned ? (record.pinnedAtMs ?? Date.now()) : null,
        ...(clearSnooze ? { snoozed: false, snoozedUntilMs: null } : {}),
      });
      if (clearSnooze) {
        snoozeClock.sync();
        await manager.cancelSnoozePark(tabId);
      }
      void broadcast();
    },
    [CH.setSessionAutoSettleOnMerge]: (tabId: string, on: boolean | null) => {
      input.registry.updateSession(tabId, { autoSettleOnMerge: on });
      void broadcast();
    },
    [CH.holdPrompt]: (tabId: string, req: HeldPromptRequest) => manager.heldPrompts.hold(tabId, req),
    [CH.cancelHeldPrompt]: (tabId: string) => manager.heldPrompts.cancel(tabId),
    [CH.sendHeldPromptNow]: (tabId: string) => manager.heldPrompts.sendNow(tabId),
    [CH.setScheduledPrompt]: (tabId: string, req: ScheduledPromptRequest) => manager.scheduledPrompts.set(tabId, req),
    [CH.clearScheduledPrompt]: (tabId: string) => manager.scheduledPrompts.clear(tabId),
    [CH.runScheduledPromptNow]: (tabId: string) => manager.scheduledPrompts.runNow(tabId),
    [CH.setSessionSubagentModels]: (tabId: string, map: SubagentModelMap | null) =>
      manager.setSessionSubagentModels(tabId, map),
    [CH.setSessionAdvisor]: (tabId: string, advisor: boolean, advisorModel: string | null) =>
      manager.setSessionAdvisor(tabId, advisor, advisorModel),
    [CH.setSessionApprovalMode]: (tabId: string, mode: ApprovalMode | null) =>
      manager.setSessionApprovalMode(tabId, mode),
    [CH.setSessionServiceTier]: (tabId: string, tier: ServiceTier | null) =>
      manager.setSessionServiceTier(tabId, tier),
    [CH.getSessionCapabilities]: (tabId: string) => manager.getSessionCapabilities(tabId),
    [CH.setSessionToolEnabled]: (
      tabId: string,
      processKey: string,
      sessionId: string | null,
      name: string,
      enabled: boolean,
    ) => manager.setSessionToolEnabled(tabId, processKey, sessionId, name, enabled),
    [CH.answerPlanReview]: (
      tabId: string,
      frameId: string,
      verdict: PlanReviewVerdict,
      sourceHash: string | null,
    ) => manager.answerPlanReview(tabId, frameId, verdict, sourceHash),
    [CH.dismissProposedPlan]: (tabId: string, planFilePath: string) =>
      manager.dismissProposedPlan(tabId, planFilePath),
    [CH.convertToWorktree]: (
      tabId: string,
      branch: string,
      baseRef: string | null,
      baseBranch: string | null,
      mode?: "mint" | "checkout",
    ) => manager.convertToWorktree(tabId, branch, baseRef, baseBranch, mode),
    [CH.reserveCheckout]: (tabId: string) => manager.reserveCheckout(tabId),
    [CH.releaseWorktree]: (tabId: string, opts: WorktreeReleaseOptions) => manager.releaseWorktree(tabId, opts),
    [CH.syncWorktree]: (tabId: string, source: string) => manager.syncWorktree(tabId, source),
    [CH.listDiscardedChanges]: (tabId: string) => manager.listDiscardedChanges(tabId),
    [CH.applyDiscardedChange]: (tabId: string, commit: string) => manager.applyDiscardedChange(tabId, commit),
    [CH.renameWorktreeBranch]: (tabId: string, newName: string) => manager.renameWorktreeBranch(tabId, newName),
    [CH.attachImage]: (tabId: string, image: ImageAttachment) => manager.attachImage(tabId, image),
    [CH.attachDocument]: (tabId: string, documents: DocumentAttachment[]) => manager.attachDocument(tabId, documents),
    [CH.readDocument]: (tabId: string, file: string) => manager.readDocument(tabId, file),
    [CH.readSpill]: (tabId: string, spillId: number) => manager.readSpill(tabId, spillId),
    [CH.ptyPasteImage]: (tabId: string, image: ImageAttachment) => manager.ptyPasteImage(tabId, image),
    [CH.ptyPasteDocument]: (tabId: string, document: DocumentAttachment) =>
      manager.ptyPasteDocument(tabId, document),
    [CH.shellSpawn]: (tabId: string, cwd: string, cols: number, rows: number, program?: ConsoleProgram) =>
      manager.launchShell(tabId, cwd, cols, rows, program),
    [CH.collabList]: () => manager.collabSnapshots(),
    [CH.collabShare]: (tabId: string, access: CollabAccess) => manager.collabShare(tabId, access),
    [CH.collabStop]: (tabId: string) => manager.collabStop(tabId),
    [CH.collabLink]: (tabId: string, view: boolean) => manager.collabLink(tabId, view),
    // Routines (ADR-0100, #1368): all 8 proxied routine channels ride here;
    // settings:setRoutinesEnabled and settings:setRoutineSpendDefaults stay OFF
    // the LAN WebSocket table and mutate only via LocalControlServer.
    [CH.getRoutinesState]: () => routines.state(),
    [CH.createRoutine]: (routineInput: RoutineInput) => routines.create(routineInput),
    [CH.updateRoutine]: (id: string, patch: RoutinePatch) => routines.update(id, patch),
    [CH.removeRoutine]: (id: string) => routines.remove(id),
    [CH.runRoutineNow]: (id: string) => routines.runNow(id),
    [CH.testRoutineScript]: (req: RoutineTestScriptRequest) => routines.testScript(req),
    [CH.dryRunRoutine]: (req: RoutineDryRunRequest) => routines.dryRun(req),
    [CH.listRoutineToolCatalog]: (projectCwd: string) => routines.toolCatalog(projectCwd),
    [CH.readChatModels]: () => readChatModels(),
    [CH.readPlanFile]: async (tabId: string, absPath: string): Promise<string | null> => {
      const snapshot = manager.planSnapshotFor(tabId, absPath);
      if (snapshot !== null) return snapshot.text;
      const record = input.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) return null;
      const root = path.resolve(sessionsRoot, record.lineageDir);
      const read = await readConfinedPlanFile(root, absPath);
      if (!read.ok) {
        if (read.reason === "outside") {
          console.warn("[plan] refusing to read outside the lineage dir:", absPath);
        }
        return null;
      }
      return read.text;
    },
  } satisfies Partial<SessionBundleRequestHandlers>;
  const notify = {
    [CH.ptyWrite]: (tabId: string, data: string) => manager.ptyWrite(tabId, data),
    [CH.ptyResize]: (tabId: string, cols: number, rows: number) => manager.ptyResize(tabId, cols, rows),
    [CH.shellKill]: (tabId: string) => manager.killShell(tabId),
    [CH.shellWrite]: (tabId: string, data: string) => manager.shellWrite(tabId, data),
    [CH.shellResize]: (tabId: string, cols: number, rows: number) => manager.shellResize(tabId, cols, rows),
    // The rpc command rail: prompt / steer / abort(interrupt) / follow_up and
    // every other omp control frame ride this single channel, exactly as the
    // desktop maps them.
    [CH.rpcSend]: (tabId: string, cmd: RpcFrame) => manager.rpcSend(tabId, cmd),
    [CH.tabViewed]: (clientId: string, tabId: string | null) => manager.setViewedTab(clientId, tabId),
  } satisfies Partial<SessionBundleNotifyHandlers>;

  return {
    // The seam's flat request-channel map; lite-backend layers the core-owned
    // channels (state:get, instance:identity, remote:*) over this.
    handlers: request,
    notify,
    sessions: manager,
    routines,
    routinesControl,
    state: buildState,
    on: (cb) => {
      sinks.add(cb);
      return () => {
        sinks.delete(cb);
      };
    },
    dispose: async () => {
      snoozeClock.dispose();
      await routines.disposeAsync();
      manager.killAll();
      sinks.clear();
    },
  };
}

// Locally named views of the core handler maps so `satisfies Partial<…>`
// checks every copied signature against the shipped channel descriptors.
type SessionBundleRequestHandlers = ChannelTable["request"];
type SessionBundleNotifyHandlers = ChannelTable["notify"];

export { SessionManager, type SessionManagerDependencies } from "../../../desktop/src/main/session-manager";
// Fleet member-leg machinery (#1010 Task B): the electron-free legs modules ride
// the same single bundle boundary as the session cluster — adapters-node.ts and
// production-sessions.ts load them through the built artifact, never by
// importing desktop source at runtime (source paths do not exist in the SEA).
export { launchFleetShell, messageOf, resolveFleetCwd } from "../../../desktop/src/main/fleet-shell";
export { FleetDetachedExecs } from "../../../desktop/src/main/fleet-detached-exec";
export { FleetTerminals } from "../../../desktop/src/main/fleet-terminals";
export { appendMainLog } from "../../../desktop/src/main/main-log";
// Re-exported so a bundled lite host shares ONE core copy (class identity for
// Registry/ProviderKeys between the index slice and this bundle) and reads
// channel names from the same table it dispatches.
export { CH, Registry, ProviderKeys } from "@omp-ui/core";
export type { LiteSessions } from "../seams";
