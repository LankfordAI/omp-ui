// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState } from "@omp-ui/core/types";
import { emptySessionRuntime } from "../lib/rpc-types";

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

function seed(status: "ready" | "running"): void {
  useStore.setState({
    state,
    exited: {},
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

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  vi.clearAllMocks();
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
