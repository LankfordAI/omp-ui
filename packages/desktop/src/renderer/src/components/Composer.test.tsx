// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList } from "@omp-ui/core/types";
import { backendState, rpcTabState } from "../test/fixtures";
import { emptySessionRuntime, type SlashCommandInfo } from "../lib/rpc-types";
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
  listBranches: vi.fn(async (): Promise<BranchList> => ({
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
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
  setSessionAdvisor: vi.fn(async () => {}),
  convertToWorktree: vi.fn(async () => {}),
  rpcSend: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { Composer } = await import("./Composer");
const { RpcTab } = await import("./RpcTab");


const IMAGE_ONE = { type: "image" as const, data: "one", mimeType: "image/png" };
const IMAGE_TWO = { type: "image" as const, data: "two", mimeType: "image/jpeg" };
const TAB = "tab-compose";
const sendPrompt = vi.fn(async () => true);
const abortAndPrompt = vi.fn(async () => {});
const abortAgent = vi.fn(async () => {});
const runSlashCommand = vi.fn(async () => {});
let root: Root | null = null;

const state = backendState({
  projects: [{ project: { path: "/p", name: "P", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null }, sessions: [{
    tabId: TAB, sessionId: "s", lineageDir: "lineage", projectCwd: "/p", launchedAt: "t", mode: "rpc-ui",
    worktree: null, planImplementationSource: null, agentMode: "build", compactionMethod: null, model: null, thinkingLevel: null, advisor: false, advisorModel: null, cachedTitle: "Compose", cachedModified: "t", title: "Compose", status: "complete", live: "live", pendingPlan: null, planSettle: null, streamStalled: false,
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

function press(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => target.dispatchEvent(event));
  return event;
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

describe("desktop floating Composer card", () => {
  it("fills the floating card with the reading plane, never a raised panel", () => {
    // matches: false → the desktop branch; compact fills the card bg-raised,
    // so passing this assertion also proves the floating geometry was exercised.
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
    const card = document.body.querySelector("textarea")!.parentElement!.parentElement!;
    // ADR-0026: the composer card is a glass plane. Its tone must equal the
    // transcript's reading plane — plane-lit (raised) paints a lighter
    // rectangle over the prose the card now floats above (#396, lineage of
    // #194/#395). The tab root carries ambient grain over bg-surface, so the
    // card keeps ambient too and the grain layers cancel in the comparison.
    expect(card.className).toContain("glass-surface");
    expect(card.className).not.toContain("plane-lit");
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
  it("opens on Favorites and resets to the configured advisor through the restart path", async () => {
    const ADVISOR = { id: "advisor-a", name: "Advisor A", provider: "p" };
    const DEFAULT = { id: "default", name: "Default Advisor", provider: "q" };
    seed("ready");
    useStore.setState((s) => ({
      state: {
        ...s.state!,
        projects: s.state!.projects.map((group) => ({
          ...group,
          project: { ...group.project, defaultAdvisorModel: "q/default" },
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
    expect(palette.querySelector<HTMLButtonElement>('button[title="Favorites"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(palette.querySelector<HTMLButtonElement>('button[title="p"]')!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => palette.querySelector<HTMLButtonElement>('button[title="p"]')!.click());
    expect(palette.textContent).toContain("use omp's configured advisor");
    expect(palette.textContent).toContain("picking one restarts this session and resumes it");
    expect(palette.textContent).toContain("project default:");
    expect(palette.textContent).toContain("q/default");
    const advisorRow = [...palette.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Advisor A"),
    )!;
    act(() => advisorRow.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    const setDefault = [...palette.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Set as default",
    )!;
    await act(async () => setDefault.click());
    expect(backendMock.setProjectDefaultAdvisorModel).toHaveBeenCalledWith(
      "/p",
      "p/advisor-a",
    );

    const configured = [...palette.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("use omp's configured advisor"),
    )!;
    await act(async () => configured.click());
    expect(backendMock.setSessionAdvisor).toHaveBeenCalledWith(TAB, true, null);
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


  function setStatus(status: "starting" | "ready" | "running"): void {
    act(() => seed(status));
  }

  it("focuses the box when a fresh session's boot clears its starting state (regression, #102)", () => {
    seed("starting");
    renderComposer();
    const box = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    // Boot disables the box, so the mount-time focus is a no-op.
    expect(box.disabled).toBe(true);
    expect(document.activeElement).not.toBe(box);
    setStatus("ready");
    expect(box.disabled).toBe(false);
    expect(document.activeElement).toBe(box);
  });

  it("refocuses after the box is disabled mid-boot and re-enabled (case A)", () => {
    seed("ready");
    useStore.setState({ rpc: {} }); // record absent: the box mounts enabled
    renderComposer();
    const box = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(document.activeElement).toBe(box);
    setStatus("starting"); // bootRpcTab's synchronous patch disables the box
    expect(box.disabled).toBe(true);
    setStatus("ready");
    expect(document.activeElement).toBe(box);
  });

  it("does not steal focus on status churn that leaves the box usable", () => {
    seed("ready");
    renderComposer();
    const box = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(document.activeElement).toBe(box);
    // The compact shell's prompt-options control is the only action-row button
    // that survives the ready→running row swap with an empty draft — Send is
    // disabled without a draft and the running row replaces it.
    const options = document.body.querySelector<HTMLButtonElement>('button[title="prompt options"]')!;
    act(() => options.focus());
    expect(document.activeElement).toBe(options);
    setStatus("running"); // unavailable stays false: no re-arm
    expect(document.activeElement).toBe(options);
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

  it("refuses Plan entry while the session still owns a goal (#381)", () => {
    seed("ready");
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          goal: {
            version: 1,
            processKey: "proc",
            sessionId: "s",
            revision: 3,
            available: true,
            unavailable: null,
            enabled: true,
            goal: {
              id: "g1",
              objective: "finish the migration",
              status: "paused",
              tokenBudget: null,
              tokensUsed: 10,
              timeUsedSeconds: 5,
              createdAt: 1,
              updatedAt: 2,
            },
            continuation: "idle",
            pauseReason: "Paused by /goal pause.",
            result: null,
          },
        },
      },
    });
    renderComposer();
    const plan = modeSegment("plan");
    expect(plan.disabled).toBe(true);
    expect(plan.title).toBe("drop the current goal before entering plan mode");
    act(() => plan.click());
    expect(setPlanMode).not.toHaveBeenCalled();
  });

  it("releases Plan entry once the goal is complete", () => {
    seed("ready");
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          goal: {
            version: 1,
            processKey: "proc",
            sessionId: "s",
            revision: 4,
            available: true,
            unavailable: null,
            enabled: false,
            goal: {
              id: "g1",
              objective: "finish the migration",
              status: "complete",
              tokenBudget: null,
              tokensUsed: 10,
              timeUsedSeconds: 5,
              createdAt: 1,
              updatedAt: 2,
            },
            continuation: "idle",
            pauseReason: null,
            result: null,
          },
        },
      },
    });
    renderComposer();
    const plan = modeSegment("plan");
    expect(plan.disabled).toBe(false);
    expect(plan.title).not.toContain("drop the current goal");
  });

  it("offers the goal family once, with its subcommands", () => {
    seed("ready");
    // OMP's own `/goal` spec is TUI-only and reaches the client as an advertised
    // command; the palette must show one goal entry, not two (#381).
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          commands: [{ name: "goal", description: "tui only", source: "builtin" }],
        },
      },
    });
    renderComposer();
    typeDraft("/goal");
    const texts = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .map((b) => b.textContent?.trim() ?? "")
      .filter((text) => text.startsWith("/goal"));
    // OMP's TUI-only builtin `goal` is filtered out of the roster, so the family
    // appears exactly once, parent plus the bridge's six subcommands (#381).
    expect(texts.filter((t) => /^\/goal(?:\[|$)/.test(t))).toHaveLength(1);
    for (const verb of ["set", "show", "pause", "resume", "drop", "budget"]) {
      expect(texts.filter((t) => t.startsWith(`/goal ${verb}`))).toHaveLength(1);
    }
    expect(texts).toHaveLength(7);
    expect(document.body.textContent).toContain(
      "goal — one objective this session works toward on its own",
    );
    const parent = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim().startsWith("/goal[") ?? false,
    )!;
    // The parent row takes an argument, so picking it completes the draft rather
    // than dispatching a bare `/goal`.
    act(() => parent.click());
    expect(runSlashCommand).not.toHaveBeenCalled();
    expect(document.body.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("/goal ");
  });

  it("completes the guided-goal draft with its argument", () => {
    seed("ready");
    renderComposer();
    typeDraft("/guided-goal");
    const row = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("/guided-goal"),
    )!;
    // Its palette row takes an argument, so the pick completes the draft instead
    // of dispatching it half-written.
    act(() => row.click());
    expect(document.body.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("/guided-goal ");
  });

});

describe("Composer slash completion (#382)", () => {
  beforeEach(() => {
    useStore.setState({ runSlashCommand });
  });

  /** The mounted palette rows as `/command sub` labels (the part before ": "). */
  function slashRows(): string[] {
    return [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .map((button) => button.getAttribute("aria-label") ?? "")
      .filter((label) => label.startsWith("/"))
      .map((label) => label.split(": ")[0]!);
  }

  it("completes into the subcommand stage", async () => {
    seed("ready");
    renderComposer();
    const textarea = typeDraft("/goal");
    press(textarea, "Tab");
    expect(textarea.value).toBe("/goal ");
    // The completion opens the second stage instead of dismissing: the six
    // goal verbs in advertised order, no parent row, no guided-goal row.
    expect(slashRows()).toEqual([
      "/goal set",
      "/goal show",
      "/goal pause",
      "/goal resume",
      "/goal drop",
      "/goal budget",
    ]);
    typeDraft("/goal s");
    // Fuzzy names: set/show start with s, resume/pause merely contain it.
    expect(slashRows()).toEqual(["/goal set", "/goal show", "/goal resume", "/goal pause"]);
    press(textarea, "Tab");
    expect(textarea.value).toBe("/goal set ");
    // `set <objective>` takes a required argument, so Tab completes; the
    // needle ("set ") matches no sibling name, so the palette steps aside.
    expect(slashRows()).toEqual([]);
    expect(runSlashCommand).not.toHaveBeenCalled();
    typeDraft("/goal set finish the migration");
    press(textarea, "Enter");
    await act(async () => {});
    expect(runSlashCommand).toHaveBeenCalledWith(TAB, "/goal set finish the migration");
  });

  it("steps aside for a free-form argument so Enter runs the line", async () => {
    seed("ready");
    const compact: SlashCommandInfo = {
      name: "compact",
      description: "compact the context",
      source: "builtin",
      input: { hint: "[soft|remote|snapcompact] [focus]" },
      subcommands: [
        { name: "soft", description: "soft compaction", usage: "[focus]" },
        { name: "remote", description: "remote compaction", usage: "[focus]" },
        { name: "snapcompact", description: "snap compaction" },
      ],
    };
    useStore.setState({
      rpc: { [TAB]: { ...useStore.getState().rpc[TAB]!, commands: [compact] } },
    });
    renderComposer();
    const textarea = typeDraft("/compact s");
    expect(slashRows()).toEqual(["/compact soft", "/compact snapcompact"]);
    // The argument matches no subcommand name — the regression: the palette
    // must not swallow Enter and rewrite the typed argument into a completion.
    typeDraft("/compact focus on db");
    expect(slashRows()).toEqual([]);
    press(textarea, "Enter");
    await act(async () => {});
    expect(runSlashCommand).toHaveBeenCalledWith(TAB, "/compact focus on db");
    expect(textarea.value).toBe("");
  });

  it("Escape dismisses the exact draft only", () => {
    seed("ready");
    renderComposer();
    const textarea = typeDraft("/goal ");
    expect(slashRows()).toHaveLength(6);
    press(textarea, "Escape");
    expect(slashRows()).toEqual([]);
    expect(abortAgent).not.toHaveBeenCalled();
    typeDraft("/goal s");
    // A different exact draft reopens: dismissal keys "goal " and "goal s".
    expect(slashRows()).toHaveLength(4);
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

  it("keeps the mirror's width equal to the box's live width across the scroll threshold", () => {
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
    const mirror = el.previousElementSibling as HTMLDivElement;
    // jsdom has no layout; supply the metrics fit() reads.
    el.style.lineHeight = "20px";
    el.style.paddingTop = "8px";
    el.style.paddingBottom = "8px";
    let width = 200;
    let scroll = 3 * 20 + 16; // three rows of content
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => width });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scroll });
    act(() => ro!());
    expect(el.style.overflowY).toBe("hidden");
    expect(mirror.style.width).toBe("");       // no scrollbar: full width
    // The same draft re-wraps far past the 12-row cap after a width change.
    width = 100;
    scroll = 30 * 20 + 16;
    act(() => ro!());
    expect(el.style.overflowY).toBe("auto");
    expect(mirror.style.width).toBe("100px");  // synced to the box's live width
    // The box widens again and the draft re-wraps back below the cap:
    // full width is restored.
    width = 200;
    scroll = 3 * 20 + 16;
    act(() => ro!());
    expect(el.style.overflowY).toBe("hidden");
    expect(mirror.style.width).toBe("");
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

describe("worktree conversion through the branch chip (issue #227)", () => {
  const gitBranches = {
    repoRoot: "/p", current: "main", branches: ["main", "feature/x"], defaultBranch: "main",
    upstreamRef: null, upstreamRemote: null, hasUpstream: false, ahead: 0, behind: 0,
    upstreamFetchedAt: null, upstreamRefreshError: null,
  };

  // The worktree section lives in the non-compact action row, but the global
  // matchMedia stub reports the compact shell — override it the way the
  // relaunch handoff test does.
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    seed("ready");
    // Without this, the chip's per-open refresh would replace the seeded git
    // state with the mock's non-git default and unmount the chip.
    backendMock.listBranches.mockResolvedValue(gitBranches);
    useStore.setState({ branches: { "/p": gitBranches } });
  });

  function renderUnprompted(): void {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<Composer tabId={TAB} unprompted />));
  }

  const chipTrigger = (): HTMLButtonElement => document.body.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

  const buttonByText = (text: string): HTMLButtonElement =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;

  const flush = async (): Promise<void> => { await act(async () => {}); };

  async function enterWorktreeSection(): Promise<void> {
    act(() => chipTrigger().click());
    await flush();
    act(() => buttonByText("worktree…").click());
    // Let WorktreeBranchFields default the base to the checkout's current branch.
    await flush();
  }

  it("the first send converts, then prompts", async () => {
    renderUnprompted();
    await enterWorktreeSection();
    typeDraft("hello");
    await act(async () => buttonByText("send").click());
    await flush();
    expect(backendMock.convertToWorktree).toHaveBeenCalledTimes(1);
    expect(backendMock.convertToWorktree).toHaveBeenCalledWith(TAB, expect.stringMatching(/^omp-ui\/main\/[0-9a-f]{8}$/), "main", null);
    expect(sendPrompt).toHaveBeenCalledWith(TAB, "hello", "prompt", []);
    // A successful conversion resets the selection; the chip reads the checkout's branch again.
    expect(chipTrigger().textContent).toContain("main");
    expect(chipTrigger().textContent).not.toContain("worktree");
  });

  it("a conversion failure keeps the draft and shows the error", async () => {
    backendMock.convertToWorktree.mockRejectedValueOnce(new Error("branch already exists"));
    renderUnprompted();
    await enterWorktreeSection();
    const textarea = typeDraft("hello");
    await act(async () => buttonByText("send").click());
    await flush();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(textarea.value).toBe("hello");
    expect(document.body.textContent).toContain("branch already exists");
    expect(document.body.querySelector('button[aria-label="dismiss worktree error"]')).not.toBeNull();

  });
  it("create cuts the worktree now, without a prompt", async () => {
    renderUnprompted();
    await enterWorktreeSection();
    await act(async () => buttonByText("create").click());
    await flush();
    expect(backendMock.convertToWorktree).toHaveBeenCalledTimes(1);
    expect(backendMock.convertToWorktree).toHaveBeenCalledWith(
      TAB,
      expect.stringMatching(/^omp-ui\/main\/[0-9a-f]{8}$/),
      "main",
      null,
    );
    expect(sendPrompt).not.toHaveBeenCalled();
    // The selection resets; the chip reads the checkout's branch again.
    expect(chipTrigger().textContent).toContain("main");
    expect(chipTrigger().textContent).not.toContain("worktree");
  });

  it("a create failure keeps the selection and shows the error", async () => {
    backendMock.convertToWorktree.mockRejectedValueOnce(new Error("branch already exists"));
    renderUnprompted();
    await enterWorktreeSection();
    await act(async () => buttonByText("create").click());
    await flush();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("branch already exists");
    expect(document.body.querySelector('button[aria-label="dismiss worktree error"]')).not.toBeNull();
    // The worktree selection survives for a fix-and-retry.
    expect(chipTrigger().textContent).toContain("worktree");
  });

  it("create shows the in-flight state and blocks re-entry", async () => {
    // A never-settling conversion holds the in-flight state without a store.
    const neverSettled = Promise.withResolvers<void>();
    backendMock.convertToWorktree.mockImplementationOnce(() => neverSettled.promise);
    renderUnprompted();
    await enterWorktreeSection();
    await act(async () => buttonByText("create").click());
    await flush();
    expect(document.body.textContent).toContain("cutting the worktree…");
    expect(buttonByText("creating…").disabled).toBe(true);
  });

  it("create with a typed new base sends baseBranch and the composed branch (issue #405)", async () => {
    renderUnprompted();
    await enterWorktreeSection();
    const base = document.body.querySelector<HTMLSelectElement>("#composer-worktree-base")!;
    act(() => {
      base.value = "__new__";
      base.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const name = document.body.querySelector<HTMLInputElement>("#composer-worktree-new-base")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(name, "TECH-123");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonByText("create").click());
    await flush();
    expect(backendMock.convertToWorktree).toHaveBeenCalledWith(
      TAB,
      expect.stringMatching(/^omp-ui\/TECH-123\/[0-9a-f]{8}$/),
      "main",
      "TECH-123",
    );
  });

  it("create stays disabled while the new base name is blank (issue #405)", async () => {
    renderUnprompted();
    await enterWorktreeSection();
    const base = document.body.querySelector<HTMLSelectElement>("#composer-worktree-base")!;
    act(() => {
      base.value = "__new__";
      base.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(buttonByText("create").disabled).toBe(true);
    expect(backendMock.convertToWorktree).not.toHaveBeenCalled();
  });

});

describe("Composer answers pending questions (desktop, issue #421)", () => {
  const OTHER = "Other (type your own)";
  function desktop(): void {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  }
  function seedQueue(frames: unknown[]): void {
    seed("ready");
    useStore.setState((s) => ({
      rpc: { ...s.rpc, [TAB]: { ...s.rpc[TAB]!, extensionQueue: frames } },
    }));
  }
  const answerFrames = () =>
    backendMock.rpcSend.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((frame) => frame.type === "extension_ui_response");

  it("answers a single select from the composer instead of prompting", () => {
    desktop();
    seedQueue([{ id: "q", method: "select", title: "Pick?", options: ["Alpha", OTHER] }]);
    renderRpcTab();
    const box = typeDraft("forty-two");
    press(box, "Enter");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(answerFrames()).toEqual([{ type: "extension_ui_response", id: "q", value: "forty-two" }]);
    expect(box.value).toBe("");
  });

  it("does not push an answer into the recall history", () => {
    desktop();
    seedQueue([{ id: "q", method: "select", title: "Pick?", options: ["Alpha", OTHER] }]);
    renderRpcTab();
    const box = typeDraft("forty-two");
    press(box, "Enter");
    press(box, "ArrowUp");
    expect(box.value).toBe("");
  });

  it("answers an editor frame in one Enter", () => {
    desktop();
    seedQueue([{ id: "ed", method: "editor", title: "Enter your response:" }]);
    renderRpcTab();
    const box = typeDraft("custom answer");
    press(box, "Enter");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(answerFrames()).toEqual([{ type: "extension_ui_response", id: "ed", value: "custom answer" }]);
    expect(box.value).toBe("");
  });

  it("keeps the draft on a loop frame until the editor frame answers it", () => {
    desktop();
    seedQueue([{ id: "m", method: "select", title: "(1 selected) Which?", options: ["Alpha", "✔ Done selecting", OTHER] }]);
    renderRpcTab();
    const box = typeDraft("a plus b");
    press(box, "Enter");
    expect(answerFrames()).toEqual([{ type: "extension_ui_response", id: "m", value: OTHER }]);
    expect(box.value).toBe("a plus b");
    act(() => useStore.setState((s) => ({
      rpc: { ...s.rpc, [TAB]: { ...s.rpc[TAB]!, extensionQueue: [{ id: "ed", method: "editor", title: "Enter your response:" }] } },
    })));
    press(box, "Enter");
    expect(answerFrames()[1]).toMatchObject({ id: "ed", value: "a plus b" });
    expect(box.value).toBe("");
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps the prompt path while a confirm frame is pending", () => {
    desktop();
    seedQueue([{ id: "c", method: "confirm", title: "Run it?" }]);
    renderRpcTab();
    const box = typeDraft("hello");
    press(box, "Enter");
    expect(sendPrompt).toHaveBeenCalledWith(TAB, "hello", "prompt", []);
    expect(answerFrames()).toHaveLength(0);
  });

  it("routes slash commands and interrupt around the question", () => {
    desktop();
    seedQueue([{ id: "q", method: "select", title: "Pick?", options: ["Alpha", OTHER] }]);
    renderRpcTab();
    const box = typeDraft("/compact");
    press(box, "Enter");
    expect(runSlashCommand).toHaveBeenCalledWith(TAB, "/compact");
    expect(answerFrames()).toHaveLength(0);
    typeDraft("abort this");
    act(() => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    expect(abortAndPrompt).toHaveBeenCalledWith(TAB, "abort this", []);
    expect(answerFrames()).toHaveLength(0);
  });

  it("shows the answer placeholder only in question mode", () => {
    desktop();
    seedQueue([{ id: "q", method: "select", title: "Pick?", options: ["Alpha", OTHER] }]);
    renderRpcTab();
    expect(document.body.querySelector("textarea")!.placeholder).toContain("answer the question");
    act(() => useStore.setState((s) => ({
      rpc: { ...s.rpc, [TAB]: { ...s.rpc[TAB]!, extensionQueue: [{ id: "c", method: "confirm", title: "Run it?" }] } },
    })));
    expect(document.body.querySelector("textarea")!.placeholder).toContain("message the agent");
  });

  it("keeps steering from the composer in the compact shell", () => {
    // No desktop() override: the compact guard must leave the sheet flow and
    // the prompt route untouched while a question is pending (issue #421).
    seedQueue([{ id: "q", method: "select", title: "Pick?", options: ["Alpha", OTHER] }]);
    renderRpcTab();
    const box = typeDraft("compact steer");
    press(box, "Enter");
    expect(sendPrompt).toHaveBeenCalledWith(TAB, "compact steer", "prompt", []);
    expect(answerFrames()).toHaveLength(0);
  });
});
