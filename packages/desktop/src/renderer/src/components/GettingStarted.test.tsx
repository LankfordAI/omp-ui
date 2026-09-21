// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendState,
  OmpUpdateState,
  ProjectGroup,
  ProviderKeysSnapshot,
  ProviderKeyStatus,
  ProviderOAuthState,
  ProviderOAuthStatus,
  SessionSummary,
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

const idleProviderOAuth: ProviderOAuthState = {
  providerId: null,
  phase: "idle",
  url: null,
  instructions: null,
  prompt: null,
  error: null,
};

const emptyKeys: ProviderKeysSnapshot = {
  providers: [],
  encryptionAvailable: true,
  backend: "test_stub",
};

// store.ts captures the preload bridge at module load, so install the mock
// before dynamically importing either the store or GettingStarted.
const backendMock = {
  getState: vi.fn(),
  rpcSend: vi.fn(),
  readProviderKeys: vi.fn(async (): Promise<ProviderKeysSnapshot> => emptyKeys),
  readProviderOAuth: vi.fn(async (): Promise<ProviderOAuthStatus[]> => []),
  downloadOmpUpdate: vi.fn(async () => {}),
  checkOmpUpdate: vi.fn(async () => {}),
  setGettingStartedSeen: vi.fn(async () => {}),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onSessionHibernated: vi.fn(),
  onFocusSession: vi.fn(),
  onShellData: vi.fn(),
  onShellExit: vi.fn(),
  onBrowserPaneFrame: vi.fn(),
  onBrowserPaneState: vi.fn(),
  onRpcFrame: vi.fn(),
  onAppUpdateState: vi.fn(),
  onOmpUpdateState: vi.fn(),
  onRemoteState: vi.fn(),
  onProviderOAuthState: vi.fn(),
  onStateChanged: vi.fn(),
  onBranchChanged: vi.fn(),
  tabViewed: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { GettingStarted } = await import("./GettingStarted");

function ompUpdateState(patch: Partial<OmpUpdateState>): OmpUpdateState {
  return { ...idleOmpUpdate, ...patch };
}

function keyRow(patch: Partial<ProviderKeyStatus>): ProviderKeyStatus {
  return {
    id: "openrouter",
    label: "OpenRouter",
    group: "models",
    env: "OPENROUTER_API_KEY",
    activeEnv: "OPENROUTER_API_KEY",
    source: "none",
    masked: null,
    hint: null,
    shadowsEnvironment: false,
    ...patch,
  };
}

function subscriptionRow(accounts: string[]): ProviderOAuthStatus {
  return {
    id: "openai-codex",
    providerId: "openai-codex",
    label: "ChatGPT",
    hint: "",
    accounts,
  };
}

function sessionSummary(): SessionSummary {
  return {
    tabId: "tab-1",
    sessionId: null,
    lineageDir: "omp-ui--p--11111111-2222-3333-4444-555555555555",
    projectCwd: "/p",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    launchedAt: "t",
    mode: "rpc-ui",
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    cachedTitle: null,
    cachedModified: null,
    agentMode: "build",
    title: "New session",
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  };
}

/** The one-project state; `sessions` picks the empty-project vs has-life gate. */
function stateWithSessions(sessions: "none" | "one"): BackendState {
  const group: ProjectGroup = {
    project: {
      path: "/p",
      name: "p",
      addedAt: "t",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
    },
    sessions: sessions === "one" ? [sessionSummary()] : [],
  };
  return backendState({ projects: [group] });
}

/** One seed: everything unmet and unvisited, overwritten per case. */
function seed(patch: Partial<Parameters<typeof useStore.setState>[0]> = {}): void {
  useStore.setState({
    state: null,
    tabs: [],
    activeTabId: null,
    settingsPage: null,
    ompUpdate: idleOmpUpdate,
    providerOAuth: idleProviderOAuth,
    errorNotices: [],
    ...patch,
  });
}

let root: Root | null = null;

/** Mounts the checklist and flushes the mount-time provider read. */
async function renderChecklist(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<GettingStarted />);
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
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  backendMock.readProviderKeys.mockResolvedValue(emptyKeys);
  backendMock.readProviderOAuth.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("Getting started checklist rows (issue #623)", () => {
  it("offers Install while the omp binary is missing, and it starts the download", async () => {
    seed({ ompUpdate: ompUpdateState({ status: "missing" }) });
    await renderChecklist();
    const install = buttonWithText("Install");
    expect(install).not.toBeNull();
    click(install!);
    expect(backendMock.downloadOmpUpdate).toHaveBeenCalledTimes(1);
  });

  it("offers Check for a not-yet-checked binary state, and flips done once installed", async () => {
    seed({ ompUpdate: ompUpdateState({ status: "idle" }) });
    await renderChecklist();
    expect(buttonWithText("Check")).not.toBeNull();

    // The live broadcast is the only writer: the row flips without a remount.
    act(() => {
      useStore.setState({
        ompUpdate: ompUpdateState({ status: "up-to-date", installedVersion: "18.2.4" }),
      });
    });
    expect(buttonWithText("Install")).toBeNull();
    expect(buttonWithText("Check")).toBeNull();
  });

  it("shows the download progress while installing", async () => {
    seed({ ompUpdate: ompUpdateState({ status: "downloading", progress: 42 }) });
    await renderChecklist();
    expect(document.body.textContent).toContain("installing — 42%");
  });

  it("keeps Install as the retry with the error message shown", async () => {
    seed({
      ompUpdate: ompUpdateState({
        status: "error",
        error: { kind: "failed", message: "checksum mismatch" },
      }),
    });
    await renderChecklist();
    expect(document.body.textContent).toContain("checksum mismatch");
    const install = buttonWithText("Install");
    expect(install).not.toBeNull();
    click(install!);
    expect(backendMock.downloadOmpUpdate).toHaveBeenCalledTimes(1);
  });

  it("a supplied key row flips the provider step", async () => {
    backendMock.readProviderKeys.mockResolvedValue({
      ...emptyKeys,
      providers: [keyRow({ source: "stored", masked: "sk-…4f2a" })],
    });
    await renderChecklist();
    expect(buttonWithText("Open provider settings")).toBeNull();
  });

  it("an unsupplied snapshot leaves the provider step open with its action", async () => {
    backendMock.readProviderKeys.mockResolvedValue({
      ...emptyKeys,
      providers: [keyRow({})],
    });
    await renderChecklist();
    expect(buttonWithText("Open provider settings")).not.toBeNull();
  });

  it("a signed-in subscription flips the provider step even with no key rows", async () => {
    backendMock.readProviderOAuth.mockResolvedValue([subscriptionRow(["me@example.com"])]);
    await renderChecklist();
    expect(buttonWithText("Open provider settings")).toBeNull();
  });

  it("a failed provider read leaves the step open, never a false done", async () => {
    backendMock.readProviderKeys.mockRejectedValue(new Error("provider read blew up"));
    await renderChecklist();
    expect(buttonWithText("Open provider settings")).not.toBeNull();
    expect(useStore.getState().errorNotices.map((n) => n.message)).toContain(
      "provider read blew up",
    );
  });

  it("re-reads the provider rows when the Settings overlay it opened closes", async () => {
    await renderChecklist();
    expect(backendMock.readProviderKeys).toHaveBeenCalledTimes(1);

    act(() => {
      useStore.getState().openSettings("providers");
    });
    expect(backendMock.readProviderKeys).toHaveBeenCalledTimes(1);

    act(() => {
      useStore.getState().closeSettings();
    });
    expect(backendMock.readProviderKeys).toHaveBeenCalledTimes(2);
  });

  it("re-reads the provider rows when a subscription sign-in finishes", async () => {
    await renderChecklist();
    expect(backendMock.readProviderOAuth).toHaveBeenCalledTimes(1);

    act(() => {
      useStore.setState({
        providerOAuth: { ...idleProviderOAuth, phase: "browser", url: "https://auth" },
      });
    });
    expect(backendMock.readProviderOAuth).toHaveBeenCalledTimes(1);

    act(() => {
      useStore.setState({ providerOAuth: { ...idleProviderOAuth, phase: "done" } });
    });
    expect(backendMock.readProviderOAuth).toHaveBeenCalledTimes(2);
  });

  it("the project step offers the picker while no project is tracked", async () => {
    seed();
    await renderChecklist();
    const add = buttonWithText("Add project");
    expect(add).not.toBeNull();
    click(add!);
    expect(useStore.getState().projectPickerOpen).toBe(true);
  });

  it("the session step waits on the project step, then fires on the first project", async () => {
    const newSession = vi.fn(async (): Promise<void> => {});
    seed({ state: null, newSession });
    await renderChecklist();
    expect(buttonWithText("New session")?.disabled).toBe(true);

    act(() => {
      useStore.setState({ state: stateWithSessions("none") });
    });
    const next = buttonWithText("New session");
    expect(next?.disabled).toBe(false);
    await act(async () => {
      next!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(newSession).toHaveBeenCalledWith("/p");
  });

  it("an existing session flips the last step", async () => {
    seed({ state: stateWithSessions("one") });
    await renderChecklist();
    expect(buttonWithText("New session")).toBeNull();
    expect(buttonWithText("Add project")).toBeNull();
  });
});

describe("Getting started dismissal (issue #623)", () => {
  it("Done closes the checklist and marks it seen once", () => {
    seed({ gettingStartedOpen: true, state: backendState({ gettingStartedSeen: false }) });
    act(() => {
      useStore.getState().dismissGettingStarted();
    });
    expect(useStore.getState().gettingStartedOpen).toBe(false);
    expect(backendMock.setGettingStartedSeen).toHaveBeenCalledTimes(1);
    expect(backendMock.setGettingStartedSeen).toHaveBeenCalledWith(true);
  });

  it("a palette re-open on an already-seen install dismisses without a write", () => {
    seed({ gettingStartedOpen: true, state: backendState({ gettingStartedSeen: true }) });
    act(() => {
      useStore.getState().dismissGettingStarted();
    });
    expect(backendMock.setGettingStartedSeen).not.toHaveBeenCalled();
  });
});
