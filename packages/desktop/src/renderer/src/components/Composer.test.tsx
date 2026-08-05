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
      initialPrompt: null, hasRenamed: true, plan: null, planReview: null, planText: null, planDeferred: false, plans: [], advisorStats: null },
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
    act(() => byText("prompt options · Model X").click());
    await act(async () => byText("Queue").click());
    expect(sendPrompt).toHaveBeenCalledWith(TAB, "running draft", "follow_up", []);

    typeDraft("replace turn");
    await act(async () => byText("Interrupt-and-send").click());
    expect(abortAndPrompt).toHaveBeenCalledWith(TAB, "replace turn", []);
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
});
