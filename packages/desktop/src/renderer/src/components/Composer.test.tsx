// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendState, rpcTabState } from "../test/fixtures";
import { emptySessionRuntime } from "../lib/rpc-types";
import { markerItem, noticeItem } from "../lib/transcript";

const clipboardImageMock = vi.hoisted(() => ({
  hasClipboardImage: vi.fn(() => false),
  readClipboardImages: vi.fn(),
  readImageFiles: vi.fn(),
}));

vi.mock("../lib/clipboard-image", () => clipboardImageMock);

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, hence no scrollIntoView; the slash palette calls it on
// the active row exactly like CommandPalette and ModelSelector do.
HTMLElement.prototype.scrollIntoView = vi.fn();
class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

const backendMock = {
  listProjectFiles: vi.fn(async () => ({ files: [], truncated: false })),
  resolveFileMentions: vi.fn(async () => ({ contextText: "", images: [] })),
  listBranches: vi.fn(async () => ({
    repoRoot: null,
    current: null,
    branches: [],
    defaultBranch: null,
    upstreamRef: null,
    upstreamRemote: null,
    hasUpstream: false,
    ahead: 0,
    behind: 0,
    upstreamFetchedAt: null,
    upstreamRefreshError: null,
  })),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  setSessionAdvisor: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { Composer } = await import("./Composer");
const { RpcTab } = await import("./RpcTab");


const IMAGE_ONE = { type: "image" as const, data: "one", mimeType: "image/png" };
const IMAGE_TWO = { type: "image" as const, data: "two", mimeType: "image/jpeg" };
const TAB = "tab-compose";
const sendPrompt = vi.fn(async () => {});
const abortAndPrompt = vi.fn(async () => {});
const abortAgent = vi.fn(async () => {});
const runSlashCommand = vi.fn(async () => {});
let root: Root | null = null;

const state = backendState({
  projects: [{ project: { path: "/p", name: "P", addedAt: "t", lastModel: null, lastAdvisorModel: null }, sessions: [{
    tabId: TAB, sessionId: "s", lineageDir: "lineage", projectCwd: "/p", launchedAt: "t", mode: "rpc-ui",
    advisor: false, advisorModel: null, cachedTitle: "Compose", cachedModified: "t", title: "Compose", status: "complete", live: "live",
  }] }],
});

function seed(status: "starting" | "ready" | "running", dead = false): void {
  useStore.setState({
    advisorDefaults: {},
    state,
    exited: dead ? { [TAB]: 0 } : {},
    branches: {
      "/p": {
        repoRoot: null,
        current: null,
        branches: [],
        defaultBranch: null,
        upstreamRef: null,
        upstreamRemote: null,
        hasUpstream: false,
        ahead: 0,
        behind: 0,
        upstreamFetchedAt: null,
        upstreamRefreshError: null,
      },
    },
    rpc: { [TAB]: rpcTabState({
      status,
      model: { id: "model-x", name: "Model X", provider: "test", input: ["text"], contextWindow: 1000 },
      session: { ...emptySessionRuntime(), thinkingLevel: "medium" },
      hasRenamed: true,
    }) },
    compactSurface: null, sendPrompt, abortAndPrompt, abortAgent,
  });
}

function renderComposer(): void {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(<Composer tabId={TAB} />));
}

function renderRpcTab(): void {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(<RpcTab tabId={TAB} active={false} />));
}

function typeDraft(value: string): HTMLTextAreaElement {
  const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(textarea, value); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  return textarea;
}

function imagePicker(): HTMLInputElement {
  return document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
}

function modeSegments(): HTMLButtonElement[] {
  const group = document.body.querySelector<HTMLElement>(
    '[role="group"][aria-label="session mode"]',
  )!;
  return [...group.querySelectorAll<HTMLButtonElement>("button")];
}

function modeSegment(name: "build" | "plan"): HTMLButtonElement {
  return modeSegments().find((button) => button.textContent?.trim() === name)!;
}


function choose(input: HTMLInputElement, files: File[], value: string): void {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  Object.defineProperty(input, "value", { configurable: true, writable: true, value });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  vi.clearAllMocks();
  clipboardImageMock.hasClipboardImage.mockReset().mockReturnValue(false);
  clipboardImageMock.readClipboardImages.mockReset();
  clipboardImageMock.readImageFiles.mockReset().mockResolvedValue({ images: [], rejected: [] });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("compact Composer", () => {
  it("sends the idle draft through prompt, clears, and refocuses", async () => {
    seed("ready"); renderComposer();
    const textarea = typeDraft("mobile sentinel");
    const send = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Send")!;
    await act(async () => send.click());
    expect(sendPrompt).toHaveBeenCalledWith(TAB, "mobile sentinel", "prompt", []);
    expect(textarea.value).toBe("");
    expect(document.activeElement).toBe(textarea);
  });

  it("keeps steer and abort primary while queue routes stay in options", async () => {
    seed("running"); renderComposer();
    typeDraft("running draft");
    const byText = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;
    expect(byText("Steer")).toBeDefined();
    expect(byText("Abort")).toBeDefined();
    act(() => document.body.querySelector<HTMLButtonElement>('button[title="prompt options"]')!.click());
    await act(async () => byText("Queue").click());
    expect(sendPrompt).toHaveBeenCalledWith(TAB, "running draft", "follow_up", []);

    typeDraft("replace turn");
    await act(async () => byText("Interrupt-and-send").click());
    expect(abortAndPrompt).toHaveBeenCalledWith(TAB, "replace turn", []);
  });

  it("marks the active effort and plan state in the options sheet", () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: { [TAB]: { ...s.rpc[TAB]!, model: { ...s.rpc[TAB]!.model!, thinking: { efforts: ["low", "medium", "high"] } } } },
    }));
    renderComposer();
    act(() => document.body.querySelector<HTMLButtonElement>('button[title="prompt options"]')!.click());
    const byText = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;
    expect(byText("medium").getAttribute("aria-pressed")).toBe("true");
    expect(byText("low").getAttribute("aria-pressed")).toBe("false");
    expect(byText("high").getAttribute("aria-pressed")).toBe("false");
    expect(modeSegment("plan").getAttribute("aria-pressed")).toBe("false");
    const sheet = document.body.querySelector<HTMLElement>('[aria-label="prompt options"]')!;
    expect(sheet.querySelector(".prompt-options")).not.toBeNull();
    expect(sheet.querySelector(".w-full")?.textContent).toContain("advisor");
  });

  it("loops the copper ring around the compact input box while busy", () => {
    seed("running");
    useStore.setState((s) => ({ rpc: { [TAB]: { ...s.rpc[TAB]!, busy: true } } }));
    renderComposer();
    const box = document.body.querySelector("textarea")!.parentElement!.parentElement!;
    const ring = box.querySelector("svg.text-copper")!;
    expect(ring).not.toBeNull();
    expect(ring.querySelector("path[stroke-dasharray]")).not.toBeNull();
  });
});

describe("Composer relaunch handoff", () => {
  it("disables every process control while starting and restores them when ready", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    seed("ready");
    renderComposer();
    typeDraft("send after restart");

    act(() => useStore.setState((state) => ({
      rpc: { ...state.rpc, [TAB]: { ...state.rpc[TAB]!, status: "starting" } },
    })));

    const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>("button")];
    const model = document.body.querySelector<HTMLButtonElement>('button[title="model-x"]')!;
    const thinking = buttons.find((button) => button.title.startsWith("thinking level"))!;
    const advisor = buttons.find((button) => button.title.startsWith("advisor off"))!;
    const build = modeSegment("build");
    const plan = modeSegment("plan");
    const attach = document.body.querySelector<HTMLButtonElement>('button[title="attach images"]')!;
    const send = buttons.find((button) => button.textContent?.trim() === "send")!;
    expect([textarea, model, thinking, advisor, build, plan, attach, send].every((el) => el.disabled)).toBe(true);

    act(() => useStore.setState((state) => ({
      rpc: { ...state.rpc, [TAB]: { ...state.rpc[TAB]!, status: "ready" } },
    })));
    expect([textarea, model, thinking, advisor, build, plan, attach, send].every((el) => !el.disabled)).toBe(true);
  });
});

describe("Composer advisor model palette", () => {
  it("opens on the current provider and resets to the configured advisor through the restart path", async () => {
    const ADVISOR = { id: "advisor-a", name: "Advisor A", provider: "p" };
    const DEFAULT = { id: "default", name: "Default Advisor", provider: "q" };
    seed("ready");
    useStore.setState((s) => ({
      state: {
        ...s.state!,
        projects: s.state!.projects.map((group) => ({
          ...group,
          sessions: group.sessions.map((session) =>
            session.tabId === TAB
              ? { ...session, advisor: true, advisorModel: "p/advisor-a" }
              : session,
          ),
        })),
      },
      advisorDefaults: { "/p": { enabled: true, model: "q/default" } },
      rpc: {
        ...s.rpc,
        [TAB]: { ...s.rpc[TAB]!, availableModels: [ADVISOR, DEFAULT] },
      },
    }));
    renderComposer();
    act(() => document.body.querySelector<HTMLButtonElement>('button[title="prompt options"]')!.click());
    const advisorButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Advisor A",
    )!;
    await act(async () => advisorButton.click());

    const overlays = document.body.querySelectorAll<HTMLElement>("[data-overlay-root]");
    const palette = overlays[overlays.length - 1]!;
    expect(palette.querySelector<HTMLButtonElement>('button[title="p"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(palette.textContent).toContain("use omp's configured advisor");
    expect(palette.textContent).toContain("picking one restarts this session and resumes it");

    const configured = [...palette.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("use omp's configured advisor"),
    )!;
    await act(async () => configured.click());
    expect(backendMock.setSessionAdvisor).toHaveBeenCalledWith(TAB, true, null, false);
  });
});

describe("RpcTab failure presentation", () => {
  it("shows one canonical timeout banner and dismisses it locally", () => {
    seed("ready");
    const failure = {
      message: 'RPC command "prompt" timed out after its 30.0s response budget',
      kind: "command" as const,
      fatal: false,
      command: "prompt",
      timeoutMs: 30_000,
      sessionStatus: "ready" as const,
      liveState: "live" as const,
      recovery:
        "Prompt-like commands may still complete in the live session. Refresh state before continuing; resending can duplicate work.",
    };
    useStore.setState((s) => ({
      rpc: { ...s.rpc, [TAB]: { ...s.rpc[TAB]!, failure } },
    }));
    renderRpcTab();

    expect(document.body.textContent!.split(failure.message).length - 1).toBe(1);
    expect(document.body.textContent).toContain("resending can duplicate work");
    expect([...document.body.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(
      expect.arrayContaining(["Copy", "Refresh state", "Dismiss"]),
    );

    const dismiss = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Dismiss",
    )!;
    act(() => dismiss.click());
    expect(document.body.textContent).not.toContain(failure.message);
    expect(useStore.getState().rpc[TAB]!.failure).toBe(failure);

    act(() => useStore.setState((s) => ({
      rpc: { ...s.rpc, [TAB]: { ...s.rpc[TAB]!, failure: { ...failure } } },
    })));
    expect(document.body.textContent).toContain(failure.message);
  });

  it("offers retry boot rather than nonfatal recovery actions for a boot failure", () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: {
        ...s.rpc,
        [TAB]: {
          ...s.rpc[TAB]!,
          status: "error",
          failure: {
            message: "RPC boot failed",
            kind: "boot",
            fatal: true,
            recovery: "Retry boot to reconnect to the live session.",
          },
        },
      },
    }));
    renderRpcTab();

    const actions = [...document.body.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(actions).toEqual(expect.arrayContaining(["Copy", "Retry boot"]));
    expect(actions).not.toContain("Refresh state");
    expect(actions).not.toContain("Dismiss");
  });
});

describe("Composer attachment picker", () => {
  it("exposes a compact, multi-image picker control with a 44px hit target", () => {
    seed("ready"); renderComposer();
    const input = imagePicker();
    const button = document.body.querySelector<HTMLButtonElement>('button[title="attach images"]')!;
    const click = vi.spyOn(input, "click");

    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
    expect(input.classList.contains("sr-only")).toBe(true);
    expect(button.classList.contains("min-h-11")).toBe(true);
    expect(button.classList.contains("min-w-11")).toBe(true);
    act(() => button.click());
    expect(click).toHaveBeenCalledOnce();
  });

  it("appends multiple picker images to the send payload in order", async () => {
    clipboardImageMock.readImageFiles.mockResolvedValueOnce({
      images: [IMAGE_ONE, IMAGE_TWO],
      rejected: [],
    });
    seed("ready"); renderComposer();
    const first = new File(["one"], "one.png", { type: "image/png" });
    const second = new File(["two"], "two.jpg", { type: "image/jpeg" });

    await act(async () => {
      choose(imagePicker(), [first, second], "chosen-images");
      await Promise.resolve();
    });
    typeDraft("compare these");
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Send")!
        .click();
    });

    expect(clipboardImageMock.readImageFiles).toHaveBeenCalledWith([first, second]);
    expect(sendPrompt).toHaveBeenCalledWith(TAB, "compare these", "prompt", [IMAGE_ONE, IMAGE_TWO]);
  });

  it("resets the input immediately so the same image can be selected again", async () => {
    clipboardImageMock.readImageFiles
      .mockResolvedValueOnce({ images: [IMAGE_ONE], rejected: [] })
      .mockResolvedValueOnce({ images: [IMAGE_ONE], rejected: [] });
    seed("ready"); renderComposer();
    const input = imagePicker();
    const file = new File(["one"], "one.png", { type: "image/png" });

    await act(async () => {
      choose(input, [file], "first-selection");
      expect(input.value).toBe("");
      await Promise.resolve();
    });
    await act(async () => {
      choose(input, [file], "same-file-selection");
      expect(input.value).toBe("");
      await Promise.resolve();
    });

    expect(clipboardImageMock.readImageFiles).toHaveBeenNthCalledWith(1, [file]);
    expect(clipboardImageMock.readImageFiles).toHaveBeenNthCalledWith(2, [file]);
    expect(document.body.querySelectorAll('img[alt^="attachment "]')).toHaveLength(2);
  });

  it("shows picker rejections without adding an image payload", async () => {
    clipboardImageMock.readImageFiles.mockResolvedValueOnce({
      images: [],
      rejected: ["broken.png could not be read"],
    });
    seed("ready"); renderComposer();
    const broken = new File(["broken"], "broken.png", { type: "image/png" });

    await act(async () => {
      choose(imagePicker(), [broken], "rejected-selection");
      await Promise.resolve();
    });
    expect(imagePicker().value).toBe("");
    expect(document.body.textContent).toContain("broken.png could not be read");

    typeDraft("continue without it");
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Send")!
        .click();
    });
    expect(sendPrompt).toHaveBeenCalledWith(TAB, "continue without it", "prompt", []);
  });

  it("disables picker access for a dead session", () => {
    seed("ready", true); renderComposer();
    expect(imagePicker().disabled).toBe(true);
    expect(document.body.querySelector<HTMLButtonElement>('button[title="attach images"]')!.disabled).toBe(true);
  });
});

describe("Composer action row overflow", () => {
  it("compresses identity controls and keeps running actions whole", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    seed("running");
    useStore.setState((s) => ({
      state: {
        ...s.state!,
        projects: s.state!.projects.map((group) => ({
          ...group,
          sessions: group.sessions.map((session) =>
            session.tabId === TAB
              ? { ...session, advisor: true, advisorModel: "p/advisor-model" }
              : session,
          ),
        })),
      },
      rpc: {
        ...s.rpc,
        [TAB]: {
          ...s.rpc[TAB]!,
          model: { id: "model-x", name: "An unreasonably long model display name", provider: "test", input: ["text"], contextWindow: 1000 },
          availableModels: [{ id: "model-x", name: "An unreasonably long model display name", provider: "test", input: ["text"], contextWindow: 1000 }],
        },
      },
    }));
    renderComposer();

    const row = document.querySelector('button[title="abort the agent (esc)"]')!.parentElement!;
    const byTitle = (prefix: string): HTMLButtonElement =>
      row.querySelector<HTMLButtonElement>(`button[title^="${prefix}"]`)!;

    const modelCapsule = row.firstElementChild as HTMLElement;
    expect(modelCapsule.classList.contains("shrink")).toBe(true);
    expect(modelCapsule.classList.contains("shrink-0")).toBe(false);
    expect(modelCapsule.querySelector("span.truncate")!.classList.contains("min-w-0")).toBe(true);
    expect(byTitle("thinking level").classList.contains("shrink-0")).toBe(true);

    expect(byTitle("queue this").classList.contains("shrink-0")).toBe(true);
    expect(byTitle("inject this").classList.contains("shrink-0")).toBe(true);
    expect(byTitle("abort the agent").classList.contains("shrink-0")).toBe(true);

    const interrupt = byTitle("abort the current turn");
    expect(interrupt.classList.contains("shrink")).toBe(true);
    expect(interrupt.classList.contains("min-w-0")).toBe(true);
    expect(interrupt.querySelector("span.truncate")!.classList.contains("min-w-0")).toBe(true);
  });
});

describe("Composer focus treatment", () => {
  it("uses Tailwind's important outline suppression on the textarea", () => {
    seed("ready"); renderComposer();
    expect(document.body.querySelector("textarea")?.classList.contains("outline-none!")).toBe(true);
  });

  it("focuses the textarea on mount so a new session is ready to type", () => {
    seed("ready");
    renderComposer();
    expect(document.activeElement).toBe(document.body.querySelector("textarea"));
  });

  it("reclaims focus when the overlay that spawned the session closes (#102)", async () => {
    // The composer mounts while a sheet holds #root inert. jsdom ignores inert, so
    // simulate the reported aftermath — focus pulled back to the overlay trigger —
    // then tear the sheet down and assert the composer reclaims the caret.
    const rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.append(rootEl);
    rootEl.setAttribute("inert", "");
    seed("ready");
    renderComposer();
    const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    const trigger = document.createElement("button");
    document.body.append(trigger);
    act(() => trigger.focus());
    expect(document.activeElement).toBe(trigger);
    // Overlay teardown; `await act` flushes the MutationObserver microtask.
    await act(async () => rootEl.removeAttribute("inert"));
    expect(document.activeElement).toBe(textarea);
    trigger.remove();
  });
});

describe("Composer BuildPlanControl", () => {
  const setPlanMode = vi.fn(async () => {});
  const runSlashCommand = vi.fn(async () => {});


  beforeEach(() => {
    // The suite-wide beforeEach forces the compact shell; these exercise the
    // desktop control row.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState({ setPlanMode, runSlashCommand });
  });

  it("selects Build and unselects Plan when plan mode is disabled", () => {
    seed("ready");
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          plan: { enabled: false, planFilePath: null, planAbsPath: null, approved: false },
        },
      },
    });
    renderComposer();
    expect(modeSegment("build").getAttribute("aria-pressed")).toBe("true");
    expect(modeSegment("plan").getAttribute("aria-pressed")).toBe("false");
  });

  it("orders the safe default as Plan then Build (issue #141)", () => {
    seed("ready");
    renderComposer();
    expect(
      modeSegments().map((button) => button.textContent?.trim()),
    ).toEqual(["plan", "build"]);
  });

  it("puts a Build default first and accents alternate Plan when selected (issue #143)", () => {
    seed("ready");
    useStore.setState((s) => ({
      state: { ...s.state!, defaultAgentMode: "build" },
      rpc: {
        ...s.rpc,
        [TAB]: {
          ...s.rpc[TAB]!,
          plan: { enabled: false, planFilePath: null, planAbsPath: null, approved: false },
        },
      },
    }));
    renderComposer();

    expect(
      modeSegments().map((button) => button.textContent?.trim()),
    ).toEqual(["build", "plan"]);
    expect(modeSegment("build").className).not.toContain("bg-iris-wash");

    act(() => useStore.setState((s) => ({
      rpc: {
        ...s.rpc,
        [TAB]: {
          ...s.rpc[TAB]!,
          plan: { enabled: true, planFilePath: null, planAbsPath: null, approved: false },
        },
      },
    })));
    expect(modeSegment("plan").className).toContain("bg-iris-wash");
  });

  it("gives Build, not Plan, the stronger active emphasis (issue #141)", () => {
    seed("ready");
    renderComposer();
    expect(modeSegment("build").className).toContain("bg-iris-wash");
    expect(modeSegment("plan").className).not.toContain("bg-iris-wash");
  });

  it("selects Plan and reclaims the textarea caret", () => {
    seed("ready");
    renderComposer();
    const plan = modeSegment("plan");
    act(() => plan.focus());
    expect(document.activeElement).toBe(plan);
    act(() => plan.click());
    expect(setPlanMode).toHaveBeenCalledWith(TAB, true);
    expect(document.activeElement).toBe(document.body.querySelector("textarea"));
  });

  it("selects Plan and unselects Build when plan mode is enabled", () => {
    seed("ready");
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          plan: { enabled: true, planFilePath: "local://x-plan.md", planAbsPath: "/x-plan.md", approved: false },
        },
      },
    });
    renderComposer();
    expect(modeSegment("plan").getAttribute("aria-pressed")).toBe("true");
    expect(modeSegment("build").getAttribute("aria-pressed")).toBe("false");
  });

  it("selects Build from Plan mode", () => {
    seed("ready");
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          plan: { enabled: true, planFilePath: "local://x-plan.md", planAbsPath: "/x-plan.md", approved: false },
        },
      },
    });
    renderComposer();
    act(() => modeSegment("build").click());
    expect(setPlanMode).toHaveBeenCalledWith(TAB, false);
  });

  it("does not transition an already-selected segment and still reclaims focus", () => {
    seed("ready");
    renderComposer();
    const build = modeSegment("build");
    act(() => build.focus());
    expect(document.activeElement).toBe(build);
    act(() => build.click());
    expect(setPlanMode).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body.querySelector("textarea"));
  });

  it("disables only unavailable Plan while keeping Build selected", () => {
    seed("ready");
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          plan: {
            enabled: false,
            planFilePath: null,
            planAbsPath: null,
            approved: false,
            unavailable: "no active omp session",
          },
        },
      },
    });
    renderComposer();
    const build = modeSegment("build");
    const plan = modeSegment("plan");
    expect(build.getAttribute("aria-pressed")).toBe("true");
    expect(build.disabled).toBe(false);
    expect(plan.getAttribute("aria-pressed")).toBe("false");
    expect(plan.disabled).toBe(true);
    expect(plan.title).toBe("plan mode unavailable: no active omp session");
  });

  it("shows one canonical plan row in the palette and runs it", () => {
    seed("ready");
    // omp's TUI-only `plan` and the extension's driver command are both
    // filtered out of the palette; only the omp-ui entry remains.
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          commands: [
            { name: "plan", description: "tui only", source: "builtin" },
            { name: "omp-ui-plan", description: "driver", source: "extension" },
          ],
        },
      },
    });
    renderComposer();
    typeDraft("/plan");
    const rows = [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
      b.textContent?.includes("/plan"),
    );
    expect(rows).toHaveLength(1);
    expect(document.body.textContent).not.toContain("omp-ui-plan");
    act(() => rows[0]!.click());
    expect(runSlashCommand).toHaveBeenCalledWith(TAB, "/plan");
  });
});

describe("Composer width refit", () => {
  it("re-fits when the box width changes without a text change", () => {
    let ro: (() => void) | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: ResizeObserverCallback) {
        ro = () => cb([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
    });
    seed("ready"); renderComposer();
    const el = document.body.querySelector("textarea")!;
    // jsdom has no layout; supply the metrics fit() reads.
    el.style.lineHeight = "20px";
    el.style.paddingTop = "8px";
    el.style.paddingBottom = "8px";
    let width = 200;
    let scroll = 3 * 20 + 16; // three rows of content
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => width });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scroll });
    act(() => ro!());
    expect(el.style.height).toBe("76px");      // grows to fit
    expect(el.style.overflowY).toBe("hidden");
    // The same draft re-wraps far past the 12-row cap after a width change.
    width = 100;
    scroll = 30 * 20 + 16;
    act(() => ro!());
    expect(el.style.height).toBe("256px");     // 12 * 20 + 16: capped
    expect(el.style.overflowY).toBe("auto");   // now scrollable
  });
});

describe("Composer onPrompt", () => {
  beforeEach(() => {
    useStore.setState({ runSlashCommand });
  });

  function renderWithPrompt(spy: () => void): void {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<Composer tabId={TAB} onPrompt={spy} />));
  }

  it("fires once for a plain draft", async () => {
    const spy = vi.fn();
    seed("ready"); renderWithPrompt(spy);
    typeDraft("do the thing");
    const send = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Send")!;
    await act(async () => send.click());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not fire for a slash command", async () => {
    const spy = vi.fn();
    seed("ready"); renderWithPrompt(spy);
    typeDraft("/compact");
    const run = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Run")!;
    await act(async () => run.click());
    expect(spy).not.toHaveBeenCalled();
    expect(runSlashCommand).toHaveBeenCalledTimes(1);
  });

  it("does not fire for an empty draft", async () => {
    const spy = vi.fn();
    seed("ready"); renderWithPrompt(spy);
    const send = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Send")!;
    await act(async () => send.click());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("RpcTab hero", () => {
  function desktop(): void {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  }

  it("shows the greeting for a fresh ready session", () => {
    seed("ready");
    desktop(); renderRpcTab();
    expect(document.body.textContent).toContain("What's next");
    expect(document.body.querySelector("textarea")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Nothing yet");
  });

  it("keeps the hero for ambient-only items and renders them in the footer", () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: { ...s.rpc, [TAB]: { ...s.rpc[TAB]!, items: [noticeItem("xd:// mounted"), markerItem("THINKING LEVEL")] } },
    }));
    desktop(); renderRpcTab();
    expect(document.body.textContent).toContain("What's next");
    expect(document.body.textContent).toContain("xd:// mounted");
    expect(document.body.textContent).toContain("THINKING LEVEL");
  });

  it("docks from first render when an exchange exists", () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: { ...s.rpc, [TAB]: { ...s.rpc[TAB]!, items: [{ kind: "user" as const, id: "u1", text: "hello" }] } },
    }));
    desktop(); renderRpcTab();
    expect(document.body.textContent).not.toContain("What's next");
    expect(document.body.textContent).toContain("hello");
  });

  it("latches on the first local prompt with no items arriving", async () => {
    seed("ready");
    desktop(); renderRpcTab();
    typeDraft("ship it");
    const send = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "send")!;
    await act(async () => send.click());
    expect(document.body.textContent).not.toContain("What's next");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("never shows the hero in the compact shell", () => {
    seed("ready"); renderRpcTab();
    expect(document.body.textContent).not.toContain("What's next");
  });

  it("does not show the hero for an exited session", () => {
    seed("ready", true);
    desktop(); renderRpcTab();
    expect(document.body.textContent).not.toContain("What's next");
  });

  it("centers the composer during boot with the skeleton above it", () => {
    seed("starting");
    desktop(); renderRpcTab();
    expect(document.body.querySelectorAll(".animate-pulse").length).toBe(3);
    expect(document.body.querySelector("textarea")).not.toBeNull();
    expect(document.body.textContent).not.toContain("What's next");
    // hero spacer below the composer => centered geometry
    expect(document.body.querySelector('[class*="flex-[0.85]"]')).not.toBeNull();
  });

  it("keeps the centered boot layout when ambient notices stream in", () => {
    seed("starting");
    useStore.setState((s) => ({
      rpc: { ...s.rpc, [TAB]: { ...s.rpc[TAB]!, items: [noticeItem("xd:// mounted")] } },
    }));
    desktop(); renderRpcTab();
    expect(document.body.querySelectorAll(".animate-pulse").length).toBe(3);
    expect(document.body.textContent).toContain("xd:// mounted");
    expect(document.body.querySelector('[class*="flex-[0.85]"]')).not.toBeNull();
  });

  it("keeps the boot skeleton docked in the compact shell", () => {
    seed("starting"); renderRpcTab(); // no desktop() mock => compact shell
    expect(document.body.querySelectorAll(".animate-pulse").length).toBe(3);
    expect(document.body.querySelector('[class*="flex-[0.85]"]')).toBeNull();
  });
});

describe("desktop Composer running sweep", () => {
  it("keeps the copper sweep on the card after prompt RPC busy clears", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    seed("running");
    renderComposer();
    const card = document.body.querySelector(".shadow-float")!;
    const ring = card.querySelector("svg.text-copper")!;
    expect(ring).not.toBeNull();
    expect(ring.querySelector("path[stroke-dasharray]")).not.toBeNull();
  });
});

describe("Composer keyword glow", () => {
  it("runs the armed keyword's ring around the box, phase-locked palette", () => {
    seed("ready"); renderComposer();
    typeDraft("please orchestrate this");
    const glow = document.body.querySelector<HTMLElement>("[data-perimeter-glow]");
    expect(glow).not.toBeNull();
    // orchestrate's hue origin — the ring is the keyword's own palette.
    expect(glow!.style.getPropertyValue("--perimeter-glow")).toContain("hsl(150 90% 62%)");
  });

  it("shows no ring for plain prose or a masked keyword", () => {
    seed("ready"); renderComposer();
    typeDraft("plain text");
    expect(document.body.querySelector("[data-perimeter-glow]")).toBeNull();
    typeDraft("fix `orchestrate` now");
    expect(document.body.querySelector("[data-perimeter-glow]")).toBeNull();
  });
});
