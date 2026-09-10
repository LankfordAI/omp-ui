import { vi, type Mock } from "vitest";
import type { AppUpdateState, BackendState, RemoteInstanceSummary } from "@omp-ui/core/types";
import { DESKTOP_CHANNELS, type DesktopAdapter } from "@omp-ui/core/desktop-channels";
import { idleHostUpdateState } from "@omp-ui/core/host-update-state";
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
    ompUpdateCheckOnLaunch: true,
    dismissedAppUpdateVersion: null,
    dismissedOmpUpdateVersion: null,
    spawnGate: { model: null, advisorModel: null },
    remoteInstances: [],
    self: { role: "desktop", local: true },
    hostVersion: "0.0.0-test",
    hostProtocol: 2,
    protocolRange: { min: 1, max: 2 },
    hostUpdate: idleHostUpdateState("0.0.0-test"),
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

export function appUpdateState(patch: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: "idle",
    currentVersion: null,
    latestVersion: null,
    releaseUrl: null,
    releaseName: null,
    format: "unknown",
    progress: null,
    downloadedPath: null,
    installOnQuit: false,
    error: null,
    ...patch,
  };
}

/** One recorder per desktop:* member, typed like the adapter the renderer reads. */
export type DesktopAdapterMock = { -readonly [M in keyof DesktopAdapter]: Mock<DesktopAdapter[M]> };

/**
 * A desktop client's adapter (#454) with every member a `vi.fn()`; requests resolve void and
 * `getAppUpdateState` resolves idle unless overridden. Does not touch `window`: the store
 * harness stubs `window` wholesale and places the mock itself.
 */
export function desktopAdapterMock(overrides: Partial<DesktopAdapterMock> = {}): DesktopAdapterMock {
  const members: Record<string, Mock> = {};
  for (const [method, descriptor] of Object.entries(DESKTOP_CHANNELS)) {
    members[method] = descriptor.kind === "request" ? vi.fn(async () => undefined) : vi.fn();
  }
  return Object.assign(
    members as unknown as DesktopAdapterMock,
    { getAppUpdateState: vi.fn(async () => appUpdateState()) },
    overrides,
  );
}

/**
 * Installs `window.ompDesktop` so the dynamically imported renderer boots as a desktop client.
 * Must run before `../desktop` (and so `../store`) is imported: it reads the global at load.
 */
export function installDesktopAdapter(overrides: Partial<DesktopAdapterMock> = {}): DesktopAdapterMock {
  const mock = desktopAdapterMock(overrides);
  window.ompDesktop = mock;
  return mock;
}
