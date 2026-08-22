// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../lib/rpc-types";
import { backendState, rpcTabState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.assign(window, { ompBackend: {} });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ModelPalette, ModelSelector } = await import("./ModelSelector");

const TAB = "model-selector-tab";
const current: ModelInfo = { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" };
const alternate: ModelInfo = { id: "claude-haiku", name: "Claude Haiku", provider: "anthropic" };
const models: ModelInfo[] = [
  current,
  alternate,
  { id: "gpt-5", name: "GPT-5", provider: "openai" },
];
const state = backendState();

function tabState() {
  return rpcTabState({
    status: "ready",
    hasRenamed: true,
    model: current,
    availableModels: models,
  });
}

let root: Root | null = null;

function mount(node: ReactNode): void {
  if (root !== null) act(() => root!.unmount());
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

function buttonByTitle(title: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.title === title,
  );
  expect(button).toBeDefined();
  return button!;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  );
  expect(button).toBeDefined();
  return button!;
}

function paletteInput(): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>('[role="dialog"] input');
  expect(found).not.toBeNull();
  return found!;
}

function pressPalette(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    paletteInput().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

function modelButtons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>(
    ".model-palette .overflow-y-auto > div > button:first-child",
  )];
}

beforeEach(() => {
  useStore.setState({ state, rpc: { [TAB]: tabState() } });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("ModelSelector", () => {
  it("returns to Favorites after closing from a provider tab", () => {
    mount(<ModelSelector tabId={TAB} />);
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

  it("keeps an empty Favorites list safe and preserves provider shortcuts", () => {
    mount(<ModelSelector tabId={TAB} />);
    act(() => buttonByTitle("anthropic/claude-sonnet").click());

    pressPalette("ArrowDown");
    pressPalette("ArrowUp");
    pressPalette("n", { ctrlKey: true });
    pressPalette("Enter");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    pressPalette("]", { ctrlKey: true, code: "BracketRight" });
    expect(buttonByTitle("anthropic").getAttribute("aria-pressed")).toBe("true");

    pressPalette("n", { ctrlKey: true });
    expect(buttonByText("Claude Haiku").parentElement?.className).toContain("bg-hover");
  });
});

describe("ModelPalette variants", () => {
  it("opens the advisor palette on Favorites, then exposes the configured null entry on a provider tab", () => {
    const pick = vi.fn();
    mount(
      <ModelPalette
        variant="advisor"
        models={models}
        current="openai/gpt-5"
        inherited
        defaultModel="anthropic/claude-sonnet"
        onPick={pick}
        onClose={vi.fn()}
      />,
    );

    expect(buttonByTitle("Favorites").getAttribute("aria-pressed")).toBe("true");
    expect(buttonByTitle("openai").getAttribute("aria-pressed")).toBe("false");

    act(() => buttonByTitle("openai").click());
    const favorite = document.body.querySelector<HTMLButtonElement>('button[aria-label="add to favorites"]')!;
    expect(favorite.parentElement?.querySelectorAll(":scope > button")).toHaveLength(2);
    const configured = buttonByText("use omp's configured advisor");
    expect(configured.textContent).toContain("anthropic/claude-sonnet");
    act(() => configured.click());
    expect(pick).toHaveBeenCalledWith(null);
    act(() => buttonByText("GPT-5").click());
    expect(pick).toHaveBeenLastCalledWith("openai/gpt-5");
    expect(document.body.textContent).toContain("picking one restarts this session and resumes it");
  });

  it("shares current-first ranking and the 120-model cap across both variants", () => {
    const ranked = Array.from({ length: 121 }, (_, index): ModelInfo => ({
      id: `m${String(index).padStart(3, "0")}`,
      name: "Model",
      provider: "p",
    }));
    const rankedCurrent = ranked[120]!;
    useStore.setState({
      state: backendState({ modelFavorites: ranked.map((model) => `${model.provider}/${model.id}`) }),
    });

    mount(
      <ModelPalette
        variant="main"
        models={ranked}
        current={rankedCurrent}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(modelButtons()).toHaveLength(120);
    expect(modelButtons()[0]!.textContent).toContain("p/m120");

    mount(
      <ModelPalette
        variant="advisor"
        models={ranked}
        current="p/m120"
        inherited={false}
        defaultModel={null}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(modelButtons()).toHaveLength(120);
    expect(modelButtons()[0]!.textContent).toContain("p/m120");
  });

  it("keeps rich metadata and provider settings on the main variant", () => {
    const rich: ModelInfo = {
      id: "rich",
      name: "Rich Model",
      provider: "provider",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200_000,
      cost: { input: 3, output: 15 },
    };
    const pick = vi.fn();
    useStore.setState({ state: backendState({ modelFavorites: ["provider/rich"] }) });
    mount(
      <ModelPalette
        variant="main"
        models={[rich]}
        current={rich}
        onPick={pick}
        onClose={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain("reasoning");
    expect(document.body.textContent).toContain("vision");
    expect(document.body.textContent).toContain("200K");
    expect(document.body.textContent).toContain("$3/$15");
    expect(buttonByText("provider keys")).toBeDefined();
    act(() => buttonByText("Rich Model").click());
    expect(pick).toHaveBeenCalledWith(rich);
  });
});
