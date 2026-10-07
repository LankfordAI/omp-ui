// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppUpdateState,
  JudgeModelSnapshot,
  MemoryOverview,
  OmpSettingValue,
  OmpSettingsSnapshot,
  OmpUpdateState,
  PlanFormat,
  ProjectScalarResult,
  ProviderKeyStatus,
  ProviderOAuthState,
  ProviderOAuthStatus,
  ProviderSignOutResult,
  RemoteState,
  WebSearchProviderSnapshot,
} from "@omp-ui/core/types";
import { backendState, tabInfo } from "../test/fixtures";
import type { SettingsPage } from "../store";
import { applyLocale, resolveLocale, t } from "../lib/i18n";

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

/** The Providers page's discovery answer when there is no omp binary. */
const emptyWebSearchProviders: WebSearchProviderSnapshot = {
  providers: [],
  discovered: false,
  error: "omp binary not found",
};

const idleRemote: RemoteState = {
  status: "stopped",
  enabled: false,
  bind: "localhost",
  port: 4677,
  token: "t",
  hasPassword: false,
  urls: [],
  tokenUrls: [],
  webBundleMissing: false,
  error: null,
};

const idleProviderOAuth: ProviderOAuthState = {
  providerId: null,
  phase: "idle",
  url: null,
  instructions: null,
  prompt: null,
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
  listCompactionMethods: vi.fn(async () => ["remote", "soft"]),
  setDefaultCompactionMethod: vi.fn(async () => {}),
  setPlanFormat: vi.fn(async () => {}),
  setHibernateIdleMinutes: vi.fn(async () => {}),
  setStreamStallAbortSeconds: vi.fn(async () => {}),
  setAdvisorAutoReply: vi.fn(async () => {}),
  setStallAutoContinue: vi.fn(async () => {}),
  setDesktopNotifications: vi.fn(async () => {}),
  setDefaultAdvisor: vi.fn(async () => {}),
  setDefaultAutoThinking: vi.fn(async () => {}),
  setSkipDeleteConfirmation: vi.fn(),
  setExperimentsEnabled: vi.fn(async () => {}),
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
  setFontFamilyId: vi.fn(async () => {}),
  setTranscriptWidth: vi.fn(async () => {}),
  setGlassChrome: vi.fn(async () => {}),
  setLocaleId: vi.fn(async () => {}),
  setAppUpdateCheckOnLaunch: vi.fn(async () => {}),
  setAppUpdateTrain: vi.fn(async () => {}),
  setOmpUpdateCheckOnLaunch: vi.fn(async () => {}),
  clearDismissedAppUpdate: vi.fn(async () => {}),
  clearDismissedOmpUpdate: vi.fn(async () => {}),
  setWindowChrome: vi.fn(async () => {}),
  readOmpSettings: vi.fn(async () => emptyOmpSettings),
  readProviderKeys: vi.fn(
    async (): Promise<{
      providers: ProviderKeyStatus[];
      encryptionAvailable: boolean;
      backend: string;
    }> => ({
      providers: [],
      encryptionAvailable: false,
      backend: "none",
    }),
  ),
  readWebSearchProviders: vi.fn(async () => emptyWebSearchProviders),
  readSttModels: vi.fn(async () => ({ models: [], discovered: true, error: null })),
  readJudgeModels: vi.fn(async (): Promise<JudgeModelSnapshot> => ({
    models: [],
    discovered: true,
    error: null,
  })),
  setVoiceInputEnabled: vi.fn(async () => {}),
  setSttModel: vi.fn(async () => {}),
  memoryOverview: vi.fn(),
  detectVaults: vi.fn(async () => ({
    obsidianListFile: null,
    obsidianList: [],
    cliRegistered: false,
    uriHandler: false,
    rows: {},
  })),
  writeOmpSetting: vi.fn(async () => {}),
  getProjectSubagentModels: vi.fn(async () => ({ map: {}, layer: { shape: "absent" as const } })),
  setProjectSubagentModel: vi.fn(async () => {}),
  getProjectMaxConcurrency: vi.fn(
    async (): Promise<ProjectScalarResult> => ({ value: undefined, layer: { shape: "absent" } }),
  ),
  setProjectMaxConcurrency: vi.fn(async () => {}),
  setSessionSubagentModels: vi.fn(async () => {}),
  setSessionApprovalMode: vi.fn(async () => {}),
  getProjectApprovalMode: vi.fn(
    async (): Promise<ProjectScalarResult> => ({ value: undefined, layer: { shape: "absent" } }),
  ),
  setProjectApprovalMode: vi.fn(async () => {}),
  refreshAgentRoster: vi.fn(async () => []),
  setSubagentModelInheritByDefault: vi.fn(async () => {}),
  getRemoteState: vi.fn(async () => idleRemote),
  setRemoteEnabled: vi.fn(async () => {}),
  setRemoteBind: vi.fn(async () => {}),
  setRemotePort: vi.fn(async () => {}),
  regenerateRemoteToken: vi.fn(async () => {}),
  setRemotePassword: vi.fn(async () => {}),
  clearRemotePassword: vi.fn(async () => {}),
  onRemoteState: vi.fn(),
  getProviderOAuthState: vi.fn(async () => idleProviderOAuth),
  onProviderOAuthState: vi.fn(),
  readProviderOAuth: vi.fn(async (): Promise<ProviderOAuthStatus[]> => []),
  startProviderOAuth: vi.fn(async () => {}),
  submitProviderOAuthInput: vi.fn(async () => {}),
  cancelProviderOAuth: vi.fn(async () => {}),
  signOutProviderOAuth: vi.fn(async (): Promise<ProviderSignOutResult> => ({ rows: [], remainingSource: null })),
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
  // Locale state is module-global; every test starts from the default.
  applyLocale(resolveLocale("en"));
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("Settings dialog semantics", () => {
  it("renders one dialog labelled by the Settings heading", async () => {
    seed({});
    await renderSettings();
    const dialogs = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.getAttribute("aria-labelledby")).toBe("settings-title");
  });
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

  it("reflects the update train and persists a switch to nightly", async () => {
    seed({});
    useStore.setState({ state: backendState({ appUpdateTrain: "stable" }) });
    await renderSettings();
    expect(buttonWithText("stable")!.getAttribute("aria-pressed")).toBe("true");
    click(buttonWithText("nightly")!);
    expect(backendMock.setAppUpdateTrain).toHaveBeenCalledWith("nightly");
  });

  it("reflects a persisted nightly train", async () => {
    seed({});
    useStore.setState({ state: backendState({ appUpdateTrain: "nightly" }) });
    await renderSettings();
    expect(buttonWithText("nightly")!.getAttribute("aria-pressed")).toBe("true");
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

  it.each(["appimage", "maczip"] as const)(
    "labels the omp-ui action Update on %s",
    async (format) => {
      seed({
        appUpdate: appUpdateState({
          status: "available",
          latestVersion: "1.2.0",
          format,
        }),
      });
      await renderSettings();
      expect(buttonWithText("Download")).toBeNull();
      click(buttonWithText("Update")!);
      expect(backendMock.downloadAppUpdate).toHaveBeenCalledTimes(1);
    },
  );

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

  it("offers Restart now once a macOS zip update is downloaded", async () => {
    seed({
      appUpdate: appUpdateState({
        status: "downloaded",
        latestVersion: "1.2.0",
        format: "maczip",
      }),
    });
    await renderSettings();
    click(buttonWithText("Restart now")!);
    expect(backendMock.restartForAppUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows an applying macOS update without actions and disables checks", async () => {
    seed({
      appUpdate: appUpdateState({
        status: "installing",
        latestVersion: "1.2.0",
        format: "maczip",
      }),
    });
    await renderSettings();

    expect(document.body.textContent).toContain("applying 1.2.0…");
    expect(buttonWithText("Restart now")).toBeNull();
    expect(buttonWithText("Install when I quit")).toBeNull();
    expect(buttonWithText("Check now")?.disabled).toBe(true);
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

describe("Settings General page hibernate idle sessions (issue #246)", () => {
  const seedGeneral = (hibernateIdleMinutes: number): void => {
    useStore.setState({
      settingsPage: "general",
      state: backendState({ hibernateIdleMinutes }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  it("shows the persisted window and persists a change", async () => {
    seedGeneral(30);
    await renderSettings();
    expect(document.body.textContent).toContain("Hibernate idle sessions");
    expect(document.body.textContent).toContain("each project's most recently active session");
    expect(buttonWithText("30 min")!.getAttribute("aria-pressed")).toBe("true");
    expect(buttonWithText("1 hour")!.getAttribute("aria-pressed")).toBe("false");

    click(buttonWithText("1 hour")!);
    expect(backendMock.setHibernateIdleMinutes).toHaveBeenCalledWith(60);
  });

  it("reflects a persisted off setting", async () => {
    seedGeneral(0);
    await renderSettings();
    expect(buttonWithText("off")!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Settings General page stream-stall watchdog (issue #248)", () => {
  const seedGeneral = (streamStallAbortSeconds: number): void => {
    useStore.setState({
      settingsPage: "general",
      state: backendState({ streamStallAbortSeconds }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  it("shows the persisted window and persists a change", async () => {
    seedGeneral(180);
    await renderSettings();
    expect(document.body.textContent).toContain("Stream-stall watchdog");
    expect(buttonWithText("3 min")!.getAttribute("aria-pressed")).toBe("true");
    expect(buttonWithText("5 min")!.getAttribute("aria-pressed")).toBe("false");

    click(buttonWithText("5 min")!);
    expect(backendMock.setStreamStallAbortSeconds).toHaveBeenCalledWith(300);
  });

  it("reflects a persisted off setting", async () => {
    seedGeneral(0);
    await renderSettings();
    // Both this row and "Hibernate idle sessions" offer "off" — scope to the watchdog's group.
    const pressed = [
      ...document.querySelectorAll('[aria-label="stall watchdog"] [aria-pressed]'),
    ].find((b) => b.textContent === "off");
    expect(pressed?.getAttribute("aria-pressed")).toBe("true");
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

describe("Settings General page default compaction method (issue #275)", () => {
  const pickerButtons = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[role="group"][aria-label="default compaction method"] button',
    ),
  ];
  const labelOf = (button: HTMLButtonElement): string =>
    (button.children[0] as HTMLElement).textContent ?? "";

  it("lists every installed method with its description and persists selection and clear", async () => {
    backendMock.listCompactionMethods.mockResolvedValueOnce(["soft", "remote", "future"]);
    useStore.setState({
      settingsPage: "general",
      state: backendState({ defaultCompactionMethod: "soft" }),
      compactionMethods: { status: "unloaded" },
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
    await renderSettings();
    expect(pickerButtons().map(labelOf)).toEqual([
      "omp configured default",
      "Soft compaction",
      "OpenAI server compaction",
      "future",
    ]);
    // The persisted method is pressed; the unknown id "future" got the raw
    // label and no invented description (one child instead of two).
    expect(pickerButtons()[1].getAttribute("aria-pressed")).toBe("true");
    expect(pickerButtons()[3].children).toHaveLength(1);
    expect(document.body.textContent).toContain(
      "Summarize in place with a compaction model without using server compaction",
    );
    expect(document.body.textContent).toContain(
      "Use provider-native OpenAI-compatible server compaction when the active route supports it",
    );
    click(pickerButtons()[0]);
    expect(backendMock.setDefaultCompactionMethod).toHaveBeenCalledWith(null);
    // Mirror what the real backend round-trip does, then pick another method.
    useStore.setState((s) => ({ state: { ...s.state!, defaultCompactionMethod: null } }));
    click(pickerButtons()[2]);
    expect(backendMock.setDefaultCompactionMethod).toHaveBeenCalledWith("remote");
  });

  it("shows an unavailable persisted value as a disabled, pressed row", async () => {
    useStore.setState({
      settingsPage: "general",
      state: backendState({ defaultCompactionMethod: "removed" }),
      compactionMethods: { status: "loaded", methods: ["remote"] },
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
    await renderSettings();
    const unavailable = pickerButtons().find((button) =>
      labelOf(button).includes("removed (unavailable)"),
    )!;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the omp configured default selectable when the method read fails", async () => {
    backendMock.listCompactionMethods.mockRejectedValueOnce(new Error("omp binary not found"));
    useStore.setState({
      settingsPage: "general",
      state: backendState({ defaultCompactionMethod: "soft" }),
      compactionMethods: { status: "unloaded" },
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
    await renderSettings();
    expect(pickerButtons()).toHaveLength(1);
    expect(labelOf(pickerButtons()[0])).toBe("omp configured default");
    expect(document.body.textContent).toContain("Methods unavailable: omp binary not found");
    click(pickerButtons()[0]);
    expect(backendMock.setDefaultCompactionMethod).toHaveBeenCalledWith(null);
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

describe("Settings General page stall auto-continue (issue #251)", () => {
  const seedAutoContinue = (stallAutoContinue: boolean): void => {
    useStore.setState({
      settingsPage: "general",
      state: backendState({ stallAutoContinue }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  const autoContinueSwitch = (): HTMLElement =>
    document.querySelector(
      '[role="switch"][aria-label="Stall auto-continue"]',
    ) as HTMLElement;

  it("shows the setting on and persists switching it off", async () => {
    seedAutoContinue(true);
    await renderSettings();
    expect(autoContinueSwitch().getAttribute("aria-checked")).toBe("true");
    click(autoContinueSwitch());
    expect(backendMock.setStallAutoContinue).toHaveBeenCalledWith(false);
  });

  it("reflects a persisted off setting", async () => {
    seedAutoContinue(false);
    await renderSettings();
    expect(autoContinueSwitch().getAttribute("aria-checked")).toBe("false");
  });
});

describe("Settings General page desktop notifications (issue #271)", () => {
  const seedNotifications = (desktopNotifications: boolean): void => {
    useStore.setState({
      settingsPage: "general",
      state: backendState({ desktopNotifications }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  const notificationsSwitch = (): HTMLElement =>
    document.querySelector(
      '[role="switch"][aria-label="Desktop notifications"]',
    ) as HTMLElement;

  it("shows the setting on and persists switching it off", async () => {
    seedNotifications(true);
    await renderSettings();
    expect(notificationsSwitch().getAttribute("aria-checked")).toBe("true");
    click(notificationsSwitch());
    expect(backendMock.setDesktopNotifications).toHaveBeenCalledWith(false);
  });

  it("reflects a persisted off setting", async () => {
    seedNotifications(false);
    await renderSettings();
    expect(notificationsSwitch().getAttribute("aria-checked")).toBe("false");
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

describe("Settings General page default auto thinking (issue #743)", () => {
  const seedAutoThinking = (defaultAutoThinking: boolean): void => {
    useStore.setState({
      settingsPage: "general",
      state: backendState({ defaultAutoThinking }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  const autoThinkingSwitch = (): HTMLElement =>
    document.querySelector(
      '[role="switch"][aria-label="Default auto thinking"]',
    ) as HTMLElement;

  it("shows the setting off and persists switching it on", async () => {
    seedAutoThinking(false);
    await renderSettings();
    expect(autoThinkingSwitch().getAttribute("aria-checked")).toBe("false");
    click(autoThinkingSwitch());
    expect(backendMock.setDefaultAutoThinking).toHaveBeenCalledWith(true);
  });

  it("reflects a persisted on setting and persists switching it off", async () => {
    seedAutoThinking(true);
    await renderSettings();
    expect(autoThinkingSwitch().getAttribute("aria-checked")).toBe("true");
    click(autoThinkingSwitch());
    expect(backendMock.setDefaultAutoThinking).toHaveBeenCalledWith(false);
  });
});
describe("Settings Experimental page (issues #571 and #739)", () => {
  const seedExperimental = (): void => {
    useStore.setState({
      settingsPage: "experimental",
      state: backendState(),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  const labSwitch = (): HTMLElement =>
    document.querySelector(
      '[role="switch"][aria-label="Experiments lab (beta)"]',
    ) as HTMLElement;

  it("lists Experimental in the nav", async () => {
    seedExperimental();
    await renderSettings();
    expect(buttonWithText("Experimental")).not.toBeNull();
  });

  it("shows the switch off and persists switching it on", async () => {
    seedExperimental();
    await renderSettings();
    expect(document.body.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(labSwitch().getAttribute("aria-checked")).toBe("false");
    click(labSwitch());
    expect(backendMock.setExperimentsEnabled).toHaveBeenCalledWith(true);
  });

  it("no longer renders the switch on the General page", async () => {
    useStore.setState({
      settingsPage: "general",
      state: backendState(),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
    await renderSettings();
    expect(labSwitch()).toBeNull();
  });
});

describe("Settings omp Providers group (issues #178 and #179)", () => {
  const timeouts = [
    {
      key: "providers.streamFirstEventTimeoutSeconds",
      type: "number" as const,
      description: "First event timeout",
      value: -1,
      globalValue: undefined,
      options: null,
      layer: "default" as const,
    },
    {
      key: "providers.streamIdleTimeoutSeconds",
      type: "number" as const,
      description: "Idle timeout",
      value: -1,
      globalValue: undefined,
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
          globalValue: undefined,
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

  it("opens the global capabilities viewer without a focused session", async () => {
    seedOmp(emptyOmpSettings);
    await renderSettings();
    const globalBtn = buttonWithText("Global MCP servers…");
    const projectBtn = buttonWithText("Session capabilities");
    expect(globalBtn).not.toBeNull();
    expect(globalBtn!.disabled).toBe(false);
    expect(projectBtn!.disabled).toBe(true);

    click(globalBtn!);
    const viewer = useStore.getState().capabilitiesViewer;
    expect(viewer?.scopeCwd).toBeNull();
    expect(viewer?.section).toBe("mcp");
    expect(useStore.getState().settingsPage).toBeNull();
  });
});

describe("Settings omp Python section (issue #671)", () => {
  const pythonEntries = (): OmpSettingsSnapshot["entries"] => [
    {
      key: "python.interpreter",
      type: "string",
      description: "Optional path to an exact Python executable.",
      value: "",
      globalValue: undefined,
      options: null,
      layer: "default",
    },
    {
      key: "python.kernelMode",
      type: "enum",
      description: "Keep the IPython kernel alive across eval calls or start fresh each time",
      value: "session",
      globalValue: undefined,
      options: ["session", "per-call"],
      layer: "global",
    },
  ];

  function seedPython(entries: OmpSettingsSnapshot["entries"]): void {
    backendMock.readOmpSettings.mockResolvedValue({ ...emptyOmpSettings, entries });
    useStore.setState({
      settingsPage: "omp",
      state: backendState(),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  }

  async function commitInterpreter(value: string): Promise<void> {
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="python.interpreter"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
  }

  it("renders the section, writes kernelMode, and commits an interpreter path", async () => {
    seedPython(pythonEntries());
    await renderSettings();

    expect(document.body.textContent).toContain("Python");
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="python.kernelMode"]',
    )!;
    expect([...select.options].map((option) => option.value)).toEqual(["session", "per-call"]);
    await act(async () => {
      select.value = "per-call";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("python.kernelMode", "per-call");

    await commitInterpreter("/usr/bin/python3");
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith(
      "python.interpreter",
      "/usr/bin/python3",
    );
  });

  it("clearing the interpreter commits the auto-detect sentinel", async () => {
    seedPython([
      {
        ...pythonEntries()[0]!,
        value: "/opt/py",
        globalValue: "/opt/py",
        layer: "global" as const,
      },
      pythonEntries()[1]!,
    ]);
    await renderSettings();
    await commitInterpreter("");
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("python.interpreter", "");
  });

  it("renders no Python rows on an omp that predates the keys", async () => {
    seedPython([]);
    await renderSettings();
    expect(
      document.querySelector('input[aria-label="python.interpreter"]'),
    ).toBeNull();
    expect(
      document.querySelector('select[aria-label="python.kernelMode"]'),
    ).toBeNull();
  });
});

describe("Settings Memory page (issue #213)", () => {
  const memoryEntries: OmpSettingsSnapshot["entries"] = [
    {
      key: "memory.backend",
      type: "enum",
      description: "Memory backend",
      value: "mnemopi",
      globalValue: undefined,
      options: ["off", "mnemopi"],
      layer: "global",
    },
    {
      key: "mnemopi.scoping",
      type: "enum",
      description: "Bank scoping",
      value: "per-project-tagged",
      globalValue: undefined,
      options: ["global", "per-project", "per-project-tagged"],
      layer: "project",
    },
    {
      key: "mnemopi.autoRecall",
      type: "boolean",
      description: "Recall automatically",
      value: true,
      globalValue: undefined,
      options: null,
      layer: "global",
    },
    {
      key: "mnemopi.autoRetain",
      type: "boolean",
      description: "Retain automatically",
      value: true,
      globalValue: undefined,
      options: null,
      layer: "project",
    },
    {
      key: "mnemopi.noEmbeddings",
      type: "boolean",
      description: "Disable embeddings",
      value: false,
      globalValue: undefined,
      options: null,
      layer: "global",
    },
    {
      key: "autolearn.enabled",
      type: "boolean",
      description: "Auto-learn skills",
      value: true,
      globalValue: undefined,
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

describe("Settings Remote page password row", () => {
  function seedRemote(patch: Partial<RemoteState>): void {
    useStore.setState({
      settingsPage: "remote",
      state: null,
      tabs: [],
      activeTabId: null,
      remote: {
        ...idleRemote,
        enabled: true,
        status: "listening",
        urls: ["http://127.0.0.1:4677/"],
        tokenUrls: ["http://127.0.0.1:4677/?t=t"],
        port: 4677,
        ...patch,
      },
    });
  }

  function passwordInput(): HTMLInputElement {
    const input = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="remote access password"]',
    );
    expect(input).not.toBeNull();
    return input!;
  }

  async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("saves a typed password with Enter", async () => {
    seedRemote({ hasPassword: false });
    await renderSettings();

    click(buttonWithText("Set password")!);
    await typeInto(passwordInput(), "correct-horse-battery");
    await act(async () => {
      passwordInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(backendMock.setRemotePassword).toHaveBeenCalledTimes(1);
    expect(backendMock.setRemotePassword).toHaveBeenCalledWith("correct-horse-battery");
  });

  it("clears the password when asked", async () => {
    seedRemote({ hasPassword: true });
    await renderSettings();

    expect(document.body.textContent).toContain("password set");
    click(buttonWithText("Clear")!);
    await act(async () => {});

    expect(backendMock.clearRemotePassword).toHaveBeenCalledTimes(1);
  });
});
describe("Settings page footer dispatch (issue #300)", () => {
  const cases: ReadonlyArray<{ page: SettingsPage; marker: string | null }> = [
    { page: "general", marker: "Default session and agent modes apply to new sessions" },
    { page: "appearance", marker: null },
    { page: "updates", marker: "Downloads always need a click." },
    { page: "remote", marker: "Changing anything here restarts only the server" },
    { page: "remote-instances", marker: "A joined instance grants this app full control" },
    { page: "providers", marker: "omp reads credentials from the environment" },
    { page: "memory", marker: "Memory configuration applies to sessions started after the change" },
    { page: "knowledge-vault", marker: null },
    { page: "omp", marker: "omp binds model roles and the advisor at process start" },
    { page: "experimental", marker: "Applies to sessions started afterwards" },
    { page: "about", marker: null },
  ];
  for (const { page, marker } of cases) {
    it(`${page} renders its own footer`, async () => {
      useStore.setState({
        settingsPage: page,
        state: backendState(),
        tabs: [],
        activeTabId: null,
      });
      await renderSettings();
      const footer = document.body.querySelector("footer");
      if (marker === null) expect(footer).toBeNull();
      else expect(footer?.textContent).toContain(marker);
    });
  }

  it("remote footer copy comes from the catalog, mono origin token intact (issue #581)", async () => {
    useStore.setState({ settingsPage: "remote", state: backendState(), tabs: [], activeTabId: null });
    applyLocale(resolveLocale("ko"));
    await renderSettings();
    const footer = document.body.querySelector("footer")?.textContent ?? "";
    expect(footer).toContain(t("settings.remote.footerRestart"));
    expect(footer).not.toContain("Changing anything here restarts only the server");
    // \x3c and \x3e are the angle brackets: the mono origin token must survive the fragment split.
    expect(footer).toMatch(/http:\/\/\x3clan-ip\x3e/);
  });

  it("advanced lists in the nav and offers the bundle export (issue #413)", async () => {
    useStore.setState({
      settingsPage: "advanced",
      state: backendState(),
      tabs: [],
      activeTabId: null,
      diagnosticsDialogOpen: false,
    });
    await renderSettings();
    const navText = document.querySelector("nav")?.textContent ?? "";
    expect(navText).toContain("Advanced");
    expect(document.body.textContent).toContain("Diagnostic bundle");
    const action = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Export diagnostic bundle"),
    )!;
    click(action);
    await act(async () => {});
    expect(useStore.getState().diagnosticsDialogOpen).toBe(true);
  });
});

describe("Settings Appearance page font family (issue #315)", () => {
  const seedAppearance = (fontFamilyId: string): void => {
    useStore.setState({
      settingsPage: "appearance",
      state: backendState({ fontFamilyId }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  const fontCard = (id: string): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>(
      `button[aria-label="${id} font family"]`,
    )!;

  it("shows the persisted family and persists a switch to Ubuntu", async () => {
    seedAppearance("default");
    await renderSettings();
    expect(document.body.textContent).toContain("Font family");
    expect(fontCard("Default").getAttribute("aria-pressed")).toBe("true");
    expect(fontCard("Ubuntu").getAttribute("aria-pressed")).toBe("false");

    click(fontCard("Ubuntu"));
    expect(backendMock.setFontFamilyId).toHaveBeenCalledWith("ubuntu");
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toContain("Ubuntu");
    expect(document.documentElement.style.getPropertyValue("--font-mono")).toContain("Ubuntu Mono");
  });

  it("reflects a persisted ubuntu setting", async () => {
    seedAppearance("ubuntu");
    await renderSettings();
    expect(fontCard("Ubuntu").getAttribute("aria-pressed")).toBe("true");
    expect(fontCard("Default").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("Settings General page language row (issues #363, #367)", () => {
  const seedGeneral = (localeId: string): void => {
    useStore.setState({
      settingsPage: "general",
      state: backendState({ localeId }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  it("shows the persisted locale and persists a switch to Korean", async () => {
    seedGeneral("en");
    await renderSettings();
    expect(document.body.textContent).toContain("Language");
    expect(document.body.textContent).toContain(
      "The language of the application chrome. Session content and terminal output are never translated.",
    );
    expect(buttonWithText("English")!.getAttribute("aria-pressed")).toBe("true");
    expect(buttonWithText("한국어")!.getAttribute("aria-pressed")).toBe("false");

    click(buttonWithText("한국어")!);
    expect(backendMock.setLocaleId).toHaveBeenCalledWith("ko");
    expect(document.getElementById("settings-title")?.textContent).toBe("설정");
    expect(buttonWithText("일반")).not.toBeNull();
    expect(buttonWithText("General")).toBeNull();
    expect(buttonWithText("네이티브")).not.toBeNull();
    expect(buttonWithText("터미널")).not.toBeNull();
    expect(buttonWithText("플랜")).not.toBeNull();
    expect(buttonWithText("빌드")).not.toBeNull();
  });

  it("reflects a persisted Korean setting", async () => {
    seedGeneral("ko");
    applyLocale(resolveLocale("ko"));
    await renderSettings();
    expect(buttonWithText("한국어")!.getAttribute("aria-pressed")).toBe("true");
    expect(buttonWithText("English")!.getAttribute("aria-pressed")).toBe("false");
    expect(document.getElementById("settings-title")?.textContent).toBe("설정");
    expect(buttonWithText("모양")).not.toBeNull();
  });
});

describe("Settings Providers page subscriptions (issue #368)", () => {
  const keyRow: ProviderKeyStatus = {
    id: "openrouter",
    label: "OpenRouter",
    group: "models",
    env: "OPENROUTER_API_KEY",
    activeEnv: "OPENROUTER_API_KEY",
    source: "none",
    masked: null,
    hint: null,
    shadowsEnvironment: false,
    unreadableStoredEnvs: [],
  };

  const seedProviders = (
    rows: ProviderOAuthStatus[],
    keyRows: ProviderKeyStatus[] = [keyRow],
  ): void => {
    backendMock.readProviderOAuth.mockResolvedValueOnce(rows);
    backendMock.readProviderKeys.mockResolvedValueOnce({
      providers: keyRows,
      encryptionAvailable: false,
      backend: "none",
    });
    useStore.setState({
      settingsPage: "providers",
      state: null,
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  const credential = {
    credentialId: 11,
    provider: "openai-codex",
    label: "me@example.com (Org)",
    detail: "Codex subscription",
    type: "oauth" as const,
    active: true,
  };

  const oauthRow = (
    patch: Partial<ProviderOAuthStatus> = {},
  ): ProviderOAuthStatus => ({
    id: "openai-codex",
    providerId: "openai-codex",
    label: "ChatGPT Plus/Pro",
    hint: "Codex subscription \u2014 models appear as openai-codex/\u2026",
    credentials: [],
    accountsUnsupported: false,
    ...patch,
  });

  it("shows each stored credential with its own sign-out action", async () => {
    seedProviders([oauthRow({ credentials: [credential] })]);
    await renderSettings();
    expect(document.body.textContent).toContain("signed in");
    expect(document.body.textContent).toContain("me@example.com (Org)");
    expect(buttonWithText("sign out")).not.toBeNull();
  });

  it("signs out the clicked credential by id", async () => {
    const other = { ...credential, credentialId: 12, label: "other@example.com" };
    seedProviders([oauthRow({ credentials: [credential, other] })]);
    await renderSettings();
    const buttons = [...document.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "sign out",
    );
    expect(buttons).toHaveLength(2);
    click(buttons[1]!);
    await act(async () => {});
    expect(backendMock.signOutProviderOAuth).toHaveBeenCalledWith("openai-codex", 12);
  });

  it("labels a credential stored under a different provider id (#779)", async () => {
    seedProviders([
      oauthRow({
        id: "openai-codex-device",
        providerId: "openai-codex-device",
        credentials: [credential],
      }),
    ]);
    await renderSettings();
    expect(document.body.textContent).toContain("stored as openai-codex");
  });

  it("reports what is still authenticated after a sign-out", async () => {
    seedProviders([oauthRow({ credentials: [credential] })]);
    backendMock.signOutProviderOAuth.mockResolvedValueOnce({
      rows: [oauthRow()],
      remainingSource: "environment variable OPENAI_API_KEY",
    });
    await renderSettings();
    click(buttonWithText("sign out")!);
    await act(async () => {});
    expect(document.body.textContent).toContain("still authenticated");
    expect(document.body.textContent).toContain("environment variable OPENAI_API_KEY");
  });

  it("shows an unsigned-in row with a Sign in action and no sign out", async () => {
    seedProviders([oauthRow()]);
    await renderSettings();
    expect(document.body.textContent).toContain("not signed in");
    expect(buttonWithText("sign out")).toBeNull();

    click(buttonWithText("Sign in")!);
    expect(backendMock.startProviderOAuth).toHaveBeenCalledWith("openai-codex");
  });

  it("says the omp update instead of \u201cnot signed in\u201d on an old binary", async () => {
    seedProviders([oauthRow({ accountsUnsupported: true })]);
    await renderSettings();
    expect(document.body.textContent).toContain("update omp");
    expect(document.body.textContent).not.toContain("not signed in");
  });

  it("renders the input phase and submits the pasted redirect URL", async () => {
    seedProviders([oauthRow()]);
    await renderSettings();
    click(buttonWithText("Sign in")!);
    await act(async () => {
      useStore.getState().replaceProviderOAuth({
        providerId: "openai-codex",
        phase: "input",
        url: null,
        instructions: "If the browser did not capture the redirect, paste the URL here.",
        prompt: {
          title: "Paste the redirect URL",
          placeholder: "https://auth.openai.com/callback?code=\u2026",
        },
        error: null,
      });
    });
    const field = document.querySelector<HTMLInputElement>(
      'input[aria-label="Paste the redirect URL sign-in response"]',
    );
    expect(field).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(field!, "https://auth.openai.com/callback?code=abc123");
      field!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(buttonWithText("Submit")!);
    expect(backendMock.submitProviderOAuthInput).toHaveBeenCalledWith(
      "https://auth.openai.com/callback?code=abc123",
    );
  });
});

describe("Settings Providers page web-search order (issue #394)", () => {
  const searchRow: ProviderKeyStatus = {
    id: "brave",
    label: "Brave Search",
    group: "search",
    env: "BRAVE_API_KEY",
    activeEnv: "BRAVE_API_KEY",
    source: "none",
    masked: null,
    hint: null,
    shadowsEnvironment: false,
    unreadableStoredEnvs: [],
  };

  const entryFor = (
    key: string,
    value: OmpSettingValue | undefined,
    layer: OmpSettingsSnapshot["entries"][number]["layer"] = "global",
    type: OmpSettingsSnapshot["entries"][number]["type"] = "array",
    globalValue?: OmpSettingValue,
  ): OmpSettingsSnapshot["entries"][number] => ({
    key,
    type,
    description: "",
    value,
    globalValue,
    options: null,
    layer,
  });

  /** Mounts Providers with one search credential, `entries`, and a discovered list. */
  function seedWebSearch(
    entries: OmpSettingsSnapshot["entries"],
    providers: string[] = ["brave", "exa"],
  ): void {
    backendMock.readOmpSettings.mockResolvedValueOnce({ ...emptyOmpSettings, entries });
    backendMock.readWebSearchProviders.mockResolvedValueOnce({
      providers,
      discovered: providers.length > 0,
      error: providers.length > 0 ? null : "this omp did not publish a provider list",
    });
    backendMock.readProviderKeys.mockResolvedValueOnce({
      providers: [searchRow],
      encryptionAvailable: true,
      backend: "secret-service",
    });
    backendMock.readProviderOAuth.mockResolvedValueOnce([]);
    useStore.setState({
      settingsPage: "providers",
      state: null,
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  }

  const orderSelect = (): HTMLSelectElement | null =>
    document.querySelector<HTMLSelectElement>(
      'select[aria-label="Preferred web-search provider"]',
    );

  async function choose(optionValue: string): Promise<void> {
    const select = orderSelect()!;
    await act(async () => {
      select.value = optionValue;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("lists omp's providers over Automatic for an empty order", async () => {
    seedWebSearch([entryFor("providers.webSearchOrder", [], "default")]);
    await renderSettings();
    const select = orderSelect()!;
    expect(select.value).toBe("");
    expect([...select.options].map((option) => option.value)).toEqual([
      "",
      "brave",
      "exa",
    ]);
    expect(select.options[0]?.textContent).toBe("Automatic — omp's default order");
  });

  it("writes the chosen provider as a one-element order", async () => {
    seedWebSearch([entryFor("providers.webSearchOrder", [], "default")]);
    await renderSettings();
    await choose("brave");
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith(
      "providers.webSearchOrder",
      ["brave"],
    );
  });

  it("clears the preference when Automatic is chosen back", async () => {
    seedWebSearch([entryFor("providers.webSearchOrder", ["brave"])]);
    await renderSettings();
    await choose("");
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith(
      "providers.webSearchOrder",
      [],
    );
  });

  it("shows a hand-written multi-order as a disabled custom option", async () => {
    seedWebSearch([entryFor("providers.webSearchOrder", ["brave", "exa"])]);
    await renderSettings();
    const select = orderSelect()!;
    const custom = [...select.options].find((option) => option.value === "__custom__");
    expect(custom?.textContent).toBe("Custom order: brave → exa");
    expect(custom?.disabled).toBe(true);
    expect(select.value).toBe("__custom__");
    // Choosing away from it still works.
    await choose("exa");
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith(
      "providers.webSearchOrder",
      ["exa"],
    );
  });

  it("badges and explains a value the focused project overrides", async () => {
    seedWebSearch([entryFor("providers.webSearchOrder", ["exa"], "project")]);
    await renderSettings();
    const select = orderSelect()!;
    expect(select.value).toBe("exa");
    expect(
      [...document.body.querySelectorAll("span")].some(
        (el) => el.textContent === "project",
      ),
    ).toBe(true);
    expect(document.body.textContent).toContain(
      "The focused project's .omp/config.yml sets its own order",
    );
    expect(document.body.textContent).not.toContain(
      "The provider the native web_search tool tries first",
    );
  });

  it("keeps a configured id selectable and notes an undiscovered list", async () => {
    seedWebSearch([entryFor("providers.webSearchOrder", ["bogus"])], []);
    await renderSettings();
    const select = orderSelect()!;
    expect(select.value).toBe("bogus");
    expect(
      [...select.options].some((option) =>
        (option.textContent ?? "").includes("not in this omp's list"),
      ),
    ).toBe(true);
    expect(document.body.textContent).toContain(
      "This omp did not publish its provider list",
    );
  });

  it("notes when the web_search tool itself is off", async () => {
    seedWebSearch([
      entryFor("providers.webSearchOrder", ["brave"]),
      entryFor("web_search.enabled", false, "default", "boolean"),
    ]);
    await renderSettings();
    expect(document.body.textContent).toContain(
      "The web_search tool is switched off (web_search.enabled)",
    );
    expect(orderSelect()!.disabled).toBe(false);
  });

  it("warns when the chosen provider is also excluded", async () => {
    seedWebSearch([
      entryFor("providers.webSearchOrder", ["brave"]),
      entryFor("providers.webSearchExclude", ["brave"], "default"),
    ]);
    await renderSettings();
    expect(document.body.textContent).toContain(
      "brave is also listed in providers.webSearchExclude, so omp always skips it.",
    );
  });

  it("renders no row when omp publishes neither the legacy key nor modelRoles", async () => {
    seedWebSearch([entryFor("advisor.enabled", true, "default", "boolean")]);
    await renderSettings();
    expect(orderSelect()).toBeNull();
    expect(document.body.textContent).not.toContain("Preferred provider");
  });

  describe("Preferred provider bound to modelRoles.web (issue #661)", () => {
    it("renders Automatic and the catalog on a modern snapshot", async () => {
      seedWebSearch([entryFor("modelRoles", { advisor: "x/adv" }, "global", "record")]);
      await renderSettings();
      const select = orderSelect()!;
      expect(select.value).toBe("");
      expect([...select.options].map((option) => option.value)).toEqual([
        "",
        "brave",
        "exa",
      ]);
    });

    it("writes the whole merged record with the chosen selector", async () => {
      seedWebSearch([
        entryFor("modelRoles", { advisor: "x/adv" }, "global", "record", {
          advisor: "x/adv",
        }),
      ]);
      await renderSettings();
      await choose("brave");
      expect(backendMock.writeOmpSetting).toHaveBeenCalledTimes(1);
      expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("modelRoles", {
        advisor: "x/adv",
        web: "web/brave",
      });
    });

    it("merges against the global layer, never the effective value", async () => {
      seedWebSearch([
        entryFor(
          "modelRoles",
          { advisor: "proj/adv", web: "web/exa" },
          "project",
          "record",
          { advisor: "glob/adv" },
        ),
      ]);
      await renderSettings();
      await choose("brave");
      expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("modelRoles", {
        advisor: "glob/adv",
        web: "web/brave",
      });
      const writeCalls = backendMock.writeOmpSetting.mock.calls as unknown as [string, unknown][];
      expect(JSON.stringify(writeCalls[0]?.[1])).not.toContain("proj/adv");
    });

    it("deletes the web key when Automatic is chosen", async () => {
      seedWebSearch([
        entryFor(
          "modelRoles",
          { advisor: "x/adv", web: "web/brave" },
          "global",
          "record",
          { advisor: "x/adv", web: "web/brave" },
        ),
      ]);
      await renderSettings();
      await choose("");
      expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("modelRoles", {
        advisor: "x/adv",
      });
    });

    it("keeps a configured id outside the catalog selectable", async () => {
      seedWebSearch([
        entryFor("modelRoles", { web: "web/bogus" }, "global", "record", {
          web: "web/bogus",
        }),
      ]);
      await renderSettings();
      const select = orderSelect()!;
      expect(select.value).toBe("bogus");
      expect(
        [...select.options].some((option) =>
          (option.textContent ?? "").includes("not in this omp's list"),
        ),
      ).toBe(true);
      await choose("brave");
      expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("modelRoles", {
        web: "web/brave",
      });
    });

    it("shows a non-web selector as the disabled custom option", async () => {
      seedWebSearch([
        entryFor("modelRoles", { web: "@role" }, "global", "record", {
          web: "@role",
        }),
      ]);
      await renderSettings();
      const select = orderSelect()!;
      const custom = [...select.options].find(
        (option) => option.value === "__custom__",
      );
      expect(custom?.textContent).toBe("Custom selector: @role");
      expect(custom?.disabled).toBe(true);
      expect(select.value).toBe("__custom__");
      await choose("brave");
      expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("modelRoles", {
        web: "web/brave",
      });
    });

    it("badges the web role's own layer, not the record's", async () => {
      seedWebSearch([
        entryFor(
          "modelRoles",
          { advisor: "glob/adv", web: "web/exa" },
          "project",
          "record",
          { advisor: "glob/adv", web: "web/brave" },
        ),
      ]);
      await renderSettings();
      expect(
        [...document.body.querySelectorAll("span")].some(
          (el) => el.textContent === "project",
        ),
      ).toBe(true);
      expect(document.body.textContent).toContain(
        "The focused project's .omp/config.yml sets its own order",
      );
    });

    it("stays unbadged when only a sibling role is project-overridden", async () => {
      seedWebSearch([
        entryFor(
          "modelRoles",
          { advisor: "proj/adv", web: "web/brave" },
          "project",
          "record",
          { advisor: "glob/adv", web: "web/brave" },
        ),
      ]);
      await renderSettings();
      expect(
        [...document.body.querySelectorAll("span")].some(
          (el) => el.textContent === "project",
        ),
      ).toBe(false);
      expect(document.body.textContent).toContain(
        "The provider the native web_search tool tries first",
      );
    });

    it("prefers the legacy key when omp publishes both", async () => {
      seedWebSearch([
        entryFor("providers.webSearchOrder", [], "default"),
        entryFor("modelRoles", { web: "web/exa" }, "global", "record", {
          web: "web/exa",
        }),
      ]);
      await renderSettings();
      // The legacy entry drives the row: Automatic (empty order), not exa.
      expect(orderSelect()!.value).toBe("");
      await choose("brave");
      expect(backendMock.writeOmpSetting).toHaveBeenCalledTimes(1);
      expect(backendMock.writeOmpSetting).toHaveBeenCalledWith(
        "providers.webSearchOrder",
        ["brave"],
      );
    });

    it("carries the tool-off note over and keeps the select enabled", async () => {
      seedWebSearch([
        entryFor("modelRoles", { web: "web/brave" }, "global", "record", {
          web: "web/brave",
        }),
        entryFor("web_search.enabled", false, "default", "boolean"),
      ]);
      await renderSettings();
      expect(document.body.textContent).toContain(
        "The web_search tool is switched off (web_search.enabled)",
      );
      expect(orderSelect()!.disabled).toBe(false);
    });

    it("warns when the role-bound provider is also excluded", async () => {
      seedWebSearch([
        entryFor("modelRoles", { web: "web/brave" }, "global", "record", {
          web: "web/brave",
        }),
        entryFor("providers.webSearchExclude", ["brave"], "default"),
      ]);
      await renderSettings();
      expect(document.body.textContent).toContain(
        "brave is also listed in providers.webSearchExclude, so omp always skips it.",
      );
    });

    it("renders with the undiscovered note when the catalog read failed", async () => {
      seedWebSearch([entryFor("modelRoles", {}, "default", "record")], []);
      await renderSettings();
      const select = orderSelect()!;
      expect(select.value).toBe("");
      expect([...select.options].map((option) => option.value)).toEqual([""]);
      expect(document.body.textContent).toContain(
        "This omp did not publish its provider list",
      );
    });
  });
});

describe("Settings Providers page privacy toggle (issue #670)", () => {
  const TELEMETRY_KEY = "telemetry.otlpExportEnabled";

  const entryFor = (
    value: OmpSettingValue | undefined,
    layer: OmpSettingsSnapshot["entries"][number]["layer"] = "default",
    type: OmpSettingsSnapshot["entries"][number]["type"] = "boolean",
    description = "Allow OMP to export traces, logs, and metrics using OTEL_* endpoints.",
  ): OmpSettingsSnapshot["entries"][number] => ({
    key: TELEMETRY_KEY,
    type,
    description,
    value,
    globalValue: undefined,
    options: null,
    layer,
  });

  /** Mounts Providers with `entries` in the omp snapshot and no credentials. */
  function seedPrivacy(entries: OmpSettingsSnapshot["entries"]): void {
    backendMock.readOmpSettings.mockResolvedValueOnce({ ...emptyOmpSettings, entries });
    backendMock.readProviderKeys.mockResolvedValueOnce({
      providers: [],
      encryptionAvailable: true,
      backend: "secret-service",
    });
    backendMock.readProviderOAuth.mockResolvedValueOnce([]);
    backendMock.readWebSearchProviders.mockResolvedValueOnce(emptyWebSearchProviders);
    useStore.setState({
      settingsPage: "providers",
      state: null,
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  }

  const telemetrySwitch = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Telemetry export"]',
    );

  it("renders the switch at omp's published value", async () => {
    seedPrivacy([entryFor(true)]);
    await renderSettings();
    expect(telemetrySwitch()?.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain(
      "Allow OMP to export traces, logs, and metrics using OTEL_* endpoints.",
    );
  });

  it("writes the flipped literal through the omp-settings channel", async () => {
    seedPrivacy([entryFor(true)]);
    await renderSettings();
    const sw = telemetrySwitch()!;
    click(sw);
    await act(async () => {});
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith(TELEMETRY_KEY, false);
  });

  it("hides the Privacy section when the binary does not publish the key", async () => {
    seedPrivacy([]);
    await renderSettings();
    expect(telemetrySwitch()).toBeNull();
    expect(document.body.textContent).not.toContain("Privacy");
  });

  it("shows a non-boolean shape read-only, with no switch", async () => {
    seedPrivacy([entryFor("yes", "global", "string")]);
    await renderSettings();
    expect(telemetrySwitch()).toBeNull();
    const raw = [...document.querySelectorAll("span")].find(
      (span) => span.textContent === JSON.stringify("yes"),
    );
    expect(raw?.textContent).toBe('"yes"');
  });

  it("badges a project-layer override", async () => {
    seedPrivacy([entryFor(false, "project")]);
    await renderSettings();
    expect(telemetrySwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("project");
  });
});

describe("Settings Appearance page transcript width and glass chrome (issues #391, #393)", () => {
  const seedAppearance = (): void => {
    useStore.setState({
      settingsPage: "appearance",
      state: backendState({ transcriptWidth: "wide", glassChrome: "subtle" }),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  };

  const card = (label: string): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  it("shows the persisted steps and persists switches from the cards", async () => {
    seedAppearance();
    await renderSettings();
    expect(document.body.textContent).toContain("Transcript width");
    expect(document.body.textContent).toContain("Glass chrome");
    expect(card("Wide transcript width").getAttribute("aria-pressed")).toBe("true");
    expect(card("Comfortable transcript width").getAttribute("aria-pressed")).toBe("false");
    expect(card("Subtle glass chrome").getAttribute("aria-pressed")).toBe("true");
    expect(card("Off glass chrome").getAttribute("aria-pressed")).toBe("false");

    click(card("Full transcript width"));
    expect(backendMock.setTranscriptWidth).toHaveBeenCalledWith("full");
    expect(document.documentElement.style.getPropertyValue("--transcript-max")).toBe("none");
    expect(document.documentElement.style.getPropertyValue("--prose-max")).toBe("88ch");

    click(card("Frosted glass chrome"));
    expect(backendMock.setGlassChrome).toHaveBeenCalledWith("frosted");
    expect(document.documentElement.dataset.glass).toBe("frosted");
  });

  it("reflects a persisted comfortable/off pair", async () => {
    useStore.setState({
      settingsPage: "appearance",
      state: backendState({ transcriptWidth: "comfortable", glassChrome: "off" }),
    });
    await renderSettings();
    expect(card("Comfortable transcript width").getAttribute("aria-pressed")).toBe("true");
    expect(card("Off glass chrome").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Settings omp Subagent concurrency section (issue #569)", () => {
  const concurrencyEntry = (): OmpSettingsSnapshot["entries"][number] => ({
    key: "task.maxConcurrency",
    type: "number",
    description: "Maximum number of subagents running concurrently",
    value: 32,
    globalValue: 32,
    options: null,
    layer: "default",
  });

  /** Seeds the omp page with the concurrency entry alone; `focused` drives projectCwd. */
  function seedConcurrency(focused = true): void {
    backendMock.readOmpSettings.mockResolvedValue({
      ...emptyOmpSettings,
      entries: [concurrencyEntry()],
    });
    backendMock.getProjectMaxConcurrency.mockResolvedValue({
      value: undefined,
      layer: { shape: "absent" as const },
    });
    const tab = tabInfo();
    useStore.setState({
      settingsPage: "omp",
      state: backendState(),
      tabs: focused ? [tab] : [],
      activeTabId: focused ? tab.tabId : null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  }

  const field = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('input[aria-label="task.maxConcurrency"]')!;

  const scopeButtons = (): HTMLButtonElement[] => [
    ...document.body.querySelectorAll<HTMLButtonElement>(
      '[role="group"][aria-label="edit scope"] button',
    ),
  ];

  async function commitNumber(value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(field(), value);
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
  }

  it("renders the section and commits the global layer through omp config set", async () => {
    seedConcurrency();
    await renderSettings();
    expect(document.body.textContent).toContain("Subagent concurrency");

    click(scopeButtons()[0]!); // Global
    expect(field().value).toBe("32");
    await commitNumber("8");
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("task.maxConcurrency", 8);
    expect(backendMock.setProjectMaxConcurrency).not.toHaveBeenCalled();
  });

  it("defaults to the project layer with a focused session and writes the project channel", async () => {
    seedConcurrency();
    await renderSettings();
    expect(backendMock.getProjectMaxConcurrency).toHaveBeenCalledWith("/project");
    expect(scopeButtons()[1]!.disabled).toBe(false);

    await commitNumber("8");
    expect(backendMock.setProjectMaxConcurrency).toHaveBeenCalledWith("/project", 8);
    expect(backendMock.writeOmpSetting).not.toHaveBeenCalled();
  });

  it("clear deletes the project override", async () => {
    seedConcurrency();
    backendMock.getProjectMaxConcurrency.mockResolvedValueOnce({
      value: "8",
      layer: { shape: "value" as const, value: "8" },
    });
    await renderSettings();
    const clear = buttonWithText("clear")!;
    expect(clear.disabled).toBe(false);
    click(clear);
    expect(backendMock.setProjectMaxConcurrency).toHaveBeenCalledWith("/project", null);
  });

  it("explains an unsupported project shape and disables the Project chip", async () => {
    seedConcurrency();
    backendMock.getProjectMaxConcurrency.mockResolvedValueOnce({
      value: undefined,
      layer: {
        shape: "unsupported" as const,
        line: 2,
        reason: "/project/.omp/config.yml:2: flow mapping",
      },
    });
    await renderSettings();
    expect(document.body.textContent).toContain(
      "This project's task.maxConcurrency can't be edited here",
    );
    expect(scopeButtons()[1]!.disabled).toBe(true);
    expect(field().disabled).toBe(true);
  });

  it("forces the global scope with no session focused", async () => {
    seedConcurrency(false);
    await renderSettings();
    expect(scopeButtons()[0]!.disabled).toBe(false);
    expect(scopeButtons()[1]!.disabled).toBe(true);
    expect(scopeButtons()[1]!.title).toContain("No session focused");
    await commitNumber("12");
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("task.maxConcurrency", 12);
    expect(backendMock.getProjectMaxConcurrency).not.toHaveBeenCalled();
  });

  it("renders nothing when omp predates the key", async () => {
    backendMock.readOmpSettings.mockResolvedValue(emptyOmpSettings);
    useStore.setState({
      settingsPage: "omp",
      state: backendState(),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
    await renderSettings();
    expect(document.body.textContent).not.toContain("Subagent concurrency");
    expect(field()).toBeNull();
  });
});

describe("Settings omp page judge role row (issue #669)", () => {
  const catalog = {
    models: [
      { selector: "openrouter/typesafe/jev-1.13", name: "Jev 1.13" },
      { selector: "local/jev-mini", name: "Jev Mini" },
    ],
    discovered: true,
    error: null,
  };

  function seedJudge(record: Record<string, unknown>): void {
    backendMock.readOmpSettings.mockResolvedValue({
      ...emptyOmpSettings,
      entries: [
        {
          key: "modelRoles",
          type: "record",
          description: "",
          value: record,
          globalValue: undefined,
          options: null,
          layer: "global",
        },
      ],
    });
    backendMock.readJudgeModels.mockResolvedValue(catalog);
    useStore.setState({
      settingsPage: "omp",
      state: backendState(),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  }

  const judgeField = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('input[aria-label="model role judge"]')!;

  const judgeOptions = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[role="group"][aria-label="model role judge"] button',
    ),
  ];

  async function openBrowse(): Promise<void> {
    await act(async () => {
      click(buttonWithText("browse…")!);
    });
  }

  async function commitText(value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(judgeField(), value);
      judgeField().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      judgeField().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
  }

  it("renders the judge row beside the chat roles without probing", async () => {
    seedJudge({ default: "anthropic/claude-opus" });
    await renderSettings();
    expect(judgeField()).not.toBeNull();
    expect(
      document.querySelector('input[aria-label="model role default"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('input[aria-label="model role advisor"]'),
    ).not.toBeNull();
    expect(backendMock.readJudgeModels).not.toHaveBeenCalled();
  });

  it("lazily lists the catalog on Browse and commits the merged record", async () => {
    seedJudge({ default: "anthropic/claude-opus", web: "web/brave" });
    await renderSettings();
    await openBrowse();
    expect(backendMock.readJudgeModels).toHaveBeenCalledTimes(1);
    expect(judgeOptions().map((b) => b.textContent)).toEqual([
      "Unset — omp's built-in judge chain",
      "Jev 1.13 · openrouter/typesafe/jev-1.13",
      "Jev Mini · local/jev-mini",
    ]);
    await act(async () => {
      click(judgeOptions()[1]!);
    });
    // The whole merged record goes out (replace-not-merge); the sibling web
    // value survives; the selector is committed verbatim, no :level appended.
    expect(backendMock.writeOmpSetting).toHaveBeenCalledTimes(1);
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("modelRoles", {
      default: "anthropic/claude-opus",
      web: "web/brave",
      judge: "openrouter/typesafe/jev-1.13",
    });
  });

  it("shows a stored value outside the catalog pressed and labelled", async () => {
    seedJudge({ judge: "openrouter/jev-2:latest" });
    await renderSettings();
    await openBrowse();
    const outside = judgeOptions().find((b) =>
      b.textContent!.includes("not in omp's catalog"),
    )!;
    expect(outside.textContent).toBe("openrouter/jev-2:latest · not in omp's catalog");
    expect(outside.getAttribute("aria-pressed")).toBe("true");
  });

  it("commits an unset pick that deletes only the judge key", async () => {
    seedJudge({ default: "x/y", judge: "openrouter/typesafe/jev-1.13" });
    await renderSettings();
    await openBrowse();
    await act(async () => {
      click(judgeOptions()[0]!); // Unset
    });
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("modelRoles", {
      default: "x/y",
    });
  });

  it("renders the failure note and keeps the field working when undiscovered", async () => {
    seedJudge({});
    backendMock.readJudgeModels.mockResolvedValueOnce({
      models: [],
      discovered: false,
      error: "omp binary not found",
    });
    await renderSettings();
    await openBrowse();
    expect(document.body.textContent).toContain(
      "could not read omp's judge catalog: omp binary not found",
    );
    await commitText("openrouter/manual-judge");
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("modelRoles", {
      judge: "openrouter/manual-judge",
    });
  });
});


describe("Settings omp Tool approval section (issue #681)", () => {
  const approvalEntry = (globalValue?: string): OmpSettingsSnapshot["entries"][number] => ({
    key: "tools.approvalMode",
    type: "enum",
    description: "Approval policy for tool calls",
    value: globalValue ?? "yolo",
    globalValue,
    options: null,
    layer: "default",
  });

  /** Seeds the omp page with the approval entry alone; `focused` drives projectCwd. */
  function seedApproval(entry: OmpSettingsSnapshot["entries"][number], focused = true): void {
    backendMock.readOmpSettings.mockResolvedValue({ ...emptyOmpSettings, entries: [entry] });
    backendMock.getProjectApprovalMode.mockResolvedValue({
      value: undefined,
      layer: { shape: "absent" as const },
    });
    const tab = tabInfo();
    useStore.setState({
      settingsPage: "omp",
      state: backendState(),
      tabs: focused ? [tab] : [],
      activeTabId: focused ? tab.tabId : null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
  }

  const select = (): HTMLSelectElement =>
    document.querySelector<HTMLSelectElement>('select[aria-label="tools.approvalMode"]')!;

  const scopeButtons = (): HTMLButtonElement[] => [
    ...document.body.querySelectorAll<HTMLButtonElement>(
      '[role="group"][aria-label="edit scope"] button',
    ),
  ];

  async function pick(value: string): Promise<void> {
    await act(async () => {
      select().value = value;
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("renders the section and commits the global tier through omp config set", async () => {
    seedApproval(approvalEntry("yolo"));
    await renderSettings();
    expect(document.body.textContent).toContain("Tool approval");

    click(scopeButtons()[0]!); // Global
    expect([...select().options].map((o) => o.value)).toEqual([
      "always-ask",
      "write",
      "yolo",
    ]);
    await pick("write");
    expect(backendMock.writeOmpSetting).toHaveBeenCalledWith("tools.approvalMode", "write");
    expect(backendMock.setProjectApprovalMode).not.toHaveBeenCalled();
  });

  it("defaults to the project layer with a focused session and writes the project channel", async () => {
    seedApproval(approvalEntry("yolo"));
    await renderSettings();
    expect(backendMock.getProjectApprovalMode).toHaveBeenCalledWith("/project");
    // An absent project layer IS the inherit state, selectable first.
    expect(select().value).toBe("inherit");
    expect([...select().options].map((o) => o.value)).toEqual([
      "inherit",
      "always-ask",
      "write",
      "yolo",
    ]);
    await pick("always-ask");
    expect(backendMock.setProjectApprovalMode).toHaveBeenCalledWith("/project", "always-ask");
    expect(backendMock.writeOmpSetting).not.toHaveBeenCalled();
  });

  it("inherit on the project layer deletes the override", async () => {
    seedApproval(approvalEntry("yolo"));
    backendMock.getProjectApprovalMode.mockResolvedValueOnce({
      value: "write",
      layer: { shape: "value" as const, value: "write" },
    });
    await renderSettings();
    expect(select().value).toBe("write");
    await pick("inherit");
    expect(backendMock.setProjectApprovalMode).toHaveBeenCalledWith("/project", null);
  });

  it("shows the unset placeholder at the global layer with no delete write", async () => {
    seedApproval(approvalEntry(undefined));
    await renderSettings();
    click(scopeButtons()[0]!); // Global
    expect(select().value).toBe("");
    await pick("inherit");
    // The global layer has no delete rail: inherit there means "no key", and
    // the placeholder already shows that — a same-value write would lie.
    expect(backendMock.writeOmpSetting).not.toHaveBeenCalled();
  });

  it("renders nothing when omp predates the key", async () => {
    backendMock.readOmpSettings.mockResolvedValue(emptyOmpSettings);
    useStore.setState({
      settingsPage: "omp",
      state: backendState(),
      tabs: [],
      activeTabId: null,
      appUpdate: appUpdateState({}),
      ompUpdate: idleOmpUpdate,
    });
    await renderSettings();
    expect(document.body.textContent).not.toContain("Tool approval");
    expect(backendMock.getProjectApprovalMode).not.toHaveBeenCalled();
  });
});
