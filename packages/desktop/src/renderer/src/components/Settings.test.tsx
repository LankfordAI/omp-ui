// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppUpdateState,
  MemoryOverview,
  OmpSettingsSnapshot,
  OmpUpdateState,
  PlanFormat,
} from "@omp-ui/core/types";
import { backendState, tabInfo } from "../test/fixtures";

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

// store.ts captures the preload bridge at module load, so install the mock
// before dynamically importing either the store or Settings.
const backendMock = {
  getState: vi.fn(),
  addProject: vi.fn(),
  browseDirectories: vi.fn(),
  removeProject: vi.fn(),
  moveProject: vi.fn(async () => {}),
  setDefaultMode: vi.fn(),
  setDefaultAgentMode: vi.fn(async () => {}),
  setPlanFormat: vi.fn(async () => {}),
  setAdvisorAutoReply: vi.fn(async () => {}),
  setDefaultAdvisor: vi.fn(async () => {}),
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
  memoryOverview: vi.fn(),
  writeOmpSetting: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

// Dynamic imports are required because store.ts captures the mocked preload bridge at module load.
const { useStore } = await import("../store");
const { Settings } = await import("./Settings");

function appUpdateState(patch: Partial<AppUpdateState>): AppUpdateState {
  return {
    status: "idle",
    currentVersion: "1.0.0",
    latestVersion: null,
    releaseUrl: "https://github.com/LankfordAI/omp-ui/releases/tag/v1.2.0",
    releaseName: null,
    format: "deb",
    progress: null,
    downloadedPath: null,
    installOnQuit: false,
    error: null,
    ...patch,
  };
}

let root: Root | null = null;

/** Async act flushes the mount-time readOmpSettings promise. */
async function renderSettings(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Settings />);
  });
}

function seed(updates: {
  appUpdate?: AppUpdateState;
  ompUpdate?: OmpUpdateState;
}): void {
  useStore.setState({
    settingsPage: "updates",
    state: null,
    tabs: [],
    activeTabId: null,
    appUpdate: updates.appUpdate ?? appUpdateState({}),
    ompUpdate: updates.ompUpdate ?? idleOmpUpdate,
  });
}

function buttonWithText(text: string): HTMLButtonElement | null {
  return (
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === text,
    ) ?? null
  );
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

afterEach(() => {
  vi.clearAllMocks();
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("Settings Updates page (issue #89)", () => {
  it("offers only the checks when no update is on the table", async () => {
    seed({});
    await renderSettings();
    expect(buttonWithText("Download")).toBeNull();
    expect(buttonWithText("Update")).toBeNull();
    expect(buttonWithText("View release")).toBeNull();
    expect(buttonWithText("Restart now")).toBeNull();
    expect(buttonWithText("Show in folder")).toBeNull();
    expect(buttonWithText("Update now")).toBeNull();
  });

  it("starts a deb/rpm/flatpak update download from the omp-ui panel", async () => {
    seed({
      appUpdate: appUpdateState({
        status: "available",
        latestVersion: "1.2.0",
        format: "deb",
      }),
    });
    await renderSettings();
    click(buttonWithText("Download")!);
    expect(backendMock.downloadAppUpdate).toHaveBeenCalledTimes(1);
  });

  it("labels the omp-ui action Update on AppImage", async () => {
    seed({
      appUpdate: appUpdateState({
        status: "available",
        latestVersion: "1.2.0",
        format: "appimage",
      }),
    });
    await renderSettings();
    expect(buttonWithText("Download")).toBeNull();
    click(buttonWithText("Update")!);
    expect(backendMock.downloadAppUpdate).toHaveBeenCalledTimes(1);
  });

  it("falls back to View release when the package format is unknown", async () => {
    seed({
      appUpdate: appUpdateState({
        status: "available",
        latestVersion: "1.2.0",
        format: "unknown",
      }),
    });
    await renderSettings();
    click(buttonWithText("View release")!);
    expect(backendMock.openAppUpdateReleaseNotes).toHaveBeenCalledTimes(1);
    expect(backendMock.downloadAppUpdate).not.toHaveBeenCalled();
  });

  it("offers Restart now once an AppImage update is downloaded", async () => {
    seed({
      appUpdate: appUpdateState({
        status: "downloaded",
        latestVersion: "1.2.0",
        format: "appimage",
      }),
    });
    await renderSettings();
    click(buttonWithText("Restart now")!);
    expect(backendMock.restartForAppUpdate).toHaveBeenCalledTimes(1);
  });

  it("offers Show in folder once an installer download finishes", async () => {
    seed({
      appUpdate: appUpdateState({
        status: "downloaded",
        latestVersion: "1.2.0",
        format: "deb",
        downloadedPath: "/downloads/omp-ui_1.2.0_amd64.deb",
      }),
    });
    await renderSettings();
    expect(buttonWithText("Restart now")).toBeNull();
    click(buttonWithText("Show in folder")!);
    expect(backendMock.showAppUpdateDownload).toHaveBeenCalledTimes(1);
  });

  it("offers Update now for an available omp update", async () => {
    seed({
      ompUpdate: {
        ...idleOmpUpdate,
        status: "available",
        installPath: "/managed/omp",
        installedVersion: "1.0.0",
        latestVersion: "1.2.0",
      },
    });
    await renderSettings();
    click(buttonWithText("Update now")!);
    expect(backendMock.downloadOmpUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("Settings General page plan format (issue #109)", () => {
  const seedGeneral = (planFormat: PlanFormat): void => {
    useStore.setState({
      settingsPage: "general",
      state: backendState({ planFormat }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  it("shows the configured format and persists a switch to markdown", async () => {
    seedGeneral("html");
    await renderSettings();
    expect(document.body.textContent).toContain("Plan format");
    expect(buttonWithText("html")!.getAttribute("aria-pressed")).toBe("true");
    expect(buttonWithText("markdown")!.getAttribute("aria-pressed")).toBe(
      "false",
    );

    click(buttonWithText("markdown")!);
    expect(backendMock.setPlanFormat).toHaveBeenCalledWith("md");
  });

  it("reflects a persisted markdown setting", async () => {
    seedGeneral("md");
    await renderSettings();
    expect(buttonWithText("markdown")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(buttonWithText("html")!.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("Settings General page default agent mode (issue #143)", () => {
  it("shows Plan by default and persists Build", async () => {
    useStore.setState({
      settingsPage: "general",
      state: backendState(),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
    await renderSettings();

    expect(buttonWithText("plan")!.getAttribute("aria-pressed")).toBe("true");
    click(buttonWithText("build")!);
    expect(backendMock.setDefaultAgentMode).toHaveBeenCalledWith("build");
  });
});

describe("Settings General page advisor auto-reply (issue #111)", () => {
  const seedAutoReply = (advisorAutoReply: boolean): void => {
    useStore.setState({
      settingsPage: "general",
      state: backendState({ advisorAutoReply }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  const autoReplySwitch = (): HTMLElement =>
    document.querySelector(
      '[role="switch"][aria-label="Advisor auto-reply"]',
    ) as HTMLElement;

  it("shows the setting on and persists switching it off", async () => {
    seedAutoReply(true);
    await renderSettings();
    expect(autoReplySwitch().getAttribute("aria-checked")).toBe("true");
    click(autoReplySwitch());
    expect(backendMock.setAdvisorAutoReply).toHaveBeenCalledWith(false);
  });

  it("reflects a persisted off setting", async () => {
    seedAutoReply(false);
    await renderSettings();
    expect(autoReplySwitch().getAttribute("aria-checked")).toBe("false");
  });
});

describe("Settings General page default advisor (issue #174)", () => {
  const seedDefaultAdvisor = (defaultAdvisor: boolean): void => {
    useStore.setState({
      settingsPage: "general",
      state: backendState({ defaultAdvisor }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  const defaultAdvisorSwitch = (): HTMLElement =>
    document.querySelector(
      '[role="switch"][aria-label="Default advisor"]',
    ) as HTMLElement;

  it("shows the setting off and persists switching it on", async () => {
    seedDefaultAdvisor(false);
    await renderSettings();
    expect(defaultAdvisorSwitch().getAttribute("aria-checked")).toBe("false");
    click(defaultAdvisorSwitch());
    expect(backendMock.setDefaultAdvisor).toHaveBeenCalledWith(true);
  });

  it("reflects a persisted on setting", async () => {
    seedDefaultAdvisor(true);
    await renderSettings();
    expect(defaultAdvisorSwitch().getAttribute("aria-checked")).toBe("true");
  });
});

describe("Settings omp Providers group (issues #178 and #179)", () => {
  const timeouts = [
    {
      key: "providers.streamFirstEventTimeoutSeconds",
      type: "number" as const,
      description: "First event timeout",
      value: -1,
      options: null,
      layer: "default" as const,
    },
    {
      key: "providers.streamIdleTimeoutSeconds",
      type: "number" as const,
      description: "Idle timeout",
      value: -1,
      options: null,
      layer: "default" as const,
    },
  ];

  function seedOmp(snapshot: OmpSettingsSnapshot): void {
    backendMock.readOmpSettings.mockResolvedValue(snapshot);
    useStore.setState({
      settingsPage: "omp",
      state: backendState(),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  }

  it("renders guidance and omp's options, then writes nitro", async () => {
    seedOmp({
      ...emptyOmpSettings,
      entries: [
        {
          key: "providers.openrouterVariant",
          type: "enum",
          description: "OpenRouter routing variant",
          value: "auto",
          options: ["auto", "nitro", "floor"],
          layer: "global",
        },
        ...timeouts,
      ],
    });
    await renderSettings();

    expect(document.body.textContent).toContain(
      "nitro variant prioritizes throughput",
    );
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="providers.openrouterVariant"]',
    )!;
    expect([...select.options].map((option) => option.value)).toEqual([
      "auto",
      "nitro",
      "floor",
    ]);
    await act(async () => {
      select.value = "nitro";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith(
      "providers.openrouterVariant",
      "nitro",
    );
  });

  it("omits the routing row when omp does not publish the key", async () => {
    seedOmp({ ...emptyOmpSettings, entries: timeouts });
    await renderSettings();
    expect(
      document.querySelector(
        'select[aria-label="providers.openrouterVariant"]',
      ),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "providers.openrouterVariant",
    );
  });

  it("offers the global MCP manager without a focused session", async () => {
    seedOmp(emptyOmpSettings);
    await renderSettings();
    const globalBtn = buttonWithText("Global MCP servers…");
    const projectBtn = buttonWithText("MCP servers…");
    expect(globalBtn).not.toBeNull();
    expect(globalBtn!.disabled).toBe(false);
    expect(projectBtn!.disabled).toBe(true);

    click(globalBtn!);
    expect(useStore.getState().mcpManager).toEqual({ projectCwd: null });
    expect(useStore.getState().settingsPage).toBeNull();
  });
});

describe("Settings Memory page (issue #213)", () => {
  const memoryEntries: OmpSettingsSnapshot["entries"] = [
    {
      key: "memory.backend",
      type: "enum",
      description: "Memory backend",
      value: "mnemopi",
      options: ["off", "mnemopi"],
      layer: "global",
    },
    {
      key: "mnemopi.scoping",
      type: "enum",
      description: "Bank scoping",
      value: "per-project-tagged",
      options: ["global", "per-project", "per-project-tagged"],
      layer: "project",
    },
    {
      key: "mnemopi.autoRecall",
      type: "boolean",
      description: "Recall automatically",
      value: true,
      options: null,
      layer: "global",
    },
    {
      key: "mnemopi.autoRetain",
      type: "boolean",
      description: "Retain automatically",
      value: true,
      options: null,
      layer: "project",
    },
    {
      key: "mnemopi.noEmbeddings",
      type: "boolean",
      description: "Disable embeddings",
      value: false,
      options: null,
      layer: "global",
    },
    {
      key: "autolearn.enabled",
      type: "boolean",
      description: "Auto-learn skills",
      value: true,
      options: null,
      layer: "project",
    },
  ];

  const overview: MemoryOverview = {
    backend: "mnemopi",
    scoping: "per-project-tagged",
    baseDir: "/home/a/.omp/memory",
    global: {
      bank: "global",
      dbPath: "/home/a/.omp/memory/global/db.sqlite",
      exists: true,
      sizeBytes: 1024,
      workingCount: 2,
      episodicCount: 3,
      lastWrite: null,
    },
    project: {
      bank: "project-abc",
      dbPath: "/home/a/.omp/memory/project-abc/db.sqlite",
      exists: false,
      sizeBytes: 0,
      workingCount: 0,
      episodicCount: 0,
      lastWrite: null,
    },
    error: null,
  };

  function seedMemory(focused = true): void {
    backendMock.readOmpSettings.mockResolvedValue({
      ...emptyOmpSettings,
      agentDir: "/home/a/.omp",
      entries: memoryEntries,
    });
    backendMock.memoryOverview.mockResolvedValue(overview);
    const tab = tabInfo();
    useStore.setState({
      settingsPage: "memory",
      state: backendState(),
      tabs: focused ? [tab] : [],
      activeTabId: focused ? tab.tabId : null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  }

  it("relocates all six controls from omp and preserves layer badges", async () => {
    seedMemory();
    await renderSettings();

    expect(buttonWithText("Memory")?.getAttribute("aria-current")).toBe("page");
    for (const entry of memoryEntries) {
      expect(document.querySelector(`[aria-label="${entry.key}"]`)).not.toBeNull();
    }
    expect(document.body.textContent).toContain("global");
    expect(document.body.textContent).toContain("project");

    click(buttonWithText("omp")!);
    for (const entry of memoryEntries) {
      expect(document.querySelector(`[aria-label="${entry.key}"]`)).toBeNull();
    }
  });

  it("shows the focused project's resolved bank paths and states", async () => {
    seedMemory();
    await renderSettings();

    expect(backendMock.memoryOverview).toHaveBeenCalledWith("/project");
    expect(document.body.textContent).toContain("mnemopi");
    expect(document.body.textContent).toContain("per-project-tagged");
    expect(document.body.textContent).toContain("/home/a/.omp/memory");
    expect(document.body.textContent).toContain("/home/a/.omp/memory/global/db.sqlite");
    expect(document.body.textContent).toContain("/home/a/.omp/memory/project-abc/db.sqlite");
    expect(document.body.textContent).toContain("exists");
    expect(document.body.textContent).toContain("not created");
  });

  it("writes through the existing path, then refreshes settings and overview", async () => {
    seedMemory();
    await renderSettings();
    const toggle = document.querySelector<HTMLElement>(
      '[role="switch"][aria-label="mnemopi.autoRecall"]',
    )!;

    await act(async () => click(toggle));

    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith(
      "mnemopi.autoRecall",
      false,
    );
    expect(backendMock.readOmpSettings).toHaveBeenCalledTimes(2);
    expect(backendMock.memoryOverview).toHaveBeenCalledTimes(2);
  });

  it("keeps controls usable without a focused tab and skips overview IPC", async () => {
    seedMemory(false);
    await renderSettings();

    expect(backendMock.memoryOverview).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Focus a session tab to inspect its resolved backend and bank locations.",
    );
    expect(
      document.querySelector('[role="switch"][aria-label="mnemopi.autoRecall"]'),
    ).not.toBeNull();
  });
});
