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

/** Mirrors App.tsx's mounting: the modal exists only while the store says so. */
function Gate() {
  const mcpManager = useStore((s) => s.mcpManager);
  return mcpManager ? <McpManager tabId={mcpManager.tabId} projectCwd={mcpManager.projectCwd} /> : null;
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
  useStore.setState({ mcpManager: { tabId: TAB, projectCwd: PROJECT }, state: null });
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

  it("passes sourcePath only for a writable row's toggle", async () => {
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
      sourcePath: "/proj/.omp/mcp.json",
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
});
