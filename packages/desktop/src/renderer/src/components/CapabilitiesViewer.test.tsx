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
import type { CapabilitySnapshot, CapabilityTool } from "@omp-ui/core/capabilities";
import { backendState, rpcTabState, tabInfo } from "../test/fixtures";

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
  deleteSession: vi.fn(async (tabId: string) => ({ deleted: [tabId], failed: [] })),
  deleteSessionPreview: vi.fn(async () => ({ descendants: [] })),
  forkSession: vi.fn(),
  setSessionAdvisor: vi.fn(),
  getAdvisorDefaults: vi.fn(),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
  setSessionModel: vi.fn(),
  generateTitle: vi.fn(),
  readPlanFile: vi.fn(),
  getBranchDiff: vi.fn(),
  getMcpServers: vi.fn(),
  setMcpServerEnabled: vi.fn(),
  getSessionCapabilities: vi.fn(async () => ({ status: "missing-session" as const })),
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
  setFontFamilyId: vi.fn(async () => {}),
  setLocaleId: vi.fn(async () => {}),
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
const { CapabilitiesViewer } = await import("./CapabilitiesViewer");

const PROJECT = "/proj";
const TAB = "tab-1";
/** A worktree session's checkout — deliberately sharing no substring with PROJECT. */
const CHECKOUT = "/wt/feat-x";
const BRANCH = "omp/feat-x";

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

/** A live pinned session for TAB — the only shape that offers restart or TUI handoff. */
const liveState = backendState({
  projects: [
    {
      project: { path: PROJECT, name: "Proj", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
      sessions: [
        {
          tabId: TAB,
          sessionId: "s1",
          lineageDir: "omp-ui--proj--s1",
          projectCwd: PROJECT,
          launchedAt: "t",
          mode: "rpc-ui",
          worktree: null,
          planImplementationSource: null,
          agentMode: "build",
          compactionMethod: null,
          model: null,
          thinkingLevel: null,
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

/** The same pinned session, re-shaped: the handoff needs a live *native* tab. */
const liveSession = liveState.projects[0]!.sessions[0]!;
function pinnedState(session: Partial<typeof liveSession>) {
  return backendState({
    projects: [
      {
        project: liveState.projects[0]!.project,
        sessions: [{ ...liveSession, ...session }],
      },
    ],
  });
}

/** Mirrors App.tsx's mounting: the modal exists only while the store says so. */
function Gate() {
  const viewer = useStore((s) => s.capabilitiesViewer);
  return viewer ? (
    <CapabilitiesViewer
      scopeCwd={viewer.scopeCwd}
      tabId={viewer.tabId}
      section={viewer.section ?? "mcp"}
    />
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

/** The per-row TUI-handoff buttons, in row order. */
function authenticateButtons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => b.textContent === "authenticate",
  );
}

/** The footer's `/mcp reload` control, absent unless the pinned tab is live. */
function reloadButton(): HTMLButtonElement | null {
  return (
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "reload MCP in this session" || b.textContent === "reloading…",
    ) ?? null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.getMcpServers.mockResolvedValue({ servers: [], errors: [] });
  useStore.setState({ capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" }, state: null, rpc: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("CapabilitiesViewer — MCP tab", () => {
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

  it("renders global scope for null scopeCwd", async () => {
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "mcp" }, state: null });
    backendMock.getMcpServers.mockResolvedValue({ servers: [toolRow, userNativeRow], errors: [] } satisfies McpServersResult);
    await renderManager();
    expect(backendMock.getMcpServers).toHaveBeenCalledWith(null);
    const body = document.body.textContent ?? "";
    expect(body).toContain("Global MCP configuration");
    expect(body).toContain("Changes apply to new sessions in every project.");
    expect(reloadButton()).toBeNull();
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

  it("reloads MCP in a live native session with /mcp reload, never a restart", async () => {
    const runSlashCommand = vi.fn<(tabId: string, line: string) => Promise<void>>(async () => {});
    const restartSession = vi.fn<(tabId: string) => Promise<boolean>>(async () => true);
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" },
      state: liveState,
      runSlashCommand,
      restartSession,
    });
    await renderManager();

    const button = reloadButton();
    expect(button?.textContent).toBe("reload MCP in this session");
    expect(button?.title).toBe(
      "run /mcp reload in this session so it picks up the current MCP config",
    );
    await act(async () => {
      button!.click();
    });
    expect(runSlashCommand).toHaveBeenCalledWith(TAB, "/mcp reload");
    // omp rebinds its MCP tools in place, so the session survives (#327).
    expect(restartSession).not.toHaveBeenCalled();
    // The reload settled; the modal that asked for it steps aside.
    expect(useStore.getState().capabilitiesViewer).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("types /mcp reload into a live terminal session's TUI", async () => {
    const runSlashCommand = vi.fn<(tabId: string, line: string) => Promise<void>>(async () => {});
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" },
      state: pinnedState({ mode: "pty" }),
      runSlashCommand,
    });
    await renderManager();

    expect(reloadButton()?.textContent).toBe("reload MCP in this session");
    await act(async () => {
      reloadButton()!.click();
    });
    expect(backendMock.ptyWrite).toHaveBeenCalledWith(TAB, "/mcp reload\r");
    // A pty tab has no rpc channel to run the command over.
    expect(runSlashCommand).not.toHaveBeenCalled();
    expect(useStore.getState().capabilitiesViewer).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("waits out a running native turn, but never a running terminal one", async () => {
    // A native reload would queue behind the turn; a pty tab only receives the
    // typed line, so its control stays live.
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" },
      state: liveState,
      rpc: { [TAB]: rpcTabState({ status: "running" }) },
    });
    await renderManager();
    const native = reloadButton();
    expect(native?.disabled).toBe(true);
    expect(native?.title).toBe("wait for the current turn to finish");
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";

    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" },
      state: pinnedState({ mode: "pty" }),
      rpc: { [TAB]: rpcTabState({ status: "running" }) },
    });
    await renderManager();
    expect(reloadButton()?.disabled).toBe(false);
  });

  it("offers no reload unless the pinned tab is live", async () => {
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" },
      state: pinnedState({ live: "dormant" }),
    });
    await renderManager();
    expect(reloadButton()).toBeNull();
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";

    // Same opener, no loaded state → passive footer only.
    useStore.setState({ capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" }, state: null });
    await renderManager();
    expect(reloadButton()).toBeNull();
  });

  it("names the checkout a worktree session resolved in and the project it writes through to", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow],
      errors: [],
    } satisfies McpServersResult);
    useStore.setState({
      capabilitiesViewer: { scopeCwd: CHECKOUT, tabId: TAB, section: "mcp" },
      state: pinnedState({ worktree: { path: CHECKOUT, branch: BRANCH, base: "main" } }),
    });
    await renderManager();

    // The panel resolves in the checkout the store captured (#325), not the
    // project root the session is registered under.
    expect(backendMock.getMcpServers).toHaveBeenCalledWith(CHECKOUT);
    const header = document.body.querySelector("header")?.textContent ?? "";
    expect(header).toContain(BRANCH);
    expect(header).toContain(PROJECT);
  });

  it("renders no checkout caption for a session running at the project root", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow],
      errors: [],
    } satisfies McpServersResult);
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" },
      state: pinnedState({ worktree: null }),
    });
    await renderManager();

    const header = document.body.querySelector("header")?.textContent ?? "";
    expect(header).not.toContain(BRANCH);
    expect(header).not.toContain("resolved in this session");
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
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "mcp" }, state: null });
    await renderManager();
    for (const label of ["enable denied-one", "enable off-one"]) {
      expect(switchFor(label).disabled).toBe(false);
    }
  });

  it("keeps an allowlist-force-enabled row togglable and warns that the pin clears", async () => {
    const pinnedOn: McpServerEntry = {
      ...toolRow,
      name: "forced-one",
      state: "enabled",
      enabledBy: "allowlist",
      // Tool-owned winner → core reports the disable reaches every project.
      disableReach: "global",
    };
    backendMock.getMcpServers.mockResolvedValue({
      servers: [pinnedOn, toolRow],
      errors: [],
    } satisfies McpServersResult);
    await renderManager();

    // The toggle must still control this project (#324) — omp only honours
    // the allowlist at the user level, so the disable clears it.
    const forced = switchFor("disable forced-one");
    expect(forced.disabled).toBe(false);
    expect(forced.title).toContain("clears that global override");
    // A row without the pin keeps the plain project-override wording.
    expect(switchFor("disable cursor-one").title).toBe(
      "writes a project-only override to .omp/mcp.json",
    );

    backendMock.setMcpServerEnabled.mockResolvedValue({
      servers: [
        // Shape core actually returns: the project skeleton is now the winner.
        {
          ...pinnedOn,
          state: "disabled",
          disabledBy: "config",
          enabledBy: undefined,
          disableReach: undefined,
          scope: "project",
          source: "native",
          sourcePath: "/proj/.omp/mcp.json",
          writable: true,
        },
        toolRow,
      ],
      errors: [],
    } satisfies McpServersResult);
    await act(async () => {
      forced.click();
    });
    expect(backendMock.setMcpServerEnabled).toHaveBeenCalledWith({
      projectCwd: PROJECT,
      name: "forced-one",
      sourcePath: undefined,
      enabled: false,
    });
    // The disable took effect for this project — the row comes back off, with
    // no pin left to re-enable it.
    expect(switchFor("enable forced-one").disabled).toBe(false);
  });

  it("reports the disable reach core computed for each allowlist row", async () => {
    const globalReach: McpServerEntry = {
      ...toolRow,
      name: "reach-global",
      enabledBy: "allowlist",
      disableReach: "global",
    };
    const projectReach: McpServerEntry = {
      ...toolRow,
      name: "reach-project",
      enabledBy: "allowlist",
      disableReach: "project",
    };
    backendMock.getMcpServers.mockResolvedValue({
      servers: [globalReach, projectReach],
      errors: [],
    } satisfies McpServersResult);
    await renderManager();

    // Tool-owned winner: nothing project-local can hold it, so the disable
    // clears the global override (#326).
    expect(switchFor("disable reach-global").title).toContain("source config is tool-owned");
    // Writable winner: core flips it on in its own config first, so only this
    // project turns off.
    expect(switchFor("disable reach-project").title).toContain(
      "enables it in its own config first",
    );
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

  it("offers the TUI handoff only on remote rows of a live pinned tab", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow, toolRow],
      errors: [],
    } satisfies McpServersResult);
    useStore.setState({ capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" }, state: liveState });
    await renderManager();

    const buttons = authenticateButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.closest("li")?.textContent).toContain("cursor-one");
    expect(buttons[0]!.title).toBe(
      "hand this session to omp's TUI and run /mcp reauth there — omp refuses OAuth flows over rpc",
    );
    expect(document.body.textContent).toContain(
      "OAuth servers authenticate through omp's TUI: omp refuses reauth over rpc.",
    );
  });

  it("shows auth and connection failures on matching effective rows", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [toolRow, writableRow, shadowedRow],
      errors: [],
    } satisfies McpServersResult);
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" },
      state: liveState,
      rpc: {
        [TAB]: rpcTabState({
          mcpStatus: {
            pendingServers: [],
            connectedServers: [],
            failedServers: [
              { serverName: "cursor-one", kind: "auth" },
              { serverName: "native-one", kind: "connection" },
              { serverName: "dup", kind: "connection" },
            ],
          },
        }),
      },
    });
    await renderManager();

    const cursor = [...document.body.querySelectorAll("li")]
      .find((row) => row.textContent?.includes("cursor-one"));
    const native = [...document.body.querySelectorAll("li")]
      .find((row) => row.textContent?.includes("native-one"));
    const shadowed = [...document.body.querySelectorAll("li")]
      .find((row) => row.textContent?.includes("shadowed by native"));
    expect(cursor?.textContent).toContain("authentication failed in this session");
    expect(cursor?.textContent).toContain("authenticate");
    expect(native?.textContent).toContain("connection failed in this session");
    expect(native?.textContent).not.toContain("authenticate");
    expect(shadowed?.textContent).not.toContain("connection failed in this session");
  });

  it("shows no live failure state in the global manager", async () => {
    backendMock.getMcpServers.mockResolvedValue({ servers: [toolRow], errors: [] } satisfies McpServersResult);
    useStore.setState({
      capabilitiesViewer: { scopeCwd: null, section: "mcp" },
      state: liveState,
      rpc: {
        [TAB]: rpcTabState({
          mcpStatus: {
            pendingServers: [],
            connectedServers: [],
            failedServers: [{ serverName: "cursor-one", kind: "auth" }],
          },
        }),
      },
    });
    await renderManager();
    expect(document.body.textContent).not.toContain("failed in this session");
  });

  it("stages /mcp reauth for the tab's TUI and closes the modal", async () => {
    const startTuiHandoff = vi.fn();
    backendMock.getMcpServers.mockResolvedValue({
      servers: [toolRow],
      errors: [],
    } satisfies McpServersResult);
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" },
      state: liveState,
      startTuiHandoff,
    });
    await renderManager();

    await act(async () => {
      authenticateButtons()[0]!.click();
    });
    expect(startTuiHandoff).toHaveBeenCalledWith(TAB, "/mcp reauth cursor-one");
    // The drawer takes over from here, so the modal gets out of the way.
    expect(useStore.getState().capabilitiesViewer).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("offers no handoff on stdio rows — omp's TUI has no OAuth errand for them", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow, userNativeRow],
      errors: [],
    } satisfies McpServersResult);
    useStore.setState({ capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" }, state: liveState });
    await renderManager();
    expect(authenticateButtons()).toHaveLength(0);
  });

  it("offers no handoff in the global modal — no tab to host the TUI", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [toolRow],
      errors: [],
    } satisfies McpServersResult);
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "mcp" }, state: liveState });
    await renderManager();
    expect(authenticateButtons()).toHaveLength(0);
  });

  it("offers no handoff on a live terminal tab — a pty tab has no console drawer", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [toolRow],
      errors: [],
    } satisfies McpServersResult);
    // Live, but terminal-mode: the tab is already an omp TUI, so there is no
    // ConsoleDrawer to host the handoff and the button would be a dead control.
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" },
      state: pinnedState({ mode: "pty" }),
    });
    await renderManager();
    expect(authenticateButtons()).toHaveLength(0);
  });

  it("offers no handoff on a native tab that is not live — nothing to hand off to", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [toolRow],
      errors: [],
    } satisfies McpServersResult);
    // Native, so the mode gate passes; the dormant session is what must refuse.
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp" },
      state: pinnedState({ live: "dormant" }),
    });
    await renderManager();
    expect(authenticateButtons()).toHaveLength(0);
  });
});

/* ------------------------------------------------------- live rosters */

const baseTool = (name: string, patch: Partial<CapabilityTool> = {}): CapabilityTool => ({
  name,
  description: "",
  descriptionTruncated: false,
  source: "builtin",
  sourcePath: null,
  enabled: null,
  direct: null,
  xdev: null,
  evalBridge: null,
  mcpServerName: null,
  mcpToolName: null,
  ...patch,
});

const baseSnapshot = (patch: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  version: 1,
  processKey: "pk",
  sessionId: "s1",
  revision: 1,
  updatedAt: 0,
  ompVersion: "18.1.10",
  skillCommandsEnabled: true,
  skills: { status: "available", items: [] },
  tools: { status: "available", items: [] },
  ...patch,
});

function tabButton(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`tab not found: ${label}`);
  return found;
}

async function selectTab(label: string): Promise<void> {
  await act(async () => {
    tabButton(label).click();
  });
}

async function typeSearch(value: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="Search this category"]',
  )!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CapabilitiesViewer — live sections", () => {
  it("shows the reason an unavailable section is blank, never a zero count", async () => {
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "skills" },
      state: liveState,
      rpc: {
        [TAB]: rpcTabState({
          capabilitiesLoad: "available",
          capabilities: baseSnapshot({ skills: { status: "unavailable", reason: "missing-api" } }),
        }),
      },
    });
    await renderManager();
    expect(document.body.textContent).toContain(
      "This OMP build exposes no skill inventory for the session.",
    );
    // The tab counts an unobserved roster with an em dash, never "0".
    expect(tabButton("Skills").textContent).toContain("—");
    expect(tabButton("Skills").textContent).not.toMatch(/0\b/);
  });

  it("never labels an eval-bridge-only tool as disabled", async () => {
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools" },
      state: liveState,
      rpc: {
        [TAB]: rpcTabState({
          capabilitiesLoad: "available",
          capabilities: baseSnapshot({
            tools: {
              status: "available",
              items: [
                baseTool("eval_bridge_tool", { direct: false, xdev: false, evalBridge: true }),
              ],
            },
          }),
        }),
      },
    });
    await renderManager();
    const row = [...document.body.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("eval_bridge_tool"),
    );
    expect(row?.textContent).toContain("Eval");
    expect(row?.textContent).not.toContain("not enabled");
    expect(row?.textContent).not.toContain("disabled");
  });

  it("searches tool source paths and distinguishes no-match from no-entries", async () => {
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools" },
      state: liveState,
      rpc: {
        [TAB]: rpcTabState({
          capabilitiesLoad: "available",
          capabilities: baseSnapshot({
            tools: {
              status: "available",
              items: [
                baseTool("forecast", { sourcePath: "/opt/plugins/weather.ts", enabled: true }),
                baseTool("other", { enabled: true }),
              ],
            },
          }),
        }),
      },
    });
    await renderManager();
    await typeSearch("weather");
    const rows = [...document.body.querySelectorAll("li")];
    expect(rows.some((li) => li.textContent?.includes("forecast"))).toBe(true);
    expect(rows.some((li) => li.textContent?.includes("other"))).toBe(false);
    await typeSearch("qwertz");
    expect(document.body.textContent).toContain("Nothing in this category matches the search.");
    // Entries exist; "no entries" is the wrong story here.
    expect(document.body.textContent).not.toContain("No entries in this category.");
  });

  it("drills an MCP row into the Tools tab, pinning the server and clearing filters", async () => {
    const linearEntry: McpServerEntry = { ...writableRow, name: "linear", transport: "http" };
    backendMock.getMcpServers.mockResolvedValue({ servers: [linearEntry], errors: [] } satisfies McpServersResult);
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools" },
      state: liveState,
      rpc: {
        [TAB]: rpcTabState({
          capabilitiesLoad: "available",
          capabilities: baseSnapshot({
            tools: {
              status: "available",
              items: [
                baseTool("mcp__linear__search", { source: "mcp", mcpServerName: "linear", mcpToolName: "search", enabled: true }),
                baseTool("mcp__linear__create", { source: "mcp", mcpServerName: "linear", mcpToolName: "create", enabled: true }),
              ],
            },
          }),
        }),
      },
    });
    await renderManager();

    // A stale origin filter hides the MCP tools; drill-down must clear it.
    const origin = document.body.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      origin.value = "sdk";
      origin.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Nothing in this category matches the search.");

    await selectTab("MCP servers");
    await typeSearch("linear");
    const drill = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "2 registered tools",
    );
    expect(drill).toBeDefined();
    await act(async () => {
      drill!.click();
    });
    expect(tabButton("Tools").getAttribute("aria-selected")).toBe("true");
    // The exact server is pinned and every filter that hid it is gone.
    expect(document.body.querySelector('button[aria-label="clear linear filter"]')).not.toBeNull();
    expect(document.body.querySelector<HTMLInputElement>('input[aria-label="Search this category"]')!.value).toBe("");
    const originAfter = document.body.querySelector<HTMLSelectElement>("select")!;
    expect(originAfter.value).toBe("all");
    const rows = [...document.body.querySelectorAll("li")];
    expect(rows.filter((li) => li.textContent?.includes("mcp__linear__"))).toHaveLength(2);
  });

  it("keeps the captured scopeCwd when focus moves to another tab", async () => {
    backendMock.getMcpServers.mockResolvedValue({ servers: [], errors: [] });
    useStore.setState({
      capabilitiesViewer: { scopeCwd: CHECKOUT, tabId: TAB, section: "mcp" },
      state: pinnedState({ worktree: { path: CHECKOUT, branch: BRANCH, base: "main" } }),
      activeTabId: "tab-2",
      tabs: [tabInfo({ tabId: "tab-2", projectCwd: "/elsewhere" })],
    });
    await renderManager();
    // Focus moved to a tab in /elsewhere; the open viewer still reads what it
    // captured at open time, never the newly focused tree.
    expect(backendMock.getMcpServers).toHaveBeenCalledWith(CHECKOUT);
    expect(backendMock.getMcpServers).not.toHaveBeenCalledWith("/elsewhere");
  });

  it("detaches live facts and session commands when the pinned session moved", async () => {
    backendMock.getMcpServers.mockResolvedValue({ servers: [writableRow], errors: [] } satisfies McpServersResult);
    useStore.setState({
      capabilitiesViewer: { scopeCwd: CHECKOUT, tabId: TAB, section: "mcp" },
      state: pinnedState({ worktree: { path: "/wt/elsewhere", branch: "omp/elsewhere", base: "main" } }),
      rpc: {
        [TAB]: rpcTabState({
          capabilitiesLoad: "available",
          capabilities: baseSnapshot(),
          mcpStatus: {
            pendingServers: [],
            connectedServers: [],
            failedServers: [{ serverName: "native-one", kind: "connection" }],
          },
        }),
      },
    });
    await renderManager();
    expect(document.body.textContent).toContain("moved to a different working tree");
    // Config rows are kept, live facts are not: no session failure chip, and
    // the session-mutating footer steps aside even though the tab is live.
    expect(backendMock.getMcpServers).toHaveBeenCalledWith(CHECKOUT);
    expect(document.body.textContent).not.toContain("connection failed in this session");
    expect(reloadButton()).toBeNull();
    expect(switchFor("disable native-one").disabled).toBe(false);
    // The roster is detached too.
    await selectTab("Skills");
    expect(document.body.textContent).toContain("The session moved to a different working tree");
  });

  it("explains a terminal tab and a dormant session distinctly", async () => {
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools" },
      state: liveState,
      rpc: { [TAB]: rpcTabState({ capabilitiesLoad: "terminal" }) },
    });
    await renderManager();
    expect(document.body.textContent).toContain("terminal sessions publish no capability roster");
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";

    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools" },
      state: liveState,
      rpc: { [TAB]: rpcTabState({ capabilitiesLoad: "not-live" }) },
    });
    await renderManager();
    expect(document.body.textContent).toContain("The pinned session is dormant");
  });
});
