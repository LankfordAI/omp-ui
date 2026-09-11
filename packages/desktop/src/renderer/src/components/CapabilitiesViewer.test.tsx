// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  McpServerEntry,
  McpServersResult,
  OmpSettingsSnapshot,
  OmpUpdateState,
  ScopedCapabilitiesResult,
  SkillCatalogEntry,
} from "@omp-ui/core/types";
import type { CapabilitySnapshot, CapabilityTool } from "@omp-ui/core/capabilities";
import type { RpcTabState } from "../store";
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

/** Catalog reads: the panels' single backend verb (issue #383). */
function emptyCatalog(): ScopedCapabilitiesResult {
  return {
    skills: {
      status: "available",
      items: [],
      roots: [],
      masterEnabled: true,
      skillCommandsEnabled: true,
      note: "bundles-not-listed",
      truncated: false,
    },
    tools: { status: "available", items: [] },
    agentDir: "/home/u/.omp/agent",
    projectConfigPath: null,
    ompVersion: "18.1.10",
  };
}

/** Concrete-typed skills section; emptyCatalog().skills is a union. */
function skillsWith(
  items: SkillCatalogEntry[],
  patch: Partial<
    Omit<Extract<ScopedCapabilitiesResult["skills"], { status: "available" }>, "items" | "status">
  > = {},
) {
  return {
    status: "available" as const,
    items,
    roots: [],
    masterEnabled: true,
    skillCommandsEnabled: true,
    note: "bundles-not-listed" as const,
    truncated: false,
    ...patch,
  };
}

function catalogSkill(patch: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry {
  return {
    name: "sk",
    description: "does things",
    filePath: "/home/u/.claude/skills/sk/SKILL.md",
    origin: "claude",
    scope: "user",
    ignored: false,
    gateEnabled: true,
    gateKey: "skills.enableClaudeUser",
    hidden: null,
    disabledInFile: false,
    shadowedBy: null,
    ...patch,
  };
}

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
  retitleSession: vi.fn(),
  readPlanFile: vi.fn(),
  getBranchDiff: vi.fn(),
  getMcpServers: vi.fn(),
  setMcpServerEnabled: vi.fn(),
  getScopedCapabilities: vi.fn(async () => emptyCatalog()),
  setScopedCapability: vi.fn(async () => emptyCatalog()),
  getSessionCapabilities: vi.fn(async () => ({ status: "missing-session" as const })),
  // The viewer reaches this only through the store action; the default
  // answers like a session whose bridge cannot change tools (issue #379).
  setSessionToolEnabled: vi.fn(async () => ({ status: "bridge-unavailable" as const })),
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
  setTranscriptWidth: vi.fn(async () => {}),
  setGlassChrome: vi.fn(async () => {}),
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
  // The modal claims initial focus from a requestAnimationFrame once it is
  // mounted (ui/overlays.tsx useOverlay), so that handoff is still queued when
  // the render's promise settles. Drain the frame — the real signal, never a
  // guessed sleep — or it lands later and steals focus mid-assertion from any
  // test that tracks focus itself.
  await act(async () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame())));
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
  useStore.setState({ capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null }, state: null, rpc: {} });
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
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "mcp", instanceId: null }, state: null });
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null },
      state: pinnedState({ mode: "pty" }),
      rpc: { [TAB]: rpcTabState({ status: "running" }) },
    });
    await renderManager();
    expect(reloadButton()?.disabled).toBe(false);
  });

  it("offers no reload unless the pinned tab is live", async () => {
    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null },
      state: pinnedState({ live: "dormant" }),
    });
    await renderManager();
    expect(reloadButton()).toBeNull();
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";

    // Same opener, no loaded state → passive footer only.
    useStore.setState({ capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null }, state: null });
    await renderManager();
    expect(reloadButton()).toBeNull();
  });

  it("names the checkout a worktree session resolved in and the project it writes through to", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow],
      errors: [],
    } satisfies McpServersResult);
    useStore.setState({
      capabilitiesViewer: { scopeCwd: CHECKOUT, tabId: TAB, section: "mcp", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null },
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
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "mcp", instanceId: null }, state: null });
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
    useStore.setState({ capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null }, state: liveState });
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: null, section: "mcp", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null },
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
    useStore.setState({ capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null }, state: liveState });
    await renderManager();
    expect(authenticateButtons()).toHaveLength(0);
  });

  it("offers no handoff in the global modal — no tab to host the TUI", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [toolRow],
      errors: [],
    } satisfies McpServersResult);
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "mcp", instanceId: null }, state: liveState });
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "mcp", instanceId: null },
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
  // Tool-capable bridge by default: the roster-control cases opt out of it
  // explicitly, the way a legacy snapshot arrives with the field absent.
  toolControl: "available",
  toolMutation: null,
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "skills", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: CHECKOUT, tabId: TAB, section: "mcp", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: CHECKOUT, tabId: TAB, section: "mcp", instanceId: null },
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
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools", instanceId: null },
      state: liveState,
      rpc: { [TAB]: rpcTabState({ capabilitiesLoad: "terminal" }) },
    });
    await renderManager();
    expect(document.body.textContent).toContain("terminal sessions publish no capability roster");
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";

    useStore.setState({
      capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools", instanceId: null },
      state: liveState,
      rpc: { [TAB]: rpcTabState({ capabilitiesLoad: "not-live" }) },
    });
    await renderManager();
    expect(document.body.textContent).toContain("The pinned session is dormant");
  });
});

/* ------------------------------------------- session-local tool control */

const realSetSessionToolEnabled = useStore.getState().setSessionToolEnabled;

/** The Tools tab of one live pinned session, on whatever roster the case needs. */
function toolsTab(
  tools: CapabilityTool[],
  rpcPatch: Partial<RpcTabState> = {},
  snapshotPatch: Partial<CapabilitySnapshot> = {},
): void {
  useStore.setState({
    capabilitiesViewer: { scopeCwd: PROJECT, tabId: TAB, section: "tools", instanceId: null },
    state: liveState,
    rpc: {
      [TAB]: rpcTabState({
        capabilitiesLoad: "available",
        capabilities: baseSnapshot({ tools: { status: "available", items: tools }, ...snapshotPatch }),
        ...rpcPatch,
      }),
    },
  });
}

function toolSwitches(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('li button[role="switch"]')];
}

function statusFilter(): HTMLElement {
  const group = document.querySelector('[role="group"][aria-label="enabled state"]');
  if (group === null) throw new Error("the status filter is not rendered");
  return group as HTMLElement;
}

async function chooseStatus(option: string): Promise<void> {
  const button = [...statusFilter().querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === option,
  );
  if (button === undefined) throw new Error(`status option not rendered: ${option}`);
  await act(async () => {
    button.click();
  });
}

function rowFor(name: string): HTMLElement {
  const row = [...document.body.querySelectorAll("li")].find((li) =>
    li.textContent?.includes(name),
  );
  if (row === undefined) throw new Error(`row not rendered: ${name}`);
  return row;
}

describe("CapabilitiesViewer — Tools tab enable/disable (issue #379)", () => {
  afterEach(() => {
    useStore.setState({ setSessionToolEnabled: realSetSessionToolEnabled });
  });

  it("hands one deliberate click to the store with the exact tool and state", async () => {
    const toggle = vi.fn(async () => ({ status: "bridge-unavailable" as const }));
    useStore.setState({ setSessionToolEnabled: toggle });
    toolsTab([baseTool("bash", { enabled: true })]);
    await renderManager();

    await act(async () => {
      switchFor("Disable bash").click();
    });
    expect(toggle).toHaveBeenCalledWith(TAB, "bash", false);
  });

  it("keeps every switch out of reach while a mutation is in flight", async () => {
    toolsTab(
      [baseTool("bash", { enabled: true }), baseTool("write", { enabled: true })],
      { capabilitiesToolPending: { name: "write", enabled: false, processKey: "pk", sessionId: "s1" } },
    );
    await renderManager();

    const applying = switchFor("Applying…");
    expect(applying.disabled).toBe(true);
    // The checked state stays at the confirmed value: an attempt is not a result.
    expect(applying.getAttribute("aria-checked")).toBe("true");
    expect(switchFor("Disable bash").disabled).toBe(true);
    expect(document.body.textContent).toContain("Applying write to this session…");
  });

  it("locks the switches and says why when the bridge has no tool control", async () => {
    toolsTab([baseTool("bash", { enabled: true })], {}, { toolControl: "unsupported" });
    await renderManager();

    expect(document.body.textContent).toContain("This bridge publishes no tool control");
    expect(toolSwitches().length).toBeGreaterThan(0);
    expect(toolSwitches().every((s) => s.disabled)).toBe(true);
  });

  it("locks the switches while the session is mid-turn", async () => {
    toolsTab([baseTool("bash", { enabled: true })], { status: "running" });
    await renderManager();

    expect(document.body.textContent).toContain("mid-turn or has queued messages");
    expect(toolSwitches().every((s) => s.disabled)).toBe(true);
    // Browsing stays available: the search field and Refresh are untouched.
    expect(document.body.querySelector<HTMLInputElement>('input[aria-label="Search this category"]')!.disabled).toBe(false);
  });

  it("explains the write row's own lock without locking the other rows", async () => {
    toolsTab(
      [baseTool("write", { enabled: true }), baseTool("bash", { enabled: true })],
      { plan: { enabled: true, planFilePath: null, planAbsPath: null, approved: false } },
    );
    await renderManager();

    expect(rowFor("write").textContent).toContain(
      "Required to write plan artifacts while Plan mode is on.",
    );
    expect(switchFor("Disable write").disabled).toBe(true);
    expect(switchFor("Disable bash").disabled).toBe(false);
  });

  it("shows an unknown membership as a chip, never as an off-looking switch", async () => {
    toolsTab([baseTool("mystery", { enabled: null })]);
    await renderManager();

    const row = rowFor("mystery");
    expect(row.querySelector('[role="switch"]')).toBeNull();
    expect(row.textContent).toContain("unknown");
  });

  it("reflects the roster's membership, not the mutation record it carries", async () => {
    toolsTab(
      [baseTool("bash", { enabled: true })],
      {},
      { toolMutation: { id: "m1", name: "bash", enabled: false, status: "applied" } },
    );
    await renderManager();

    expect(switchFor("Disable bash").getAttribute("aria-checked")).toBe("true");
  });

  it("keeps a refusal on screen with its tool even when the row is filtered away", async () => {
    toolsTab([baseTool("bash", { enabled: true })], {
      capabilitiesToolFeedback: { name: "bash", enabled: false, status: "busy" },
    });
    await renderManager();
    await typeSearch("nothing-matches-this");

    expect(document.body.querySelector("li")).toBeNull();
    expect(document.body.textContent).toContain(
      "OMP was busy, so it refused the change to bash.",
    );
  });

  it("names the tool and the state a confirmed change left it in", async () => {
    toolsTab([baseTool("bash", { enabled: false })], {}, {
      toolMutation: { id: "m2", name: "bash", enabled: true, status: "applied" },
    });
    await renderManager();

    expect(document.body.textContent).toContain("bash is now enabled in this session.");
  });

  it("moves focus to the status filter when the confirmed change hides the row", async () => {
    toolsTab([baseTool("bash", { enabled: true }), baseTool("write", { enabled: true })]);
    await renderManager();
    await chooseStatus("enabled");
    const bash = switchFor("Disable bash");
    bash.focus();

    // The reader's own click, now in flight: the pending row answers to the
    // pending label while its checked state stays at the confirmed value.
    await act(async () => {
      useStore.setState({
        rpc: {
          [TAB]: rpcTabState({
            capabilitiesLoad: "available",
            capabilities: baseSnapshot({
              tools: {
                status: "available",
                items: [baseTool("bash", { enabled: true }), baseTool("write", { enabled: true })],
              },
            }),
            capabilitiesToolPending: { name: "bash", enabled: false, processKey: "pk", sessionId: "s1" },
          }),
        },
      });
    });
    expect(switchFor("Applying…").getAttribute("aria-checked")).toBe("true");

    // OMP answers with the roster in which bash is no longer enabled, so the
    // "enabled" filter has just hidden the row that held the focus.
    await act(async () => {
      useStore.setState({
        rpc: {
          [TAB]: rpcTabState({
            capabilitiesLoad: "available",
            capabilities: baseSnapshot({
              revision: 2,
              tools: {
                status: "available",
                items: [baseTool("bash", { enabled: false }), baseTool("write", { enabled: true })],
              },
              toolMutation: { id: "m1", name: "bash", enabled: false, status: "applied" },
            }),
          }),
        },
      });
    });

    expect(statusFilter().contains(document.activeElement)).toBe(true);
    expect(document.body.textContent).toContain("bash is now not enabled in this session.");
    // Nothing was cleared or widened to make that row disappear.
    expect(document.body.querySelector<HTMLInputElement>('input[aria-label="Search this category"]')!.value).toBe("");
  });

  it("keeps focus on the switch when the confirmed change leaves it visible", async () => {
    toolsTab([baseTool("bash", { enabled: false })]);
    await renderManager();
    const bash = switchFor("Enable bash");
    bash.focus();
    // A browser drops focus to the document as soon as the click disables the
    // control; jsdom never blurs a disabled element, so the drop is applied
    // here, before the pending render, to model the reader's real browser.
    bash.blur();
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      useStore.setState({
        rpc: {
          [TAB]: rpcTabState({
            capabilitiesLoad: "available",
            capabilities: baseSnapshot({
              tools: { status: "available", items: [baseTool("bash", { enabled: false })] },
            }),
            capabilitiesToolPending: { name: "bash", enabled: true, processKey: "pk", sessionId: "s1" },
          }),
        },
      });
    });

    // The click is in flight.
    await act(async () => {
      useStore.setState({
        rpc: {
          [TAB]: rpcTabState({
            capabilitiesLoad: "available",
            capabilities: baseSnapshot({
              revision: 2,
              tools: { status: "available", items: [baseTool("bash", { enabled: true })] },
              toolMutation: { id: "m1", name: "bash", enabled: true, status: "applied" },
            }),
          }),
        },
      });
    });

    expect(document.activeElement).toBe(bash);
    expect(bash.getAttribute("aria-checked")).toBe("true");
  });

  it("says what a toggle changes and what it does not", async () => {
    toolsTab([
      baseTool("grep", { enabled: true }),
      baseTool("mcp__linear__search", { source: "mcp", mcpServerName: "linear", mcpToolName: "search", enabled: true }),
    ]);
    await renderManager();

    expect(document.body.textContent).toContain(
      "Changes apply to this live session only. Restarting or switching sessions resets tool selection. OMP settings changes and MCP reload may change it again.",
    );
    expect(document.body.textContent).toContain("was never registered");
    expect(document.body.textContent).toContain(
      "Reloading MCP can re-enable its tools. Use MCP servers to change server configuration.",
    );
    // The roster's own coverage explanation is still the header's business.
    expect(document.body.textContent).toContain("not a machine-wide catalog");
  });

  it("offers no MCP note when the session registered no MCP tools", async () => {
    toolsTab([baseTool("grep", { enabled: true })]);
    await renderManager();
    expect(document.body.textContent).not.toContain("Reloading MCP can re-enable its tools");
  });
});

describe("CapabilitiesViewer — scope catalogs, unpinned (issue #383)", () => {
  it("renders catalog skills instead of the roster empty state", async () => {
    backendMock.getScopedCapabilities.mockResolvedValue({
      ...emptyCatalog(),
      skills: skillsWith([
          catalogSkill({ name: "deploy-app" }),
          catalogSkill({
            name: "shadowed-one",
            filePath: "/p/.omp/skills/shadowed-one/SKILL.md",
            origin: "pi",
            scope: "project",
            shadowedBy: "claude:/home/u/.claude/skills/shadowed-one",
          }),
          catalogSkill({
            name: "gate-off",
            filePath: "/home/u/.codex/skills/gate-off/SKILL.md",
            origin: "codex",
            gateEnabled: false,
            gateKey: "skills.enableCodexUser",
          }),
      ]),
    });
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "skills", instanceId: null }, state: null, rpc: {} });
    await renderManager();

    expect(backendMock.getScopedCapabilities).toHaveBeenCalledWith(null);
    const body = document.body.textContent ?? "";
    expect(body).toContain("deploy-app");
    expect(body).toContain("shadowed by claude");
    expect(body).toContain("root disabled");
    // The headline lie this issue removes: catalogs never defer to a session.
    expect(body).not.toContain("require a live native session");
    // Catalog coverage copy, not roster copy.
    expect(body).toContain("what omp can load");
  });

  it("routes a global tool switch to the global layer", async () => {
    const disabledResult = {
      ...emptyCatalog(),
      tools: {
        status: "available" as const,
        items: [{ tool: "web_search", key: "web_search.enabled", enabled: false, layer: "global" as const }],
      },
    };
    backendMock.getScopedCapabilities.mockResolvedValue({
      ...emptyCatalog(),
      tools: {
        status: "available",
        items: [{ tool: "web_search", key: "web_search.enabled", enabled: true, layer: "default" as const }],
      },
    });
    backendMock.setScopedCapability.mockResolvedValue(disabledResult);
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "tools", instanceId: null }, state: null, rpc: {} });
    await renderManager();

    await act(async () => {
      switchFor("Disable web_search").click();
    });
    expect(backendMock.setScopedCapability).toHaveBeenCalledWith({
      scopeCwd: null,
      kind: "tool",
      tool: "web_search",
      enabled: false,
    });
    // The rows rest from the write's returned catalog.
    expect(document.body.textContent).toContain("web_search.enabled");
  });

  it("writes an ignore toggle as skill-ignore at the panel's scope", async () => {
    backendMock.getScopedCapabilities.mockResolvedValue({
      ...emptyCatalog(),
      skills: skillsWith([catalogSkill({ name: "noisy" })]),
    });
    backendMock.setScopedCapability.mockResolvedValue({
      ...emptyCatalog(),
      skills: skillsWith([catalogSkill({ name: "noisy", ignored: true })]),
    });
    useStore.setState({ capabilitiesViewer: { scopeCwd: PROJECT, section: "skills", instanceId: null }, state: null, rpc: {} });
    await renderManager();

    await act(async () => {
      switchFor("Ignore noisy").click();
    });
    expect(backendMock.setScopedCapability).toHaveBeenCalledWith({
      scopeCwd: PROJECT,
      kind: "skill-ignore",
      name: "noisy",
      ignored: true,
    });
    expect(document.body.textContent).toContain("ignored");
  });

  it("offers the gate switch when a root's gate is off", async () => {
    backendMock.getScopedCapabilities.mockResolvedValue({
      ...emptyCatalog(),
      skills: skillsWith([catalogSkill({ name: "gated", gateEnabled: false })]),
    });
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "skills", instanceId: null }, state: null, rpc: {} });
    await renderManager();

    const gateSwitch = switchFor("Enable the root behind gated");
    expect(gateSwitch.getAttribute("title")).toContain("skills.enableClaudeUser");
    await act(async () => {
      gateSwitch.click();
    });
    expect(backendMock.setScopedCapability).toHaveBeenCalledWith({
      scopeCwd: null,
      kind: "skill-gate",
      key: "skills.enableClaudeUser",
      enabled: true,
    });
  });

  it("locks every switch and names the master gate when skills.enabled is off", async () => {
    backendMock.getScopedCapabilities.mockResolvedValue({
      ...emptyCatalog(),
      skills: skillsWith([catalogSkill({ name: "listed-anyway" })], {
        masterEnabled: false,
      }),
    });
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "skills", instanceId: null }, state: null, rpc: {} });
    await renderManager();

    expect(document.body.textContent).toContain("skills.enabled is off");
    expect(document.body.textContent).toContain("listed-anyway");
    expect(switchFor("Ignore listed-anyway").disabled).toBe(true);
    expect(backendMock.setScopedCapability).not.toHaveBeenCalled();
  });

  it("keeps the rows and shows the message when a catalog write fails", async () => {
    backendMock.getScopedCapabilities.mockResolvedValue({
      ...emptyCatalog(),
      tools: {
        status: "available",
        items: [{ tool: "todo", key: "todo.enabled", enabled: true, layer: "global" as const }],
      },
    });
    backendMock.setScopedCapability.mockRejectedValue(new Error("Invalid value: nope"));
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "tools", instanceId: null }, state: null, rpc: {} });
    await renderManager();

    await act(async () => {
      switchFor("Disable todo").click();
    });
    expect(document.body.textContent).toContain("Invalid value: nope");
    // No optimistic flip: the row still reports the last read state.
    expect(document.body.textContent).toContain("todo.enabled");
  });

  it("surfaces a per-section settings error with omp's message", async () => {
    backendMock.getScopedCapabilities.mockResolvedValue({
      ...emptyCatalog(),
      skills: { status: "error", message: "omp binary not found" },
      tools: { status: "error", message: "omp binary not found" },
    });
    useStore.setState({ capabilitiesViewer: { scopeCwd: null, section: "skills", instanceId: null }, state: null, rpc: {} });
    await renderManager();

    expect(document.body.textContent).toContain("Could not read the configuration at this scope");
    expect(document.body.textContent).toContain("omp binary not found");
  });
});
