// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState, ProjectGroup } from "@omp-ui/core/types";
import type { ModelInfo } from "../lib/rpc-types";
import { t } from "../lib/i18n";
import { backendState, remoteInstance, rpcTabState } from "../test/fixtures";
import type { RpcTabState } from "../store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.assign(window, { ompBackend: {} });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ModelPalette, ModelSelector } = await import("./ModelSelector");

// Tests that replace store actions with mocks restore these originals in
// beforeEach so a vi.fn() never leaks into later tests.
const realToggleFavorite = useStore.getState().toggleFavorite;
const realOpenSettings = useStore.getState().openSettings;

const TAB = "model-selector-tab";
const current: ModelInfo = { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" };
const alternate: ModelInfo = { id: "claude-haiku", name: "Claude Haiku", provider: "anthropic" };
const models: ModelInfo[] = [
  current,
  alternate,
  { id: "gpt-5", name: "GPT-5", provider: "openai" },
];
const state = backendState();

const INSTANCE = "inst-remote";
const NICKNAME = "build-box";

function remoteProjectGroup(): ProjectGroup {
  return {
    project: {
      path: "/remote/project",
      name: "remote-project",
      addedAt: "2026-09-09T00:00:00.000Z",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
      browserClock: false,
      councilRoster: null,
      knowledgeHome: null,
      repositoryKey: null,
      icon: null,
    },
    sessions: [
      {
        tabId: TAB,
        sessionId: `${TAB}-session`,
        lineageDir: "omp-ui--remote",
        projectCwd: "/remote/project",
        launchedAt: "2026-09-09T00:00:00.000Z",
        mode: "rpc-ui",
        worktree: null,
        planImplementationSource: null, experiment: null, fleet: null,
        agentMode: "build",
        compactionMethod: null,
        approvalMode: null,
        serviceTier: null,
        model: null,
        thinkingLevel: null,
        advisor: false,
        advisorModel: null, subagentModels: null,
 proposedPlans: [],
 autoTitled: false,
 snoozed: false,
 snoozedUntilMs: null,
 pinnedAtMs: null,
 settledAtMs: null,
 heldPrompt: null,
 scheduledPrompt: null,
 routine: null,
 pullRequests: [],
 autoSettleOnMerge: null,
 private: false,
 chat: false,
 askSource: null,
        cachedTitle: "Remote session",
        cachedModified: "2026-09-09T00:00:00.000Z",
        title: "Remote session",
        status: "complete",
        live: "live",
        pendingPlan: null,
        planSettle: null,
        streamStalled: false,
      },
    ],
  };
}

/** BackendState where TAB's session is owned by the remote instance (issue #440). */
function remoteOwnedState(): BackendState {
  return backendState({
    projects: [],
    remoteInstances: [
      remoteInstance({
        id: INSTANCE,
        nickname: NICKNAME,
        projects: [remoteProjectGroup()],
      }),
    ],
  });
}

function tabState(patch: Partial<RpcTabState> = {}) {
  return rpcTabState({
    status: "ready",
    hasRenamed: true,
    model: current,
    availableModels: models,
    ...patch,
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

const originalMatchMedia = window.matchMedia;

function setCompact(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
}

/** Drain the overlay's rAF initial-focus handoff (ui/overlays.tsx useOverlay). */
async function drainFrame(): Promise<void> {
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function openPalette(): Promise<void> {
  mount(<ModelSelector tabId={TAB} />);
  act(() => buttonByTitle("anthropic/claude-sonnet").click());
  await drainFrame();
}

function pressOn(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  return event;
}

function setQuery(value: string, caret: number): void {
  const input = paletteInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.setSelectionRange(caret, caret);
  });
}

beforeEach(() => {
  useStore.setState({
    state,
    rpc: { [TAB]: tabState() },
    toggleFavorite: realToggleFavorite,
    openSettings: realOpenSettings,
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  if (originalMatchMedia === undefined) Reflect.deleteProperty(window, "matchMedia");
  else Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("ModelSelector", () => {
  it("returns to Favorites after closing from a provider tab", () => {
    mount(<ModelSelector tabId={TAB} />);
    const trigger = buttonByTitle("anthropic/claude-sonnet");
    act(() => trigger.click());
    expect(buttonByTitle("Favorites").getAttribute("aria-selected")).toBe("true");

    act(() => buttonByTitle("openai").click());
    expect(buttonByTitle("openai").getAttribute("aria-selected")).toBe("true");

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    act(() => trigger.click());
    expect(buttonByTitle("Favorites").getAttribute("aria-selected")).toBe("true");
    expect(buttonByTitle("openai").getAttribute("aria-selected")).toBe("false");
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
    expect(buttonByTitle("anthropic").getAttribute("aria-selected")).toBe("true");

    pressPalette("n", { ctrlKey: true });
    expect(buttonByText("Claude Haiku").parentElement?.className).toContain("bg-hover");
  });

  it("locks the trigger while the turn is running", () => {
    useStore.setState({ state, rpc: { [TAB]: tabState({ status: "running" }) } });
    mount(<ModelSelector tabId={TAB} />);
    const trigger = buttonByTitle(t("composer.model.afterTurn"));
    expect(trigger.disabled).toBe(true);

    act(() => trigger.click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes an open palette when the store transitions to running, then re-enables on ready", () => {
    mount(<ModelSelector tabId={TAB} />);
    const trigger = buttonByTitle("anthropic/claude-sonnet");
    act(() => trigger.click());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      useStore.setState({ rpc: { [TAB]: tabState({ status: "running" }) } });
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const lockedTrigger = buttonByTitle(t("composer.model.afterTurn"));
    expect(lockedTrigger.disabled).toBe(true);

    act(() => {
      useStore.setState({ rpc: { [TAB]: tabState({ status: "ready" }) } });
    });
    const readyTrigger = buttonByTitle("anthropic/claude-sonnet");
    expect(readyTrigger.disabled).toBe(false);
  });

  it("names the owning instance for an empty remote catalog instead of opening local Settings", () => {
    const openSettings = vi.fn();
    useStore.setState({
      state: remoteOwnedState(),
      rpc: { [TAB]: tabState({ model: null, availableModels: [] }) },
      openSettings,
    });
    mount(<ModelSelector tabId={TAB} />);

    const trigger = document.body.querySelector<HTMLButtonElement>("button");
    expect(trigger).not.toBeNull();
    expect([trigger!.title, trigger!.textContent].join(" ")).toContain(NICKNAME);
    act(() => trigger!.click());
    expect(openSettings).not.toHaveBeenCalled();
  });

  // #1032: omp switched off the pin for a credential-less provider. The chip
  // names the running model (truth) but stays copper with a divergence tooltip.
  it("names the running fallback model while flagging the credential divergence in copper", () => {
    const running: ModelInfo = { id: "m1", name: "m1", provider: "keyprov" };
    useStore.setState({
      state,
      rpc: {
        [TAB]: tabState({
          model: running,
          availableModels: [...models, running],
          credentialFallback: { from: "nokeyprov/m1", to: "keyprov/m1" },
        }),
      },
    });
    mount(<ModelSelector tabId={TAB} />);

    const trigger = buttonByTitle(
      t("composer.model.credFallback", { to: "keyprov/m1", pin: "nokeyprov/m1" }),
    );
    expect(trigger.textContent).toContain("m1");
    expect(trigger.className).toContain("text-copper");
  });

  it("leaves tone and title untouched when no credential fallback is active", () => {
    useStore.setState({ state, rpc: { [TAB]: tabState({ credentialFallback: null }) } });
    mount(<ModelSelector tabId={TAB} />);

    const trigger = buttonByTitle("anthropic/claude-sonnet");
    expect(trigger.className).toContain("text-ink-mid");
    expect(trigger.className).not.toContain("text-copper");
  });

  it("keeps the held copy on top when a credential fallback arrives under a model hold", () => {
    const group = remoteProjectGroup();
    useStore.setState({
      state: backendState({
        projects: [
          {
            ...group,
            sessions: [
              {
                ...group.sessions[0],
                modelHold: {
                  reason: "unreachable",
                  model: "anthropic/claude-sonnet",
                  provider: "anthropic",
                  endpoint: "127.0.0.1:4677",
                },
              },
            ],
          },
        ],
      }),
      rpc: { [TAB]: tabState({ credentialFallback: { from: "nokeyprov/m1", to: "keyprov/m1" } }) },
    });
    mount(<ModelSelector tabId={TAB} />);

    // The hold masks the fallback: ask-for-a-pick copy, never the divergence tooltip.
    const trigger = buttonByTitle(t("composer.model.pick"));
    expect(trigger.textContent).toContain(t("composer.model.held"));
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
        instanceId={null}
        onPick={pick}
        onClose={vi.fn()}
      />,
    );

    expect(buttonByTitle("Favorites").getAttribute("aria-selected")).toBe("true");
    expect(buttonByTitle("openai").getAttribute("aria-selected")).toBe("false");

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

  it("offers session-model and omp-default rows for subagent choices", () => {
    const pick = vi.fn();
    mount(
      <ModelPalette
        variant="subagent"
        models={models}
        current="*"
        allowInherit
        instanceId={null}
        onPick={pick}
        onClose={vi.fn()}
      />,
    );

    act(() => buttonByText("session model").click());
    expect(pick).toHaveBeenLastCalledWith("*");
    act(() => buttonByText("omp default").click());
    expect(pick).toHaveBeenLastCalledWith(null);
    act(() => buttonByText("openai").click());
    act(() => buttonByText("GPT-5").click());
    expect(pick).toHaveBeenLastCalledWith("openai/gpt-5");
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
        instanceId={null}
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
        instanceId={null}
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
        instanceId={null}
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

  it("hides the project-default footer when no project pin context is supplied", () => {
    mount(
      <ModelPalette
        variant="main"
        models={models}
        current={current}
        instanceId={null}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(document.body.textContent).not.toContain("project default:");
  });

  it("sets the highlighted model as the project default and clears an existing pin", () => {
    const onPinChange = vi.fn();
    useStore.setState({
      state: backendState({ modelFavorites: ["anthropic/claude-sonnet"] }),
    });
    mount(
      <ModelPalette
        variant="main"
        models={models}
        current={current}
        projectPin="openai/gpt-5"
        onPinChange={onPinChange}
        instanceId={null}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain("project default:");
    expect(document.body.textContent).toContain("openai/gpt-5");
    expect(document.body.textContent).toContain("new sessions only");
    act(() => buttonByText("Set as default").click());
    expect(onPinChange).toHaveBeenCalledWith("anthropic/claude-sonnet");
    act(() => buttonByText("Clear").click());
    expect(onPinChange).toHaveBeenLastCalledWith(null);
  });
});

describe("remote instance ownership (#440)", () => {
  it("serves Favorites from the owning instance and routes star clicks to it", () => {
    const remoteModel: ModelInfo = { id: "gemini-pro", name: "Gemini Pro", provider: "google" };
    const catalog: ModelInfo[] = [current, alternate, remoteModel];
    const toggleFavorite = vi.fn();
    useStore.setState({
      state: backendState({
        modelFavorites: ["anthropic/claude-haiku"],
        remoteInstances: [
          remoteInstance({ id: INSTANCE, nickname: NICKNAME, modelFavorites: ["google/gemini-pro"] }),
        ],
      }),
      toggleFavorite,
    });

    mount(
      <ModelPalette
        variant="main"
        models={catalog}
        current={current}
        instanceId={INSTANCE}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const remoteRows = modelButtons();
    expect(remoteRows).toHaveLength(1);
    expect(remoteRows[0]!.textContent).toContain("google/gemini-pro");
    const star = remoteRows[0]!.parentElement!.querySelectorAll<HTMLButtonElement>("button")[1]!;
    act(() => star.click());
    expect(toggleFavorite).toHaveBeenCalledTimes(1);
    expect(toggleFavorite).toHaveBeenCalledWith("google/gemini-pro", INSTANCE);

    mount(
      <ModelPalette
        variant="main"
        models={catalog}
        current={current}
        instanceId={null}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const localRows = modelButtons();
    expect(localRows).toHaveLength(1);
    expect(localRows[0]!.textContent).toContain("anthropic/claude-haiku");
  });

  it("points a remote footer at the owning instance without a provider-keys link", () => {
    useStore.setState({
      state: backendState({
        remoteInstances: [remoteInstance({ id: INSTANCE, nickname: NICKNAME })],
      }),
    });
    mount(
      <ModelPalette
        variant="main"
        models={models}
        current={current}
        instanceId={INSTANCE}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain(NICKNAME);
    expect(document.body.textContent).toContain(t("composer.model.pricesNote"));
    const providerKeys = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(t("composer.model.providerKeys")),
    );
    expect(providerKeys).toBeUndefined();
  });
});

// issue #1157: the model picker hotkey lands as a store request; the selector
// consumes it on the same pass and only its owner instance opens the palette.
describe("hotkey-opened picker (#1157)", () => {
  it("opens the palette when the store names this tab, consuming the request", () => {
    mount(<ModelSelector tabId={TAB} />);

    act(() => useStore.getState().openModelPicker(TAB));

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(useStore.getState().modelPickerTab).toBeNull();
  });

  it("consumes the request without a palette while the turn is running", () => {
    useStore.setState({ state, rpc: { [TAB]: tabState({ status: "running" }) } });
    mount(<ModelSelector tabId={TAB} />);

    act(() => useStore.getState().openModelPicker(TAB));

    expect(useStore.getState().modelPickerTab).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("consumes the request on an empty catalog and stays closed after the catalog lands", () => {
    useStore.setState({ state, rpc: { [TAB]: tabState({ availableModels: [] }) } });
    mount(<ModelSelector tabId={TAB} />);

    act(() => useStore.getState().openModelPicker(TAB));

    expect(useStore.getState().modelPickerTab).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    // The delayed-populate trap: the catalog arriving later must not open a
    // palette for a request that was already consumed.
    act(() => {
      useStore.setState({ rpc: { [TAB]: tabState() } });
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens exactly one palette when a hotkeyOpens={false} twin shares the tab", () => {
    mount(
      <>
        <ModelSelector tabId={TAB} hotkeyOpens={false} />
        <ModelSelector tabId={TAB} />
      </>,
    );

    act(() => useStore.getState().openModelPicker(TAB));

    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(useStore.getState().modelPickerTab).toBeNull();
  });
});

describe("ModelPalette keyboard panes", () => {
  it("rAF initial-focus handoff lands on the search input", async () => {
    await openPalette();
    expect(document.activeElement).toBe(paletteInput());
    expect(document.activeElement).not.toBe(
      document.body.querySelector(".compact-modal-close"),
    );
  });

  it("hops to the rail at caret 0, wraps with arrows, and returns with ArrowRight", async () => {
    await openPalette();
    pressOn(paletteInput(), "ArrowLeft");
    const favorites = buttonByTitle("Favorites");
    expect(document.activeElement).toBe(favorites);
    expect(favorites.getAttribute("aria-selected")).toBe("true");

    pressOn(favorites, "ArrowUp"); // wraps to the last provider
    expect(document.activeElement).toBe(buttonByTitle("openai"));
    expect(buttonByTitle("openai").getAttribute("aria-selected")).toBe("true");

    pressOn(buttonByTitle("openai"), "ArrowDown"); // wraps back to favorites
    pressOn(buttonByTitle("Favorites"), "ArrowDown"); // anthropic
    expect(buttonByTitle("anthropic").getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain("Claude Haiku");
    expect(document.body.textContent).not.toContain("GPT-5");

    pressOn(buttonByTitle("anthropic"), "ArrowRight");
    expect(document.activeElement).toBe(paletteInput());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("keeps ArrowLeft a caret edit mid-query, and hops at caret 0 of a non-empty query", async () => {
    await openPalette();
    setQuery("claude", 3);
    const mid = pressOn(paletteInput(), "ArrowLeft");
    expect(mid.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(paletteInput());

    setQuery("claude", 0);
    pressOn(paletteInput(), "ArrowLeft");
    expect(document.activeElement).toBe(buttonByTitle("Favorites"));
  });

  it("Enter on the rail returns to search without picking a model", async () => {
    await openPalette();
    pressOn(paletteInput(), "ArrowLeft");
    pressOn(buttonByTitle("Favorites"), "Enter");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(paletteInput());
  });

  it("appends a printable key pressed on the rail and puts the caret at the end", async () => {
    await openPalette();
    pressOn(paletteInput(), "ArrowLeft");
    pressOn(buttonByTitle("Favorites"), "x");
    expect(document.activeElement).toBe(paletteInput());
    expect(paletteInput().value).toBe("x");
    expect(paletteInput().selectionStart).toBe(1);
  });

  it("leaves Space to native button activation without touching the query", async () => {
    await openPalette();
    pressOn(paletteInput(), "ArrowLeft");
    const space = pressOn(buttonByTitle("Favorites"), " ");
    expect(space.defaultPrevented).toBe(false);
    expect(paletteInput().value).toBe("");
    expect(document.activeElement).toBe(buttonByTitle("Favorites"));
  });

  it("reconciles selection when native Tab focus enters an unselected tab", async () => {
    await openPalette();
    // jsdom has no native Tab default action; focus() is the Tab-entry seam.
    act(() => buttonByTitle("openai").focus());
    expect(buttonByTitle("openai").getAttribute("aria-selected")).toBe("true");
    pressOn(buttonByTitle("openai"), "ArrowDown"); // wraps to favorites
    expect(document.activeElement).toBe(buttonByTitle("Favorites"));
    pressOn(buttonByTitle("Favorites"), "Enter");
    expect(document.activeElement).toBe(paletteInput());
    expect(buttonByTitle("Favorites").getAttribute("aria-selected")).toBe("true");
  });

  it("ignores shifted arrows and composing keys on both panes", async () => {
    await openPalette();
    pressOn(paletteInput(), "ArrowLeft");
    const shifted = pressOn(buttonByTitle("Favorites"), "ArrowDown", { shiftKey: true });
    expect(shifted.defaultPrevented).toBe(false);
    expect(buttonByTitle("Favorites").getAttribute("aria-selected")).toBe("true");

    const composingEnter = pressOn(paletteInput(), "Enter", { isComposing: true });
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    // A row has to exist to see whether the cursor moved: Ctrl+] to anthropic,
    // one real ArrowDown to seat the cursor on row 0, then a composing
    // ArrowDown that must leave it there.
    pressOn(paletteInput(), "]", { ctrlKey: true, code: "BracketRight" });
    pressOn(paletteInput(), "ArrowDown");
    const composingDown = pressOn(paletteInput(), "ArrowDown", { isComposing: true });
    expect(composingDown.defaultPrevented).toBe(false);
    expect(buttonByText("Claude Haiku").parentElement?.className).toContain("bg-hover");
  });

  it("falls back to Favorites and recovers focus when a refresh drops the open provider", async () => {
    mount(<ModelSelector tabId={TAB} />);
    act(() => buttonByTitle("anthropic/claude-sonnet").click());
    await drainFrame();
    act(() => buttonByTitle("openai").click());
    act(() => buttonByTitle("openai").focus());
    act(() => root!.render(<ModelSelector tabId={TAB} />));
    useStore.setState({
      rpc: { [TAB]: tabState({ availableModels: models.filter((m) => m.provider !== "openai") }) },
    });
    await drainFrame();
    expect(buttonByTitle("Favorites").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(paletteInput());
    pressOn(paletteInput(), "ArrowLeft");
    expect(document.activeElement).toBe(buttonByTitle("Favorites"));
  });

  it("returns focus to the search input after a mouse click on the rail", async () => {
    await openPalette();
    act(() => buttonByTitle("openai").click());
    expect(document.activeElement).toBe(paletteInput());
  });

  it("rotates the rail axes in the compact shell", async () => {
    setCompact(true);
    await openPalette();
    expect(document.body.querySelector('[role="tablist"]')?.getAttribute("aria-orientation"))
      .toBe("horizontal");
    pressOn(paletteInput(), "ArrowLeft");
    pressOn(buttonByTitle("Favorites"), "ArrowRight"); // steps, does not exit
    expect(document.activeElement).toBe(buttonByTitle("anthropic"));
    expect(buttonByTitle("anthropic").getAttribute("aria-selected")).toBe("true");
    pressOn(buttonByTitle("anthropic"), "ArrowLeft"); // steps back
    expect(document.activeElement).toBe(buttonByTitle("Favorites"));
    pressOn(buttonByTitle("Favorites"), "ArrowDown"); // returns to search
    expect(document.activeElement).toBe(paletteInput());
  });
});

describe("ModelPalette routine variant", () => {
  const richModels: ModelInfo[] = [
    {
      id: "claude-sonnet",
      name: "Claude Sonnet",
      provider: "anthropic",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200_000,
      cost: { input: 3, output: 15 },
    },
    { id: "gpt-5", name: "GPT-5", provider: "openai", contextWindow: 128_000 },
  ];

  it("renders Project default row with hint, keeps rich model chips, filters by query, and invokes onPick", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    mount(
      <ModelPalette
        variant="routine"
        instanceId={null}
        models={richModels}
        current={null}
        defaultHint="Uses anthropic/claude-sonnet"
        onPick={onPick}
        onClose={onClose}
      />,
    );

    // Project default appears at the top of Favorites with its hint.
    const defaultRow = buttonByText("Project default");
    expect(defaultRow.textContent).toContain("Uses anthropic/claude-sonnet");
    act(() => defaultRow.click());
    expect(onPick).toHaveBeenCalledWith(null);

    // Switching to anthropic tab keeps Project default AND shows Vision/Context/Price chips.
    act(() => buttonByTitle("anthropic").click());
    expect(buttonByText("Project default")).toBeDefined();
    const sonnetRow = buttonByText("Claude Sonnet");
    expect(sonnetRow.textContent).toContain("vision");
    expect(sonnetRow.textContent).toContain("200K");
    expect(sonnetRow.textContent).toContain("$3/$15");

    // Querying a model hides Project default when it doesn't match and lets the user pick provider/id.
    setQuery("sonnet", 6);
    expect(
      [...document.body.querySelectorAll("button")].some((b) => b.textContent?.includes("Project default")),
    ).toBe(true); // Matches defaultHint "Uses anthropic/claude-sonnet"

    setQuery("zzz-no-match", 12);
    expect(
      [...document.body.querySelectorAll("button")].some((b) => b.textContent?.includes("Project default")),
    ).toBe(false);

    setQuery("", 0);
    act(() => buttonByText("Claude Sonnet").click());
    expect(onPick).toHaveBeenCalledWith("anthropic/claude-sonnet");
  });
});
