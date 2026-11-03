// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGroup, ProjectIcon, ProjectOpenAvailability, RemoteInstanceSummary, RemoteVsCodeTarget } from "@omp-ui/core/types";
import type { TabInfo } from "../store";
import { backendState, remoteInstance, tabInfo } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
const backendMock = {
  getProjectOpenAvailability: vi.fn<() => Promise<ProjectOpenAvailability>>(),
  openProject: vi.fn<(path: string, target: "vscode" | "files" | "terminal") => Promise<void>>(),
  getRemoteVsCodeTarget: vi.fn<(instanceId: string) => Promise<RemoteVsCodeTarget>>(),
  openRemoteVsCode: vi.fn<(instanceId: string, path: string) => Promise<void>>(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { CornerTools } = await import("./CornerTools");

const originalMatchMedia = window.matchMedia;
let root: Root | null = null;

/** A registry group for the given path/name/key triple; sessions never matter here. */
function projectGroup(path: string, name: string, repositoryKey: string | null, icon: ProjectIcon | null = null): ProjectGroup {
  return {
    project: {
      path,
      name,
      addedAt: "t",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
      browserClock: false,
      reviewRoster: null,
      knowledgeHome: null,
      repositoryKey,
      icon,
    },
    sessions: [],
  };
}

interface RenderOptions {
  /** Defaults to the quick-open fixture registry: local /a, local /b + remote twin. */
  projects?: ProjectGroup[];
  /** Defaults to one project tab on /b. */
  tabs?: TabInfo[];
  /** Defaults to box-a holding /remote/r (bravo's remote twin). */
  instances?: RemoteInstanceSummary[];
  compact?: boolean;
  /** The remoteVsCodeEnabled setting (issue #995). */
  remoteVsCode?: boolean;
}

/**
 * Fixture registry mirroring ProjectQuickOpen.test.tsx: local /a (keyless),
 * local /b and remote /remote/r sharing one repository key, focused tab on /b.
 */
function render(options: RenderOptions = {}): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: options.compact === true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  const mocks = {
    newSession: vi.fn((): Promise<string> => Promise.resolve("t")),
    openProjectSettings: vi.fn(),
    reportError: vi.fn(),
  };
  const tabs = options.tabs ?? [tabInfo({ tabId: "t1", projectCwd: "/b", instanceId: null })];
  useStore.setState({
    ...mocks,
    state: backendState({
      remoteVsCodeEnabled: options.remoteVsCode === true,
      projects: options.projects ?? [projectGroup("/a", "alpha", null), projectGroup("/b", "bravo", "github.com/o/r")],
      chats: [],
      remoteInstances:
        options.instances ?? [
          remoteInstance({
            id: "inst-1",
            nickname: "box-a",
            projects: [projectGroup("/remote/r", "rho", "github.com/o/r")],
          }),
        ],
    }),
    tabs,
    activeTabId: tabs[0]?.tabId ?? null,
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<CornerTools />));
}

const TRIGGER_LABEL = "Project tools";

function trigger(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${TRIGGER_LABEL}"]`);
  expect(found).not.toBeNull();
  return found!;
}

/** The trigger's wrapper span; enter/leave handlers live there. */
function triggerWrapper(): HTMLElement {
  return trigger().parentElement!;
}

/**
 * React 19 synthesises onPointerEnter/Leave from `pointerover`/`pointerout`
 * (delegated at the root, with relatedTarget deciding the enter/leave pair),
 * so the helpers dispatch exactly that pair — never both pointer and mouse
 * pairs, which would double-fire. jsdom without PointerEvent falls back to a
 * MouseEvent typed "pointerover"/"pointerout"; React's plugin keys off the
 * type either way.
 */
function firePointer(el: Element, type: "pointerover" | "pointerout", clientX: number, clientY: number): void {
  const init = { bubbles: true, clientX, clientY, relatedTarget: null } as const;
  act(() => {
    el.dispatchEvent(
      typeof PointerEvent === "function"
        ? new PointerEvent(type, init)
        : new MouseEvent(type, init),
    );
  });
}

/** Hovers the trigger and advances past the 200ms dwell; flushes the probe. */
async function openByHover(): Promise<void> {
  firePointer(triggerWrapper(), "pointerover", 900, 10);
  act(() => {
    vi.advanceTimersByTime(200);
  });
  await flush();
}

/** Leaves the trigger toward far-away coords (outside any panel rect). */
function leaveTrigger(clientX: number, clientY: number): void {
  firePointer(triggerWrapper(), "pointerout", clientX, clientY);
}

function panel(): Element | null {
  return document.querySelector('[role="menu"]');
}

/** The card's MenuRow buttons; labels are the second span (glyph first). */
function rowLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')].map(
    (b) => b.children[1]?.textContent ?? "",
  );
}

function rowByLabel(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')].find(
    (b) => b.children[1]?.textContent === label,
  );
}

/** Lets pending promises (the availability probe) settle into state. */
async function flush(): Promise<void> {
  await act(async () => {});
}

beforeEach(() => {
  vi.useFakeTimers();
  backendMock.getProjectOpenAvailability.mockReset();
  backendMock.getProjectOpenAvailability.mockReturnValue(new Promise(() => {}));
  backendMock.openProject.mockReset();
  backendMock.openProject.mockResolvedValue(undefined);
  backendMock.getRemoteVsCodeTarget.mockReset();
  backendMock.getRemoteVsCodeTarget.mockReturnValue(new Promise(() => {}));
  backendMock.openRemoteVsCode.mockReset();
  backendMock.openRemoteVsCode.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  if (originalMatchMedia === undefined) Reflect.deleteProperty(window, "matchMedia");
  else Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("CornerTools (issue #1021)", () => {
  it("renders no trigger when no project is registered", () => {
    render({ projects: [], instances: [], tabs: [] });
    expect(document.querySelector(`button[aria-label="${TRIGGER_LABEL}"]`)).toBeNull();
  });

  it("names the focused project and opens its checkout; close-before-run", async () => {
    backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: true, terminal: true });
    render();
    await openByHover();
    expect(panel()?.getAttribute("aria-label")).toBe("tools for bravo");
    const row = rowByLabel("Open in VS Code");
    expect(row).toBeDefined();
    act(() => row!.click());
    expect(backendMock.openProject).toHaveBeenCalledExactlyOnceWith("/b", "vscode");
    // The card never outlives the pick it committed.
    expect(panel()).toBeNull();
  });

  it("shows only Files when VS Code and terminal are unavailable, and probes once per mount", async () => {
    backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: false, terminal: false });
    render();
    await openByHover();
    expect(rowLabels().filter((label) => label.startsWith("Open in"))).toEqual(["Open in Files"]);
    // Close by leaving (unpinned hover card), then re-open: no second probe.
    leaveTrigger(5, 200);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(panel()).toBeNull();
    await openByHover();
    expect(backendMock.getProjectOpenAvailability).toHaveBeenCalledTimes(1);
    expect(rowLabels().filter((label) => label.startsWith("Open in"))).toEqual(["Open in Files"]);
  });

  it("hovers open at 200ms, grace-closes at 400ms, and a click pins", async () => {
    render();
    firePointer(triggerWrapper(), "pointerover", 900, 10);
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(panel()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(panel()).not.toBeNull();
    // Unpinned: leaving starts the grace close at +400ms, not before.
    leaveTrigger(5, 200);
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(panel()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(panel()).toBeNull();
    // A click pins: hover-outs no longer close it.
    act(() => trigger().click());
    expect(panel()).not.toBeNull();
    leaveTrigger(5, 200);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(panel()).not.toBeNull();
  });

  it("offers the Remote-SSH row only when enabled, disabled with the reason", async () => {
    const remoteTab = [tabInfo({ tabId: "r1", projectCwd: "/remote/r", instanceId: "inst-1" })];
    render({ projects: [], tabs: remoteTab });
    await openByHover();
    // Disabled feature: no open rows at all, and no local probe either.
    expect(rowLabels().filter((label) => label.startsWith("Open in"))).toEqual([]);
    expect(backendMock.getProjectOpenAvailability).not.toHaveBeenCalled();
    // Swap to the enabled setting: unmount first so one trigger exists.
    act(() => root!.unmount());
    root = null;
    vi.clearAllMocks();
    render({ projects: [], tabs: remoteTab, remoteVsCode: true });
    backendMock.getRemoteVsCodeTarget.mockResolvedValue({ kind: "unavailable", reason: "sshClosed", address: "box-a" });
    await openByHover();
    const row = rowByLabel("Open in VS Code");
    expect(row).toBeDefined();
    expect(row!.disabled).toBe(true);
    // remotevscode.reason.sshClosed with {at} interpolated from the address.
    expect(row!.title).toBe("SSH port 22 did not answer on box-a");
  });

  it("stays hidden in the compact shell", () => {
    render({ compact: true });
    expect(document.querySelector(`button[aria-label="${TRIGGER_LABEL}"]`)).toBeNull();
  });

  it("keeps the card open while the pointer crosses the trigger→panel gap", async () => {
    render();
    await openByHover();
    const card = panel()!;
    // jsdom rects are all-zero; pin the card under the pointer's path.
    Object.defineProperty(card, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({ left: 300, top: 40, right: 500, bottom: 240, width: 200, height: 200, x: 300, y: 40, toJSON: () => ({}) }) as DOMRect,
    });
    // (400, 45) sits inside the panel rect plus slack: gap crossing, no close.
    leaveTrigger(400, 45);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(panel()).not.toBeNull();
    // A genuine leave (outside the expanded rect) still grace-closes at 400.
    leaveTrigger(5, 300);
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(panel()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(panel()).toBeNull();
  });
});
