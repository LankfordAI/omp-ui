import type { BackendState } from "@omp-ui/core/types";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { RpcTabState, TabInfo } from "../store";

export function backendState(patch: Partial<BackendState> = {}): BackendState {
  return {
    projects: [],
    defaultMode: "rpc-ui",
    defaultAgentMode: "plan",
    planFormat: "html",
    hibernateIdleMinutes: 30,
    streamStallAbortSeconds: 180,
    advisorAutoReply: true,
    defaultAdvisor: false,
    modelFavorites: [],
    skipDeleteConfirmation: false,
    themeId: "graphite",
    appUpdateCheckOnLaunch: true,
    ompUpdateCheckOnLaunch: true,
    dismissedAppUpdateVersion: null,
    dismissedOmpUpdateVersion: null,
    ...patch,
  };
}

export function tabInfo(patch: Partial<TabInfo> = {}): TabInfo {
  return {
    tabId: "tab-test",
    mode: "rpc-ui",
    projectCwd: "/project",
    hidden: false,
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
    subagentLevel: "progress",
    extensionStatus: {},
    pendingCommands: new Map(),
    streamCheckpoint: undefined,
    streamStallMs: undefined,
    stallCount: 0,
    extensionQueue: [],
    busy: false,
    initialPrompt: null,
    hasRenamed: false,
    plan: null,
    planReview: null,
    planText: null,
    planHtml: null,
    planDeferred: false,
    plans: [],
    advisorStats: null,
    advisorReply: true,
    ...patch,
  };
}
