// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState } from "@omp-ui/core/types";
import { emptySessionRuntime } from "../lib/rpc-types";

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
const backendMock = {
  listProjectFiles: vi.fn(async () => ({ files: [], truncated: false })),
  resolveFileMentions: vi.fn(async () => ({ contextText: "", images: [] })),
  listBranches: vi.fn(async () => ({ repoRoot: null, current: null, branches: [], defaultBranch: null })),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { Composer } = await import("./Composer");


const IMAGE_ONE = { type: "image" as const, data: "one", mimeType: "image/png" };
const IMAGE_TWO = { type: "image" as const, data: "two", mimeType: "image/jpeg" };
const TAB = "tab-compose";
const sendPrompt = vi.fn(async () => {});
const abortAndPrompt = vi.fn(async () => {});
const abortAgent = vi.fn(async () => {});
let root: Root | null = null;

const state = {
  defaultMode: "rpc-ui", modelFavorites: [], skipDeleteConfirmation: false, themeId: "graphite",
  planFormat: "html",
  advisorAutoReply: true,
  appUpdateCheckOnLaunch: true, ompUpdateCheckOnLaunch: true, dismissedAppUpdateVersion: null, dismissedOmpUpdateVersion: null,
  projects: [{ project: { path: "/p", name: "P", addedAt: "t", lastModel: null, lastAdvisorModel: null }, sessions: [{
    tabId: TAB, sessionId: "s", lineageDir: "lineage", projectCwd: "/p", launchedAt: "t", mode: "rpc-ui",
    advisor: false, advisorModel: null, cachedTitle: "Compose", cachedModified: "t", title: "Compose", status: "complete", live: "live",
  }] }],
} as BackendState;

function seed(status: "ready" | "running", dead = false): void {
  useStore.setState({
    state,
    exited: dead ? { [TAB]: 0 } : {},
    branches: { "/p": { repoRoot: null, current: null, branches: [], defaultBranch: null } },
    rpc: { [TAB]: { status, items: [], todos: [], model: { id: "model-x", name: "Model X", provider: "test", input: ["text"], contextWindow: 1000 }, availableModels: [], commands: [],
      session: { ...emptySessionRuntime(), thinkingLevel: "medium" }, stats: null, subagents: [], extensionStatus: {}, pendingCommands: new Map(), extensionQueue: [], busy: false,
      initialPrompt: null, hasRenamed: true, plan: null, planReview: null, planText: null, planHtml: null, planDeferred: false, plans: [], advisorStats: null, advisorReply: true },
    },
    compactSurface: null, sendPrompt, abortAndPrompt, abortAgent,
  });
}

function renderComposer(): void {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(<Composer tabId={TAB} />));
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
    expect(byText("plan").getAttribute("aria-checked")).toBe("false");
    const sheet = document.body.querySelector<HTMLElement>('[aria-label="prompt options"]')!;
    expect(sheet.querySelector(".prompt-options")).not.toBeNull();
    expect(sheet.querySelector(".w-full")?.textContent).toContain("advisor");
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

  function modeSegment(name: "build" | "plan"): HTMLButtonElement {
    return [...document.body.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find(
      (button) => button.textContent?.trim() === name,
    )!;
  }

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
    expect(modeSegment("build").getAttribute("aria-checked")).toBe("true");
    expect(modeSegment("plan").getAttribute("aria-checked")).toBe("false");
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
    expect(modeSegment("plan").getAttribute("aria-checked")).toBe("true");
    expect(modeSegment("build").getAttribute("aria-checked")).toBe("false");
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
    expect(build.getAttribute("aria-checked")).toBe("true");
    expect(build.disabled).toBe(false);
    expect(plan.getAttribute("aria-checked")).toBe("false");
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
