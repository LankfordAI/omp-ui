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
import {
  CH,
  browseDirectories,
  formatModelRole,
  hydrateSessionFile,
  isInChatsRoot,
  reclaimCheckouts,
  resolveProjectPath,
  resolveSessionLocation,
  type ApprovalMode,
  type BackendState,
  type ChannelTable,
  type CollabAccess,
  type ConsoleProgram,
  type DocumentAttachment,
  type HeldPromptRequest,
  type ImageAttachment,
  type LiveState,
  type OwnedSessionRecord,
  type PlanReviewVerdict,
  type ProjectGroup,
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
import {
  SessionManager,
  type SessionManagerDependencies,
} from "../../../desktop/src/main/session-manager";
import type { LiteEvent, LiteSessions } from "./seams-shape";

// The bundle owns the two event seams every desktop caller injects: `send`
// fans per-session frames into the sinks, `broadcast` rebuilds the state and
// emits it. A caller-supplied pair would bypass (or double) that fan-out, so
// the composition root passes everything EXCEPT these two.
export type LiteSessionBundleDependencies = Omit<
  SessionManagerDependencies,
  "send" | "broadcast"
>;

/** Settings `BackendState` must never carry (the BackendBroadcastSettings omit list). */
const NON_BROADCAST_SETTINGS: readonly string[] = [
  "memoryDefaultsSeeded",
  "autoThinkingDefaultSeeded",
  "hibernateManualDefaultSeeded",
  "remoteEnabled",
  "remoteBind",
  "remotePort",
  "remoteToken",
  "remotePasswordHash",
  "remotePasswordSalt",
  "instanceId",
  "reviewRoster",
  "reviewRosterImported",
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
export function createSessionBundle(input: LiteSessionBundleDependencies): LiteSessions {
  const sinks = new Set<LiteEvent>();
  const emit = (channel: string, ...args: unknown[]): void => {
    for (const sink of [...sinks]) sink(channel, args);
  };

  const sessionsRoot = input.getSessionsRoot();
  const archiveRoot = input.getArchiveRoot();

  /** Mirrors the desktop backend's serialize-then-catch chain: a failed build never wedges the queue. */
  let broadcastChain: Promise<void> = Promise.resolve();
  const broadcast = (): Promise<void> => {
    const task = broadcastChain.then(async () => {
      emit(CH.onStateChanged, await buildState());
    });
    broadcastChain = task.catch(() => {});
    return task;
  };

  // Windowless default where a desktop default would reach Electron: the
  // partition clearer's fallback dynamic-imports browser-pane-contents (the
  // bundle shims it anyway; this keeps a unit-tested desktop build honest).
  const manager = new SessionManager({
    ...input,
    send: emit,
    broadcast,
    browserPane: {
      ...input.browserPane,
      clearPartition: async () => {},
    },
  });

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
    // settingsSnapshot() returns every persisted setting; deleting the 16
    // BackendBroadcastSettings-omit keys leaves exactly the broadcast surface.
    // TS can not compute that subtraction, so narrow once, named:
    const settings: Record<string, unknown> = { ...input.registry.settingsSnapshot() };
    for (const key of NON_BROADCAST_SETTINGS) delete settings[key];
    const broadcastSettings = settings as unknown as Omit<
      BackendState,
      "projects" | "chats" | "spawnGate" | "remoteInstances" | "fleetPending" | "fleetTerminals"
    >;
    return {
      ...broadcastSettings,
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
  // The handler subset: every `this.sessions.*` mapping of backend.ts
  // `handlers()` that needs no window, copied with its argument shape. Omitted
  // by rule, absent not denied: browserPane*/devicePane* (panes need a window),
  // reportStallCap/OS notifications (DesktopNotifier is an injected desktop
  // seam), the auth-bundle pick/import file channels (native dialogs),
  // app/omp update + restartForAppUpdate (electron-updater), project open /
  // vscode targets (window + OS integrations), fleetTerminal* / remoteInstance*
  // (the owner side), auth carry/pack/ingest transfers and every settings /
  // vault / stt / audio / diagnostics channel that is not session-cluster
  // state. The fleet provenance rung on spawnSession is the index slice's
  // gate (fleetServer), not the cluster's, so raw `spawn` rides here.
  // ---------------------------------------------------------------------------
  const request = {
    [CH.getState]: () => buildState(),
    [CH.browseDirectories]: (partialPath: string) => browseDirectories(partialPath),
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
    [CH.hibernatePlanSource]: (sourceTabId: string, implementationTabId: string) =>
      manager.hibernatePlanSource(sourceTabId, implementationTabId),
    [CH.switchMode]: (tabId: string, mode: SessionMode) => manager.switchMode(tabId, mode),
    [CH.forkSession]: (tabId: string) => manager.forkSession(tabId),
    [CH.deleteSessionPreview]: (tabId: string) => manager.deleteSessionPreview(tabId),
    [CH.deleteSession]: (tabId: string, cascade: boolean) => manager.deleteSession(tabId, cascade),
    [CH.sessionTranscriptPath]: (tabId: string) => manager.transcriptPath(tabId),
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
    // The snooze deadline's wake clock is the index slice's service (the
    // desktop backend's snoozeClock): the flag/deadline persists here so the
    // owner's sidebar stays honest; nothing fires a live-process wake until
    // that slice lands.
    [CH.setSessionSnoozed]: (tabId: string, snoozed: boolean, untilMs?: number | null) => {
      input.registry.updateSession(tabId, {
        snoozed,
        snoozedUntilMs: snoozed ? (untilMs ?? null) : null,
      });
      void broadcast();
    },
    [CH.setSessionPinned]: (tabId: string, pinned: boolean) => {
      const record = input.registry.sessions.find((s) => s.tabId === tabId);
      if (record === undefined) return;
      input.registry.updateSession(tabId, { pinnedAtMs: pinned ? (record.pinnedAtMs ?? Date.now()) : null });
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
    [CH.convertToWorktree]: (tabId: string, branch: string, baseRef: string | null, baseBranch: string | null) =>
      manager.convertToWorktree(tabId, branch, baseRef, baseBranch),
    [CH.releaseWorktree]: (tabId: string, opts: WorktreeReleaseOptions) => manager.releaseWorktree(tabId, opts),
    [CH.syncWorktree]: (tabId: string, source: string) => manager.syncWorktree(tabId, source),
    [CH.listDiscardedChanges]: (tabId: string) => manager.listDiscardedChanges(tabId),
    [CH.applyDiscardedChange]: (tabId: string, commit: string) => manager.applyDiscardedChange(tabId, commit),
    [CH.renameWorktreeBranch]: (tabId: string, newName: string) => manager.renameWorktreeBranch(tabId, newName),
    [CH.attachImage]: (tabId: string, image: ImageAttachment) => manager.attachImage(tabId, image),
    [CH.attachDocument]: (tabId: string, documents: DocumentAttachment[]) => manager.attachDocument(tabId, documents),
    [CH.readDocument]: (tabId: string, file: string) => manager.readDocument(tabId, file),
    [CH.ptyPasteImage]: (tabId: string, image: ImageAttachment) => manager.ptyPasteImage(tabId, image),
    [CH.ptyPasteDocument]: (tabId: string, document: DocumentAttachment) =>
      manager.ptyPasteDocument(tabId, document),
    [CH.shellSpawn]: (tabId: string, cwd: string, cols: number, rows: number, program?: ConsoleProgram) =>
      manager.launchShell(tabId, cwd, cols, rows, program),
    [CH.collabList]: () => manager.collabSnapshots(),
    [CH.collabShare]: (tabId: string, access: CollabAccess) => manager.collabShare(tabId, access),
    [CH.collabStop]: (tabId: string) => manager.collabStop(tabId),
    [CH.collabLink]: (tabId: string, view: boolean) => manager.collabLink(tabId, view),
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
    handlers: { request, notify },
    sessions: manager,
    state: buildState,
    on: (cb) => {
      sinks.add(cb);
      return () => {
        sinks.delete(cb);
      };
    },
    dispose: () => {
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
// Re-exported so a bundled lite host shares ONE core copy (class identity for
// Registry/ProviderKeys between the index slice and this bundle) and reads
// channel names from the same table it dispatches.
export { CH, Registry, ProviderKeys } from "@omp-ui/core";
export type { LiteEvent, LiteSessions } from "./seams-shape";
