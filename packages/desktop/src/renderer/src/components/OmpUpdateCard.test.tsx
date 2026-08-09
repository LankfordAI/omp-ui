// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpUpdateState } from "@omp-ui/core/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const idleOmpUpdate: OmpUpdateState = {
  status: "idle",
  installPath: null,
  installedVersion: null,
  latestVersion: null,
  progress: null,
  error: null,
};

// store.ts captures the preload bridge at module load, so install the mock
// before dynamically importing either the store or OmpUpdateCard.
const backendMock = {
  getState: vi.fn(),
  addProject: vi.fn(),
  browseDirectories: vi.fn(),
  removeProject: vi.fn(),
  moveProject: vi.fn(async () => {}),
  setDefaultMode: vi.fn(),
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
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { OmpUpdateCard } = await import("./OmpUpdateCard");

function ompUpdateState(patch: Partial<OmpUpdateState>): OmpUpdateState {
  return {
    ...idleOmpUpdate,
    installPath: "/managed/omp",
    installedVersion: "1.0.0",
    ...patch,
  };
}

let root: Root | null = null;

function renderCard(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<OmpUpdateCard />));
}

function buttonWithText(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (found === undefined) throw new Error(`button not found: ${text}`);
  return found;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
  useStore.setState({ ompUpdate: ompUpdateState({}) });
});

describe("OmpUpdateCard", () => {
  it("renders nothing while idle", () => {
    useStore.setState({ ompUpdate: ompUpdateState({ status: "idle" }) });
    renderCard();
    expect(document.body.textContent).toBe("");
  });

  it("announces an available update with both versions and the two actions", () => {
    useStore.setState({
      ompUpdate: ompUpdateState({ status: "available", latestVersion: "1.2.0" }),
    });
    renderCard();
    expect(document.body.textContent).toContain("omp 1.2.0 available");
    expect(document.body.textContent).toContain("installed: 1.0.0");
    expect(document.body.textContent).toContain("new sessions will use it");
    click(buttonWithText("Update now"));
    expect(backendMock.downloadOmpUpdate).toHaveBeenCalled();
    click(buttonWithText("Later"));
    expect(backendMock.dismissOmpUpdate).toHaveBeenCalledWith("1.2.0", true);

    click(document.body.querySelector<HTMLButtonElement>('[aria-label="dismiss omp 1.2.0 offer"]')!);
    expect(backendMock.dismissOmpUpdate).toHaveBeenLastCalledWith("1.2.0", true);
  });

  it("offers an install when omp is missing — never an update", () => {
    useStore.setState({
      ompUpdate: ompUpdateState({
        status: "missing",
        installPath: null,
        installedVersion: null,
        latestVersion: "1.2.0",
      }),
    });
    renderCard();
    expect(document.body.textContent).toContain("omp is not installed");
    expect(document.body.textContent?.toLowerCase()).not.toContain("update");
    click(buttonWithText("Install"));
    expect(backendMock.downloadOmpUpdate).toHaveBeenCalled();
    click(buttonWithText("Later"));
    expect(backendMock.dismissOmpUpdate).toHaveBeenCalledWith("1.2.0", true);

    click(document.body.querySelector<HTMLButtonElement>('[aria-label="dismiss omp 1.2.0 offer"]')!);
    expect(backendMock.dismissOmpUpdate).toHaveBeenLastCalledWith("1.2.0", true);
  });

  it("shows the install percentage while downloading", () => {
    useStore.setState({
      ompUpdate: ompUpdateState({ status: "downloading", latestVersion: "1.2.0", progress: 42 }),
    });
    renderCard();
    expect(document.body.textContent).toContain("Installing omp 1.2.0");
    expect(document.body.textContent).toContain("42%");
  });

  it("confirms the install and scopes it to new sessions", () => {
    useStore.setState({
      ompUpdate: ompUpdateState({ status: "installed", latestVersion: "1.2.0" }),
    });
    renderCard();
    expect(document.body.textContent).toContain("omp 1.2.0 installed");
    expect(document.body.textContent).toContain("new sessions");
    click(buttonWithText("Dismiss"));
    expect(backendMock.dismissOmpUpdate).toHaveBeenCalledWith("1.2.0", false);
  });

  it("keeps an error sticky until the ✕ is clicked", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        ompUpdate: ompUpdateState({ status: "error", error: "failed to download omp 1.2.0: HTTP 500" }),
      });
      renderCard();
      expect(document.body.textContent).toContain("Install failed");
      expect(document.body.textContent).toContain("HTTP 500");
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(backendMock.dismissOmpUpdate).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("HTTP 500");
      const close = document.body.querySelector<HTMLButtonElement>('button[aria-label="dismiss"]');
      expect(close).not.toBeNull();
      click(close!);
      expect(backendMock.dismissOmpUpdate).toHaveBeenCalledWith("", false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-dismisses the up-to-date answer after five seconds", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ ompUpdate: ompUpdateState({ status: "up-to-date" }) });
      renderCard();
      expect(document.body.textContent).toContain("omp is up to date (1.0.0)");
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(backendMock.dismissOmpUpdate).toHaveBeenCalledWith("", false);
    } finally {
      vi.useRealTimers();
    }
  });
});
