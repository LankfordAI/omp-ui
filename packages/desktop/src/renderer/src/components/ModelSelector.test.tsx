// @vitest-environment jsdom
import type { BackendState } from "@omp-ui/core/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime, type ModelInfo } from "../lib/rpc-types";
import type { RpcTabState } from "../store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.assign(window, { ompBackend: {} });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ModelSelector } = await import("./ModelSelector");

const TAB = "model-selector-tab";
const current: ModelInfo = { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" };
const models: ModelInfo[] = [
  current,
  { id: "gpt-5", name: "GPT-5", provider: "openai" },
];
const state = {
  defaultMode: "rpc-ui",
  modelFavorites: [],
  skipDeleteConfirmation: false,
  themeId: "graphite",
  appUpdateCheckOnLaunch: true,
  ompUpdateCheckOnLaunch: true,
  dismissedAppUpdateVersion: null,
  dismissedOmpUpdateVersion: null,
  projects: [],
} as BackendState;

function tabState(): RpcTabState {
  return {
    status: "ready",
    items: [],
    todos: [],
    model: current,
    availableModels: models,
    commands: [],
    session: emptySessionRuntime(),
    stats: null,
    subagents: [],
    extensionStatus: {},
    pendingCommands: new Map(),
    extensionQueue: [],
    busy: false,
    initialPrompt: null,
    hasRenamed: true,
    plan: null,
    planReview: null,
    planText: null,
    planDeferred: false,
    plans: [],
    advisorStats: null,
  };
}

let root: Root | null = null;

function buttonByTitle(title: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.title === title,
  );
  expect(button).toBeDefined();
  return button!;
}

beforeEach(() => {
  useStore.setState({ state, rpc: { [TAB]: tabState() } });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ModelSelector tabId={TAB} />));
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("ModelSelector", () => {
  it("returns to Favorites after closing from a provider tab", () => {
    const trigger = buttonByTitle("anthropic/claude-sonnet");
    act(() => trigger.click());
    expect(buttonByTitle("Favorites").getAttribute("aria-pressed")).toBe("true");

    act(() => buttonByTitle("openai").click());
    expect(buttonByTitle("openai").getAttribute("aria-pressed")).toBe("true");

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    act(() => trigger.click());
    expect(buttonByTitle("Favorites").getAttribute("aria-pressed")).toBe("true");
    expect(buttonByTitle("openai").getAttribute("aria-pressed")).toBe("false");
  });
});
