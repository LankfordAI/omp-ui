// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  McpServerEntry,
  McpServersResult,
  OmpSettingsSnapshot,
  OmpUpdateState,
} from "@omp-ui/core/types";
import { backendState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const idleOmpUpdate: OmpUpdateState = {
  status: "idle",
  installPath: null,
  installedVersion: null,
  latestVersion: null,
  progress: null,
  error: null,
};

const emptyOmpSettings: OmpSettingsSnapshot = {
  entries: [],
  agentDir: null,
  projectConfigPath: null,
  error: null,
};

// store.ts and backend.ts capture the preload bridge at module load, so
// install the mock before dynamically importing either.
const backendMock = {
  getState: vi.fn(),
  addProject: vi.fn(),
  browseDirectories: vi.fn(),
  removeProject: vi.fn(),
  moveProject: vi.fn(async () => {}),
  setDefaultMode: vi.fn(),
  setSkipDeleteConfirmation: vi.fn(),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
  switchMode: vi.fn(),
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  setSessionAdvisor: vi.fn(),
  getAdvisorDefaults: vi.fn(),
  setSessionModel: vi.fn(),
  generateTitle: vi.fn(),
  readPlanFile: vi.fn(),
  getBranchDiff: vi.fn(),
  getMcpServers: vi.fn(),
  setMcpServerEnabled: vi.fn(),
  restartSession: vi.fn(),
  ptyPasteImage: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  rpcSend: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onRpcFrame: vi.fn(),
  onStateChanged: vi.fn(),
  toggleFavorite: vi.fn(),
  getOmpUpdateState: vi.fn(async () => idleOmpUpdate),
  checkOmpUpdate: vi.fn(),
  downloadOmpUpdate: vi.fn(),
  dismissOmpUpdate: vi.fn(),
  onOmpUpdateState: vi.fn(),
  getAppUpdateState: vi.fn(),
  checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  openAppUpdateReleaseNotes: vi.fn(),
  showAppUpdateDownload: vi.fn(),
  restartForAppUpdate: vi.fn(),
  setAppUpdateInstallOnQuit: vi.fn(),
  dismissAppUpdate: vi.fn(),
  onAppUpdateState: vi.fn(),
  setThemeId: vi.fn(async () => {}),
  setAppUpdateCheckOnLaunch: vi.fn(async () => {}),
  setOmpUpdateCheckOnLaunch: vi.fn(async () => {}),
  clearDismissedAppUpdate: vi.fn(async () => {}),
  clearDismissedOmpUpdate: vi.fn(async () => {}),
  setWindowChrome: vi.fn(async () => {}),
  readOmpSettings: vi.fn(async () => emptyOmpSettings),
  writeOmpSetting: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { McpManager } = await import("./McpManager");

const PROJECT = "/proj";
const TAB = "tab-1";

const writableRow: McpServerEntry = {
  name: "native-one",
  transport: "stdio",
  endpoint: "native-bin --flag",
  source: "native",
  scope: "project",
  sourcePath: "/proj/.omp/mcp.json",
  effective: true,
  state: "enabled",
  writable: true,
};

const toolRow: McpServerEntry = {
  name: "cursor-one",
  transport: "http",
  endpoint: "https://api.example.com/mcp",
  source: "cursor",
  scope: "user",
  sourcePath: "/home/u/.cursor/mcp.json",
  effective: true,
  state: "enabled",
  writable: false,
};

const shadowedRow: McpServerEntry = {
  name: "dup",
  transport: "stdio",
  endpoint: "user-bin",
  source: "cursor",
  scope: "user",
  sourcePath: "/home/u/.cursor/mcp.json",
  effective: false,
  shadowedBy: "native:/proj/.omp/mcp.json",
  state: "enabled",
  writable: false,
};

/** A writable user-native row: togglable globally, pinned when source-disabled in project scope. */
const userNativeRow: McpServerEntry = {
  name: "user-native-one",
  transport: "stdio",
  endpoint: "user-bin",
  source: "native",
  scope: "user",
  sourcePath: "/home/u/.omp/agent/mcp.json",
  effective: true,
  state: "enabled",
  writable: true,
};

/** Mirrors App.tsx's mounting: the modal exists only while the store says so. */
function Gate() {
  const mcpManager = useStore((s) => s.mcpManager);
  return mcpManager ? (
    <McpManager projectCwd={mcpManager.projectCwd} tabId={mcpManager.tabId} />
  ) : null;
}

let root: Root | null = null;

async function renderManager(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Gate />));
}

function switchFor(label: string): HTMLButtonElement {
  const found = document.body.querySelector<HTMLButtonElement>(
    `button[role="switch"][aria-label="${label}"]`,
  );
  if (found === null) throw new Error(`switch not found: ${label}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.getMcpServers.mockResolvedValue({ servers: [], errors: [] });
  useStore.setState({ mcpManager: { projectCwd: PROJECT, tabId: TAB }, state: null });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("McpManager", () => {
  it("renders the empty state when no server resolves", async () => {
    await renderManager();
    expect(backendMock.getMcpServers).toHaveBeenCalledWith(PROJECT);
    expect(document.body.textContent).toContain("No MCP servers configured for this project.");
  });

  it("renders per-file errors while the list still shows", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow],
      errors: [{ path: "/home/u/.config/opencode/opencode.json", message: "Unexpected token ," }],
    } satisfies McpServersResult);
    await renderManager();
    expect(document.body.textContent).toContain("/home/u/.config/opencode/opencode.json");
    expect(document.body.textContent).toContain("Unexpected token ,");
    expect(document.body.textContent).toContain("native-one");
  });

  it("never passes sourcePath in project scope, even for writable rows", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow, toolRow],
      errors: [],
    } satisfies McpServersResult);
    backendMock.setMcpServerEnabled.mockImplementation(async (req: { name: string }) => ({
      servers: [writableRow, toolRow].map((s) =>
        s.name === req.name ? { ...s, state: "disabled" as const, disabledBy: "config" as const } : s,
      ),
      errors: [],
    }));
    await renderManager();

    await act(async () => {
      switchFor("disable native-one").click();
    });
    expect(backendMock.setMcpServerEnabled).toHaveBeenCalledWith({
      projectCwd: PROJECT,
      name: "native-one",
      sourcePath: undefined,
      enabled: false,
    });

    await act(async () => {
      switchFor("disable cursor-one").click();
    });
    expect(backendMock.setMcpServerEnabled).toHaveBeenCalledWith({
      projectCwd: PROJECT,
      name: "cursor-one",
      sourcePath: undefined,
      enabled: false,
    });

    // The list refreshes from the toggle's returned result.
    expect(document.body.textContent).toContain("disabled · config");
  });

  it("renders a toggle rejection inline and keeps the previous list", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow],
      errors: [],
    } satisfies McpServersResult);
    backendMock.setMcpServerEnabled.mockRejectedValue(
      new Error("Error invoking remote method 'mcp:setEnabled': Error: EACCES: permission denied"),
    );
    await renderManager();

    await act(async () => {
      switchFor("disable native-one").click();
    });
    expect(document.body.textContent).toContain("EACCES: permission denied");
    expect(document.body.textContent).not.toContain("Error invoking remote method");
    // The row keeps its prior state — no optimistic flip.
    expect(switchFor("disable native-one").getAttribute("aria-checked")).toBe("true");
  });

  it("renders shadowed rows dimmed, with no switch", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow, shadowedRow],
      errors: [],
    } satisfies McpServersResult);
    await renderManager();
    expect(document.body.textContent).toContain("shadowed by native");
    expect(
      document.body.querySelector('button[role="switch"][aria-label="disable dup"]'),
    ).toBeNull();
  });

  it("renders global scope for null projectCwd", async () => {
    useStore.setState({ mcpManager: { projectCwd: null }, state: null });
    backendMock.getMcpServers.mockResolvedValue({ servers: [toolRow, userNativeRow], errors: [] } satisfies McpServersResult);
    await renderManager();
    expect(backendMock.getMcpServers).toHaveBeenCalledWith(null);
    const body = document.body.textContent ?? "";
    expect(body).toContain("Global integrations");
    expect(body).toContain("Global — user-level configuration");
    expect(body).toContain("Changes apply to new sessions in every project.");
    expect(body).not.toContain("restart session to apply");
    backendMock.setMcpServerEnabled.mockResolvedValue({ servers: [toolRow, userNativeRow], errors: [] } satisfies McpServersResult);
    await act(async () => {
      switchFor("disable cursor-one").click();
    });
    expect(backendMock.setMcpServerEnabled).toHaveBeenCalledWith({
      projectCwd: null,
      name: "cursor-one",
      sourcePath: undefined,
      enabled: false,
    });
    await act(async () => {
      switchFor("disable user-native-one").click();
    });
    expect(backendMock.setMcpServerEnabled).toHaveBeenCalledWith({
      projectCwd: null,
      name: "user-native-one",
      sourcePath: "/home/u/.omp/agent/mcp.json",
      enabled: false,
    });
  });

  it("shows the restart button only when opened from a live tab", async () => {
    const liveState = backendState({
      projects: [
        {
          project: { path: PROJECT, name: "Proj", addedAt: "t", lastModel: null, lastAdvisorModel: null },
          sessions: [
            {
              tabId: TAB,
              sessionId: "s1",
              lineageDir: "omp-ui--proj--s1",
              projectCwd: PROJECT,
              launchedAt: "t",
              mode: "rpc-ui",
              advisor: false,
              advisorModel: null,
              cachedTitle: "T",
              cachedModified: "t",
              title: "T",
              status: "complete",
              live: "live",
              pendingPlan: null,
              planSettle: null,
              streamStalled: false,
            },
          ],
        },
      ],
    });
    // Live tab → the footer offers the in-place restart.
    useStore.setState({ mcpManager: { projectCwd: PROJECT, tabId: TAB }, state: liveState });
    await renderManager();
    expect(document.body.textContent).toContain("restart session to apply");
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";

    // Same opener, no live state → passive footer only.
    useStore.setState({ mcpManager: { projectCwd: PROJECT, tabId: TAB }, state: null });
    await renderManager();
    expect(document.body.textContent).not.toContain("restart session to apply");
  });

  it("pins user-level-disabled rows in project scope, but not in global scope", async () => {
    const denylisted: McpServerEntry = {
      ...userNativeRow,
      name: "denied-one",
      state: "disabled",
      disabledBy: "denylist",
    };
    const sourceDisabled: McpServerEntry = {
      ...toolRow,
      name: "off-one",
      state: "disabled",
      disabledBy: "config",
    };
    backendMock.getMcpServers.mockResolvedValue({
      servers: [denylisted, sourceDisabled],
      errors: [],
    } satisfies McpServersResult);

    // Project scope: nothing project-local can enable these — pinned.
    await renderManager();
    for (const label of ["enable denied-one", "enable off-one"]) {
      const pinned = switchFor(label);
      expect(pinned.disabled).toBe(true);
      expect(pinned.title).toContain("enable it globally from Settings");
    }
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";

    // Global scope: the same rows toggle through omp's user-level algorithm.
    useStore.setState({ mcpManager: { projectCwd: null }, state: null });
    await renderManager();
    for (const label of ["enable denied-one", "enable off-one"]) {
      expect(switchFor(label).disabled).toBe(false);
    }
  });

  it("keeps a live switch on a project-disabled row and describes the override write", async () => {
    const projectDisabled: McpServerEntry = {
      ...writableRow,
      name: "skeleton-one",
      state: "disabled",
      disabledBy: "config",
    };
    backendMock.getMcpServers.mockResolvedValue({
      servers: [projectDisabled, toolRow],
      errors: [],
    } satisfies McpServersResult);
    await renderManager();

    // Disabled by a project-scope entry → still togglable, flipped in place.
    const skeleton = switchFor("enable skeleton-one");
    expect(skeleton.disabled).toBe(false);
    expect(skeleton.title).toBe("writes enabled:true to /proj/.omp/mcp.json");
    // Winner outside the project → the toggle writes a project-only override.
    expect(switchFor("disable cursor-one").title).toBe(
      "writes a project-only override to .omp/mcp.json",
    );
    // Project-scope footer names the blast radius.
    expect(document.body.textContent).toContain("Changes apply to new sessions in this project.");
  });
});
