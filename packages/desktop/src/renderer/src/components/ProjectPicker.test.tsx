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
  moveProject: vi.fn(async () => {}),
  setDefaultMode: vi.fn(),
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
    entries: [
      { name: "alpha", fullPath: `${HOME}/alpha` },
      { name: "axle", fullPath: `${HOME}/axle` },
    ],
    error: null,
  },
  "~/aa": {
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

const LISTING_NAMES: Record<string, true> = { alpha: true, axle: true, beta: true, u: true, stale: true };

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
    expect(newSession).toHaveBeenCalledWith(HOME, undefined, null);
  });

  it("narrows through a new browse call on every keystroke", async () => {
    await renderPicker();
    await type("~/al");
    expect(backendMock.browseDirectories).toHaveBeenCalledWith("~/al");
    expect(rowNames()).toEqual(["..", "alpha", "axle"]);
  });

  it("ranks prefix matches above scattered subsequences", async () => {
    await renderPicker();
    await type("~/al");
    // The backend's fuzzy recall returns both; the scorer ranks the prefix
    // (alpha) over the scattered subsequence (axle).
    expect(rowNames()).toEqual(["..", "alpha", "axle"]);
  });

  it("matches non-contiguous characters in the leaf", async () => {
    await renderPicker();
    await type("~/aa");
    // "aa" is a subsequence of "alpha" but not a prefix; the picker browses
    // the typed query verbatim and keeps the entry the backend recalled.
    expect(backendMock.browseDirectories).toHaveBeenCalledWith("~/aa");
    expect(rowNames()).toEqual(["..", "alpha"]);
  });

  it("registers the full path of a fuzzy selection, not the query", async () => {
    backendMock.addProject.mockResolvedValue({});
    await renderPicker();
    await type("~/al");
    await press("ArrowDown"); // ".."
    await press("ArrowDown"); // "alpha"
    await press("Enter"); // descend — query becomes the entry's real path
    expect(input().value).toBe(`${HOME}/alpha/`);
    expect(backendMock.browseDirectories).toHaveBeenCalledWith(`${HOME}/alpha/`);
    await press("Enter"); // dirMode accept
    expect(backendMock.addProject).toHaveBeenCalledWith(`${HOME}/alpha`);
  });

  it("highlights the matched characters", async () => {
    await renderPicker();
    await type("~/al");
    const row = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").startsWith("alpha"),
    )!;
    expect(row.textContent).toBe("alpha");
    const hits = [...row.querySelectorAll("span.text-signal")];
    expect(hits.map((s) => s.textContent).join("")).toBe("al");
  });

  it("descends into the selected entry on Enter", async () => {
    await renderPicker();
    await press("ArrowDown"); // ".."
    await press("ArrowDown"); // "alpha"
    await press("Enter");
    expect(input().value).toBe(`${HOME}/alpha/`);
    expect(backendMock.browseDirectories).toHaveBeenCalledWith(`${HOME}/alpha/`);
  });

  it("supports Ctrl-N navigation and Tab selection through the shared engine", async () => {
    await renderPicker();
    await press("n", { ctrlKey: true }); // ".."
    await press("n", { ctrlKey: true }); // "alpha"
    await press("Tab");
    expect(input().value).toBe(`${HOME}/alpha/`);
    expect(backendMock.browseDirectories).toHaveBeenCalledWith(`${HOME}/alpha/`);
  });

  it("keeps empty results and the no-selection cursor safe", async () => {
    backendMock.addProject.mockResolvedValue({});
    backendMock.browseDirectories.mockResolvedValue({ parentPath: "/", entries: [], error: null });
    await renderPicker();

    await press("ArrowDown");
    await press("ArrowUp");
    await press("n", { ctrlKey: true });
    await press("p", { ctrlKey: true });
    expect(rowNames()).toEqual([]);
    expect(document.body.textContent).toContain("No matching directories");

    await press("Enter");
    expect(backendMock.addProject).toHaveBeenCalledWith("/");
    expect(useStore.getState().projectPickerOpen).toBe(false);
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
