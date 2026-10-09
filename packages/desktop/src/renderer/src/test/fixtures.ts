import type { BackendState, RemoteInstanceSummary } from "@omp-ui/core/types";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { RpcTabState, TabInfo } from "../store";

export function backendState(patch: Partial<BackendState> = {}): BackendState {
  return {
    projects: [],
    sidebarGroups: [],
    defaultMode: "rpc-ui",
    defaultAgentMode: "plan",
    defaultCompactionMethod: null,
    planFormat: "html",
    hibernateIdleMinutes: 30,
    streamStallAbortSeconds: 180,
    advisorAutoReply: true,
    stallAutoContinue: true,
    desktopNotifications: true,
    subagentModelInheritByDefault: true,
  agentRoster: [],
  defaultAdvisor: false,
    defaultAutoThinking: false,
    modelFavorites: [],
    skipDeleteConfirmation: false,
    experimentsEnabled: false,
    voiceInputEnabled: false,
    liveWorkParking: true,
    sttModel: null,
    // Existing suites never auto-open the first-run checklist (issue #623).
    gettingStartedSeen: true,
    themeId: "graphite",
    fontFamilyId: "default",
    transcriptWidth: "wide",
    glassChrome: "subtle",
    localeId: "en",
    appUpdateCheckOnLaunch: true,
    appUpdateTrain: "stable",
    vaultRegistry: { vaults: [], defaultWriteVault: null },
    vaultNoteVoice: "user",
    ompUpdateCheckOnLaunch: true,
    dismissedAppUpdateVersion: null,
    dismissedOmpUpdateVersion: null,
    spawnGate: { model: null, advisorModel: null },
    remoteInstances: [],
    ...patch,
  };
}

export function tabInfo(patch: Partial<TabInfo> = {}): TabInfo {
  return {
    tabId: "tab-test",
    mode: "rpc-ui",
    projectCwd: "/project",
    hidden: false,
    instanceId: null,
    ...patch,
  };
}

export function remoteInstance(
  patch: Partial<RemoteInstanceSummary> = {},
): RemoteInstanceSummary {
  return {
    id: "inst-1",
    nickname: "box-a",
    url: "http://box-a:4677",
    status: "joined",
    error: null,
    version: "1.0.0",
    projects: [],
    modelFavorites: [],
    ...patch,
  };
}

/** BackendState where `tabId`'s session is owned by the joined remote instance `instanceId` (issue #416). */
export function remoteOwnedState(tabId: string, instanceId: string): BackendState {
  return backendState({
    remoteInstances: [
      remoteInstance({
        id: instanceId,
        status: "joined",
        projects: [
          {
            project: {
              path: "/remote/p",
              name: "P",
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
            sessions: [
              {
                tabId,
                sessionId: "s",
                lineageDir: "lineage",
                projectCwd: "/remote/p",
                launchedAt: "t",
                mode: "rpc-ui",
                worktree: null,
                planImplementationSource: null,
                experiment: null,
                agentMode: "build",
                compactionMethod: null,
                approvalMode: null,
                serviceTier: null,
                model: null,
                thinkingLevel: null,
                advisor: false,
                advisorModel: null,
                subagentModels: null,
                proposedPlans: [],
                autoTitled: false,
                cachedTitle: "Remote session",
                cachedModified: "t",
                title: "Remote session",
                status: "complete",
                live: "live",
                pendingPlan: null,
                planSettle: null,
                streamStalled: false,
              },
            ],
          },
        ],
      }),
    ],
  });
}

export function rpcTabState(patch: Partial<RpcTabState> = {}): RpcTabState {
  return {
    status: "ready",
    activeTurnKeywords: [],
    items: [],
    transcriptRevision: 0,
    todos: [],
    model: null,
    availableModels: [],
    commands: [],
    session: emptySessionRuntime(),
    stats: null,
    subagents: [],
    subagentItems: {},
    selectedSubagent: null,
    browserPane: {
      open: false,
      fullscreen: false,
      agentOpened: false,
      ensure: "idle",
      unavailableReason: null,
      state: null,
      frame: null,
    },
    subagentMarkers: new Map(),
    subagentAckLevel: "progress",
    extensionStatus: {},
    streamCheckpoint: undefined,
    streamStallMs: undefined,
    stallAbortPending: undefined,
    stallCount: 0,
    extensionQueue: [],
    busy: false,
    initialPrompt: null,
    hasRenamed: false,
    titleAttempt: null,
    plan: null,
    planReview: null,
    planText: null,
    planHtml: null,
    planDeferred: false,
    planReadiness: null,
    experimentProposal: null,
    approvalPrompt: null,
    advisorStats: null,
    mcpStatus: null,
    goal: null,
    vibe: null,
    sideQuestions: null,
    live: null,
    subagentControlBusy: {},
    subagentControlError: null,
    autoresearch: null,
    limits: null,
    capabilities: null,
    capabilitiesLoad: "idle",
    advisorReply: true,
    ...patch,
  };
}
