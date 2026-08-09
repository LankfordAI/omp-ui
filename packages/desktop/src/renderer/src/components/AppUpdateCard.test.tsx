// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateState, OmpUpdateState } from "@omp-ui/core/types";

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
// before dynamically importing either the store or AppUpdateCard.
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
const { AppUpdateCard } = await import("./AppUpdateCard");

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

function renderCard(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<AppUpdateCard />));
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
  useStore.setState({ appUpdate: appUpdateState({}) });
});

describe("AppUpdateCard", () => {
  it("renders nothing while idle", () => {
    useStore.setState({ appUpdate: appUpdateState({ status: "idle" }) });
    renderCard();
    expect(document.body.textContent).toBe("");
  });

  it("announces an available update with versions and the three actions", () => {
    useStore.setState({
      appUpdate: appUpdateState({ status: "available", latestVersion: "1.2.0" }),
    });
    renderCard();
    expect(document.body.textContent).toContain("omp-ui 1.2.0 available");
    expect(document.body.textContent).toContain("installed: 1.0.0");
    buttonWithText("Download");
    buttonWithText("Release notes");
    click(buttonWithText("Later"));
    expect(backendMock.dismissAppUpdate).toHaveBeenCalledWith("1.2.0", true);

    click(document.body.querySelector<HTMLButtonElement>('[aria-label="dismiss omp-ui 1.2.0 update"]')!);
    expect(backendMock.dismissAppUpdate).toHaveBeenLastCalledWith("1.2.0", true);
  });

  it.each(["appimage", "nsis"] as const)("labels %s available action Update", (format) => {
    useStore.setState({
      appUpdate: appUpdateState({ status: "available", latestVersion: "1.2.0", format }),
    });
    renderCard();
    buttonWithText("Update");
  });

  it.each(["appimage", "nsis"] as const)(
    "shows %s staging progress",
    (format) => {
      useStore.setState({
        appUpdate: appUpdateState({
          status: "downloading",
          latestVersion: "1.2.0",
          format,
          progress: 42,
        }),
      });
      renderCard();
      expect(document.body.textContent).toContain("Downloading omp-ui 1.2.0");
      expect(document.body.textContent).toContain("42%");
    },
  );

  it.each(["appimage", "nsis"] as const)(
    "restarts, arms install-on-quit, and dismisses a staged %s update",
    (format) => {
      useStore.setState({
        appUpdate: appUpdateState({
          status: "downloaded",
          latestVersion: "1.2.0",
          format,
        }),
      });
      renderCard();
      expect(document.body.textContent).toContain("omp-ui 1.2.0 ready");

      click(buttonWithText("Restart now"));
      expect(backendMock.restartForAppUpdate).toHaveBeenCalled();

      click(buttonWithText("Install when I quit"));
      expect(backendMock.setAppUpdateInstallOnQuit).toHaveBeenCalledWith(true);

      click(buttonWithText("Later"));
      expect(backendMock.dismissAppUpdate).toHaveBeenCalledWith("1.2.0", false);
    },
  );

  it("confirms a restart with live sessions in the initiating renderer", async () => {
    backendMock.restartForAppUpdate
      .mockResolvedValueOnce("confirmation-required")
      .mockResolvedValueOnce("restarting");
    useStore.setState({
      appUpdate: appUpdateState({
        status: "downloaded",
        latestVersion: "1.2.0",
        format: "appimage",
      }),
    });
    renderCard();

    await act(async () => buttonWithText("Restart now").click());
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "sessions are still live",
    );
    await act(async () => buttonWithText("Restart and stop sessions").click());
    expect(backendMock.restartForAppUpdate).toHaveBeenNthCalledWith(1, false);
    expect(backendMock.restartForAppUpdate).toHaveBeenNthCalledWith(2, true);
  });

  it.each(["appimage", "nsis"] as const)(
    "shows and disarms a %s install-on-quit choice",
    (format) => {
      useStore.setState({
        appUpdate: appUpdateState({
          status: "downloaded",
          latestVersion: "1.2.0",
          format,
          installOnQuit: true,
        }),
      });
      renderCard();
      expect(document.body.textContent).toContain("will install when you quit");
      click(buttonWithText("Undo"));
      expect(backendMock.setAppUpdateInstallOnQuit).toHaveBeenCalledWith(false);
    },
  );

  it("reveals a downloaded deb in its folder", () => {
    useStore.setState({
      appUpdate: appUpdateState({
        status: "downloaded",
        latestVersion: "1.2.0",
        downloadedPath: "/home/u/Downloads/omp-ui_1.2.0_amd64.deb",
      }),
    });
    renderCard();
    expect(document.body.textContent).toContain("Downloaded omp-ui 1.2.0");
    click(buttonWithText("Show in folder"));
    expect(backendMock.showAppUpdateDownload).toHaveBeenCalled();
  });

  it("auto-dismisses the up-to-date answer after five seconds", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ appUpdate: appUpdateState({ status: "up-to-date" }) });
      renderCard();
      expect(document.body.textContent).toContain("omp-ui is up to date (1.0.0)");
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(backendMock.dismissAppUpdate).toHaveBeenCalledWith("", false);
    } finally {
      vi.useRealTimers();
    }
  });
});
