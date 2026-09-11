import type { BackendState, RemoteInstanceSummary } from "@omp-ui/core/types";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { RpcTabState, TabInfo } from "../store";

export function backendState(patch: Partial<BackendState> = {}): BackendState {
  return {
    projects: [],
    defaultMode: "rpc-ui",
    defaultAgentMode: "plan",
    defaultCompactionMethod: null,
    planFormat: "html",
    hibernateIdleMinutes: 30,
    streamStallAbortSeconds: 180,
    advisorAutoReply: true,
    stallAutoContinue: true,
    desktopNotifications: true,
    defaultAdvisor: false,
    modelFavorites: [],
    skipDeleteConfirmation: false,
    themeId: "graphite",
    fontFamilyId: "default",
    transcriptWidth: "wide",
    glassChrome: "subtle",
    localeId: "en",
    appUpdateCheckOnLaunch: true,
    appUpdateTrain: "stable",
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

export function rpcTabState(patch: Partial<RpcTabState> = {}): RpcTabState {
  return {
    status: "ready",
    items: [],
    todos: [],
    model: null,
    availableModels: [],
    commands: [],
    session: emptySessionRuntime(),
    stats: null,
    subagents: [],
    subagentItems: {},
    selectedSubagent: null,
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
    autoTitleSent: null,
    hasRenamed: false,
    plan: null,
    planReview: null,
    planText: null,
    planHtml: null,
    planDeferred: false,
    plans: [],
    advisorStats: null,
    mcpStatus: null,
    goal: null,
    capabilities: null,
    capabilitiesLoad: "idle",
    advisorReply: true,
    ...patch,
  };
}
