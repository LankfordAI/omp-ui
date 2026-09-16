// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserPaneFrameHeader } from "@omp-ui/core/browser-pane";
import type { ProjectGroup, SessionSummary } from "@omp-ui/core/types";
import { backendState, remoteInstance, rpcTabState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  electron: false,
  header: { width: 1280, height: 800, dsf: 1 } as BrowserPaneFrameHeader | null,
  observers: [] as ((entries: { contentRect: { width: number; height: number } }[]) => void)[],
}));

vi.mock("../../lib/platform", () => ({
  get IS_ELECTRON() {
    return mocks.electron;
  },
  IS_MAC: false,
  IS_WINDOWS: false,
}));

// jsdom has no 2d context or createImageBitmap; the painter's own contract is
// covered by the frame lib. Here it only answers "which frame is on screen".
vi.mock("../../lib/browser-pane-frame", () => ({
  createFramePainter: () => ({
    write() {},
    lastJpeg: () => new Uint8Array([0xff, 0xd8]),
    header: () => mocks.header,
    dispose() {},
  }),
}));

class ResizeObserverStub {
  constructor(cb: (entries: { contentRect: { width: number; height: number } }[]) => void) {
    mocks.observers.push(cb);
  }
  observe() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

const ompBackend = {
  browserPaneEnsure: vi.fn(async () => ({ status: "not-live" as const })),
  browserPaneSubscribe: vi.fn(),
  browserPaneResize: vi.fn(),
  browserPaneInput: vi.fn(),
  browserPaneNavigate: vi.fn(),
};
Object.assign(window, { ompBackend });
// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../../store");
const { BrowserPane } = await import("./BrowserPane");

const TAB = "tab-browser";
const INSTANCE = "inst-remote";

const session: SessionSummary = {
  tabId: TAB,
  sessionId: "s",
  lineageDir: "lineage",
  projectCwd: "/remote/p",
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
  cachedTitle: "Remote session",
  cachedModified: "t",
  title: "Remote session",
  status: "complete",
  live: "live",
  pendingPlan: null,
  planSettle: null,
  streamStalled: false,
};

const group: ProjectGroup = {
  project: {
    path: "/remote/p",
    name: "P",
    addedAt: "t",
    lastModel: null,
    lastThinkingLevel: null,
    lastAdvisor: null,
    lastAdvisorModel: null,
    defaultModel: null,
    defaultAdvisorModel: null,
  },
  sessions: [session],
};

/** The tab under a remote instance in the given status; local when null. */
function seed(instanceStatus: "joined" | "unreachable" | null): void {
  useStore.setState({
    state: backendState(
      instanceStatus === null
        ? { projects: [group] }
        : { projects: [], remoteInstances: [remoteInstance({ id: INSTANCE, status: instanceStatus, projects: [group] })] },
    ),
    activeTabId: TAB,
    rpc: {
      [TAB]: rpcTabState({
        browserPane: {
          open: true,
          fullscreen: false,
          ensure: "available",
          unavailableReason: null,
          state: {
            url: "https://localhost:5173/",
            title: "app",
            loading: false,
            canGoBack: true,
            canGoForward: false,
            alive: true,
            agent: "attached",
          },
          frame: { width: 1280, height: 800, dsf: 1 },
        },
      }),
    },
  });
}

let root: Root | null = null;

function render(): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<BrowserPane tabId={TAB} posture="split" />));
}

const canvas = (): HTMLCanvasElement => document.body.querySelector("canvas")!;
const proxy = (): HTMLInputElement => document.body.querySelector('input[aria-hidden="true"]')!;
const button = (label: string): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

function pointerDown(): void {
  const event = new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1 });
  Object.defineProperty(event, "offsetX", { value: 10 });
  Object.defineProperty(event, "offsetY", { value: 20 });
  act(() => canvas().dispatchEvent(event));
}

/** Everything the pane can send toward the page, fired once each. */
function exerciseInputs(): void {
  pointerDown();
  act(() => canvas().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120, cancelable: true })));
  act(() => proxy().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" })));
  act(() => button("reload")?.click());
  act(() => mocks.observers.at(-1)?.([{ contentRect: { width: 640.4, height: 400.6 } }]));
}

beforeEach(() => {
  mocks.electron = false;
  mocks.header = { width: 1280, height: 800, dsf: 1 };
  mocks.observers.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("BrowserPane while the owning instance is down (issue #416)", () => {
  it("dims the retained page during an outage and restores visibility on rejoin (#547)", () => {
    seed("joined");
    render();
    expect(getComputedStyle(canvas()).opacity).toBe("1");

    act(() => seed("unreachable"));
    const dimmedOpacity = Number(getComputedStyle(canvas()).opacity);
    expect(dimmedOpacity).toBeGreaterThan(0);
    expect(dimmedOpacity).toBeLessThan(1);

    act(() => seed("joined"));
    expect(getComputedStyle(canvas()).opacity).toBe("1");
  });

  it("sends nothing toward the page, then re-subscribes and forwards input once it rejoins", () => {
    mocks.electron = true;
    seed("unreachable");
    render();

    exerciseInputs();
    expect(ompBackend.browserPaneInput).not.toHaveBeenCalled();
    expect(ompBackend.browserPaneNavigate).not.toHaveBeenCalled();
    expect(ompBackend.browserPaneResize).not.toHaveBeenCalled();
    expect(ompBackend.browserPaneSubscribe).not.toHaveBeenCalled();
    // The toolbar reads as inert, not broken.
    expect(button("reload")?.disabled).toBe(true);

    act(() => seed("joined"));
    expect(ompBackend.browserPaneSubscribe).toHaveBeenCalledTimes(1);
    expect(ompBackend.browserPaneSubscribe).toHaveBeenLastCalledWith(TAB, expect.any(String), true);
    expect(button("reload")?.disabled).toBe(false);

    pointerDown();
    expect(ompBackend.browserPaneInput).toHaveBeenCalledWith(TAB, {
      type: "mouseDown",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
      modifiers: undefined,
    });
    act(() => button("reload")!.click());
    expect(ompBackend.browserPaneNavigate).toHaveBeenCalledWith(TAB, { action: "reload" });
  });
});

describe("BrowserPane viewport sizing (#532)", () => {
  it("reports the box to main only from the desktop renderer", () => {
    seed(null);
    render();
    act(() => mocks.observers.at(-1)?.([{ contentRect: { width: 640.4, height: 400.6 } }]));
    expect(ompBackend.browserPaneResize).not.toHaveBeenCalled();
    act(() => root?.unmount());
    root = null;

    mocks.electron = true;
    render();
    act(() => mocks.observers.at(-1)!([{ contentRect: { width: 640.4, height: 400.6 } }]));
    expect(ompBackend.browserPaneResize).toHaveBeenCalledWith(TAB, 640, 401);
  });
});

describe("BrowserPane IME commits (#550)", () => {
  const compose = (type: string, data: string): void => {
    act(() => proxy().dispatchEvent(new CompositionEvent(type, { bubbles: true, data })));
  };
  const input = (data: string | null, isComposing = false): void => {
    proxy().value = data ?? "";
    act(() => proxy().dispatchEvent(new InputEvent("input", { bubbles: true, data, isComposing })));
  };

  it("forwards the IBus commit after an empty compositionend, not the preedit", () => {
    seed(null);
    render();
    compose("compositionstart", "");
    input("ㅎ", true);
    input("하", true);
    input("한", true);
    input(null, true);
    compose("compositionend", "");
    input("한");
    expect(ompBackend.browserPaneInput.mock.calls).toEqual([[TAB, { type: "insertText", text: "한" }]]);
    expect(proxy().value).toBe("");
  });

  it("does not duplicate a compositionend commit echoed by input, or lose the next equal commit", () => {
    seed(null);
    render();
    for (let i = 0; i < 2; i += 1) {
      compose("compositionstart", "");
      input("한", false);
      compose("compositionend", "한");
      input("한");
    }
    expect(ompBackend.browserPaneInput.mock.calls).toEqual([
      [TAB, { type: "insertText", text: "한" }],
      [TAB, { type: "insertText", text: "한" }],
    ]);
  });

  it("does not send cancelled preedit or replay an outage commit on rejoin", () => {
    seed("joined");
    render();
    compose("compositionstart", "");
    input("한", true);
    compose("compositionend", "");
    input(null);
    act(() => seed("unreachable"));
    compose("compositionstart", "");
    compose("compositionend", "한");
    act(() => seed("joined"));
    input("한");
    expect(ompBackend.browserPaneInput).not.toHaveBeenCalled();
  });
});
