// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirBrowseResult, OmpUpdateState } from "@omp-ui/core/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, hence no scrollIntoView; the picker calls it on the
// active row exactly like CommandPalette does.
HTMLElement.prototype.scrollIntoView = vi.fn();

const idleOmpUpdate: OmpUpdateState = {
  status: "idle",
  installPath: null,
  installedVersion: null,
  latestVersion: null,
  progress: null,
  error: null,
};

// store.ts and backend.ts capture the preload bridge at module load, so
// install the mock before dynamically importing either.
const backendMock = {
  getState: vi.fn(),
  addProject: vi.fn(),
  browseDirectories: vi.fn(),
  removeProject: vi.fn(),
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
  dismissAppUpdate: vi.fn(),
  onAppUpdateState: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { ProjectPicker } = await import("./ProjectPicker");
const originalNewSession = useStore.getState().newSession;
const newSession = vi.fn(async () => {});
const originalMatchMedia = window.matchMedia;

const HOME = "/home/u";

/** Canned listings keyed by the exact browse input. */
const listings: Record<string, DirBrowseResult> = {
  "~/": {
    parentPath: HOME,
    entries: [
      { name: "alpha", fullPath: `${HOME}/alpha` },
      { name: "beta", fullPath: `${HOME}/beta` },
    ],
    error: null,
  },
  "~/al": {
    parentPath: HOME,
    entries: [{ name: "alpha", fullPath: `${HOME}/alpha` }],
    error: null,
  },
  [`${HOME}/alpha/`]: { parentPath: `${HOME}/alpha`, entries: [], error: null },
  "/home/": { parentPath: "/home", entries: [{ name: "u", fullPath: HOME }], error: null },
};

/** Mirrors App.tsx's mounting: the picker exists only while the store says so. */
function Gate() {
  const open = useStore((s) => s.projectPickerOpen);
  return open ? <ProjectPicker /> : null;
}

let root: Root | null = null;

async function renderPicker(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Gate />));
}

function input(): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="project directory path"]',
  );
  if (found === null) throw new Error("picker input not found");
  return found;
}

const LISTING_NAMES: Record<string, true> = { alpha: true, beta: true, u: true, stale: true };

function rowNames(): string[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button[type=button]")]
    .map((b) => b.textContent ?? "")
    .filter((t) => t === ".." || LISTING_NAMES[t]);
}

async function type(value: string): Promise<void> {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.browseDirectories.mockImplementation(
    async (q: string) => listings[q] ?? { parentPath: "", entries: [], error: "invalid" },
  );
  useStore.setState({ projectPickerOpen: true, newSession });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  if (originalMatchMedia === undefined) Reflect.deleteProperty(window, "matchMedia");
  else Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  useStore.setState({ newSession: originalNewSession });
});

describe("ProjectPicker", () => {
  it("opens seeded with ~/ and renders the home listing", async () => {
    await renderPicker();
    expect(backendMock.browseDirectories).toHaveBeenCalledWith("~/");
    expect(input().value).toBe("~/");
    expect(rowNames()).toEqual(["..", "alpha", "beta"]);
    expect(document.body.textContent).toContain("Esc");
  });

  it("shows the acceptance button on desktop without starting a session", async () => {
    backendMock.addProject.mockResolvedValue({});
    await renderPicker();
    const accept = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Add project",
    );
    expect(accept).toBeDefined();
    await act(async () => accept!.click());
    expect(backendMock.addProject).toHaveBeenCalledWith(HOME);
    expect(newSession).not.toHaveBeenCalled();
  });

  it("keeps suggestions and starts a session after compact acceptance", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    backendMock.addProject.mockResolvedValue({});
    await renderPicker();

    expect(rowNames()).toEqual(["..", "alpha", "beta"]);
    expect(document.body.textContent).not.toContain("Esc");
    expect(document.body.querySelector('button[aria-label="close dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain(`will add: ${HOME}`);
    const accept = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Add project",
    );
    expect(accept).toBeDefined();
    await act(async () => accept!.click());
    expect(backendMock.addProject).toHaveBeenCalledWith(HOME);
    expect(useStore.getState().projectPickerOpen).toBe(false);
    expect(newSession).toHaveBeenCalledWith(HOME);
  });

  it("narrows through a new browse call on every keystroke", async () => {
    await renderPicker();
    await type("~/al");
    expect(backendMock.browseDirectories).toHaveBeenCalledWith("~/al");
    expect(rowNames()).toEqual(["..", "alpha"]);
  });

  it("descends into the selected entry on Enter", async () => {
    await renderPicker();
    await press("ArrowDown"); // ".."
    await press("ArrowDown"); // "alpha"
    await press("Enter");
    expect(input().value).toBe(`${HOME}/alpha/`);
    expect(backendMock.browseDirectories).toHaveBeenCalledWith(`${HOME}/alpha/`);
  });

  it("descends to the parent via the .. row", async () => {
    await renderPicker();
    await press("ArrowDown"); // ".."
    await press("Enter");
    expect(input().value).toBe("/home/");
    expect(backendMock.browseDirectories).toHaveBeenCalledWith("/home/");
  });

  it("registers the resolved path on Enter with no selection and closes", async () => {
    backendMock.addProject.mockResolvedValue({});
    await renderPicker();
    await press("Enter");
    expect(backendMock.addProject).toHaveBeenCalledWith(HOME);
    expect(useStore.getState().projectPickerOpen).toBe(false);
    expect(document.body.querySelector("input")).toBeNull();
  });

  it("renders a rejection inline and stays open", async () => {
    backendMock.addProject.mockRejectedValue(new Error("no such directory: /home/u"));
    await renderPicker();
    await press("Enter");
    expect(useStore.getState().projectPickerOpen).toBe(true);
    expect(document.body.textContent).toContain("no such directory: /home/u");
  });

  it("force-submits the resolved path on mod+Enter even with a row selected", async () => {
    backendMock.addProject.mockResolvedValue({});
    await renderPicker();
    await press("ArrowDown"); // select ".." — mod+Enter must ignore it
    await press("Enter", { ctrlKey: true });
    expect(backendMock.addProject).toHaveBeenCalledWith(HOME);
    expect(useStore.getState().projectPickerOpen).toBe(false);
  });

  it("keeps focus on the path input when a row is clicked (#23)", async () => {
    await renderPicker();
    const row = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "alpha",
    )!;
    // Focus moves on mousedown; the row must preventDefault there so keyboard
    // confirmation keeps working after mouse navigation.
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => {
      row.dispatchEvent(mousedown);
    });
    expect(mousedown.defaultPrevented).toBe(true);
  });

  it("discards a stale browse response that resolves after a newer one", async () => {
    let resolveFirst!: (r: DirBrowseResult) => void;
    let resolveSecond!: (r: DirBrowseResult) => void;
    backendMock.browseDirectories
      .mockImplementationOnce(() => new Promise<DirBrowseResult>((r) => (resolveFirst = r)))
      .mockImplementationOnce(() => new Promise<DirBrowseResult>((r) => (resolveSecond = r)));

    await renderPicker();
    await type("~/al");

    await act(async () => {
      resolveSecond({
        parentPath: HOME,
        entries: [{ name: "alpha", fullPath: `${HOME}/alpha` }],
        error: null,
      });
    });
    expect(rowNames()).toEqual(["..", "alpha"]);

    await act(async () => {
      resolveFirst({
        parentPath: HOME,
        entries: [{ name: "stale", fullPath: `${HOME}/stale` }],
        error: null,
      });
    });
    expect(rowNames()).toEqual(["..", "alpha"]);
  });
});
