// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList, ServiceTier } from "@omp-ui/core/types";
import { backendState, rpcTabState } from "../test/fixtures";
import { emptySessionRuntime } from "../lib/rpc-types";
import { t } from "../lib/i18n";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const OFF_REPO: BranchList = {
  repoRoot: null,
  current: null,
  branches: [],
  defaultBranch: null,
  upstreamRef: null,
  upstreamRemote: null,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  mergeInProgress: false,
  upstreamFetchedAt: null,
  upstreamRefreshError: null,
  // OFF_REPO: not a git repo, so there is no remote at all.
  defaultRemote: null,
};

const backendMock = {
  listBranches: vi.fn(async (): Promise<BranchList> => OFF_REPO),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ComposerSheet } = await import("./ComposerSheet");

const TAB = "tab-sheet";
const state = backendState({
  projects: [{ project: { path: "/p", name: "P", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null, browserClock: false, reviewRoster: null, knowledgeHome: null }, sessions: [{
    tabId: TAB, sessionId: "s", lineageDir: "lineage", projectCwd: "/p", launchedAt: "t", mode: "rpc-ui",
    worktree: null, planImplementationSource: null, experiment: null, agentMode: "build", compactionMethod: null, approvalMode: null, serviceTier: null, model: null, thinkingLevel: null, advisor: false, advisorModel: null, subagentModels: null, proposedPlans: [], cachedTitle: "Sheet", cachedModified: "t", title: "Sheet", status: "complete", live: "live", pendingPlan: null, planSettle: null, streamStalled: false,
  }] }],
});

const setThinkingLevel = vi.fn(async () => {});
const setFastMode = vi.fn(async () => {});
const setServiceTier = vi.fn(async () => {});
const sendPrompt = vi.fn(async () => true);
const abortAgent = vi.fn(async () => {});
let onSubmitRoute: (route: string) => void;
let onClose: () => void;
let root: Root | null = null;

function seed(status: "ready" | "running"): void {
  useStore.setState({
    advisorDefaults: {},
    state,
    branches: { "/p": OFF_REPO },
    rpc: { [TAB]: rpcTabState({
      status,
      model: {
        id: "model-x",
        name: "Model X",
        provider: "test",
        input: ["text"],
        contextWindow: 1000,
        thinking: { efforts: ["low", "medium", "high"] },
      },
      session: { ...emptySessionRuntime(), thinkingLevel: "medium", queuedMessageCount: 2 },
      hasRenamed: true,
    }) },
    compactSurface: "composer-options",
    sendPrompt,
    setFastMode,
    setServiceTier,
    abortAgent,
    setThinkingLevel,
  });
}

function seedTier(
  serviceTier: ServiceTier | null,
  enabled = true,
  active = true,
): void {
  seed("ready");
  useStore.setState((s) => ({
    state: {
      ...s.state!,
      projects: s.state!.projects.map((group) => ({
        ...group,
        sessions: group.sessions.map((record) =>
          record.tabId === TAB ? { ...record, serviceTier } : record,
        ),
      })),
    },
    rpc: {
      [TAB]: {
        ...s.rpc[TAB]!,
        model: { ...s.rpc[TAB]!.model!, serviceTiers: ["priority", "ultrafast"] },
        session: { ...s.rpc[TAB]!.session, fastModeEnabled: enabled, fastModeActive: active },
      },
    },
  }));
}

function render(open = true): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ComposerSheet
        open={open}
        onClose={onClose}
        tabId={TAB}
        projectCwd="/p"
        unavailable={false}
        canSend={true}
        onSubmit={(route) => onSubmitRoute(route)}
      />,
    ),
  );
}

const buttonByText = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(found).toBeDefined();
  return found!;
};

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  vi.clearAllMocks();
  onSubmitRoute = vi.fn();
  onClose = vi.fn();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ComposerSheet", () => {
  it("stays unmounted while closed", () => {
    seed("ready");
    render(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens with the model, the effort grid, and the session section", () => {
    seed("ready");
    render(true);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("model & effort");
    expect(dialog.textContent).toContain("model-x");
    for (const effort of ["low", "medium", "high"]) {
      expect(dialog.textContent).toContain(effort);
    }
    expect(dialog.textContent).toContain("session");
    expect(dialog.textContent).toContain("branch");
    // Idle, so the parked items are labeled parked, not queued.
    expect(dialog.textContent).toContain("parked: 2");
  });

  it("clicking an effort fires the set_thinking_level path through the store", async () => {
    seed("ready");
    render(true);
    const effort = buttonByText("high");
    await act(async () => effort.click());
    expect(setThinkingLevel).toHaveBeenCalledWith(TAB, "high");
  });

  it("renders auto above the ladder and dispatches level auto", async () => {
    seed("ready");
    render(true);
    const auto = buttonByText("auto");
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.indexOf(auto)).toBeLessThan(buttons.indexOf(buttonByText("low")));
    await act(async () => auto.click());
    expect(setThinkingLevel).toHaveBeenCalledWith(TAB, "auto");
  });

  it("marks auto selected and the resolved effort unselected while configured auto", () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: {
        [TAB]: {
          ...s.rpc[TAB]!,
          session: { ...s.rpc[TAB]!.session, thinkingLevel: "medium", thinkingConfigured: "auto" },
        },
      },
    }));
    render(true);
    expect(buttonByText("auto").getAttribute("aria-pressed")).toBe("true");
    expect(buttonByText("medium").getAttribute("aria-pressed")).toBe("false");
  });

  it("hides the while-running section while idle", () => {
    seed("ready");
    render(true);
    expect(document.body.textContent).not.toContain("while running");
    expect(
      [...document.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent === "Queue",
      ),
    ).toBe(false);
  });

  it("offers Queue and Interrupt-and-send while running, routing to their verbs", async () => {
    seed("running");
    render(true);
    expect(document.body.textContent).toContain("while running");
    const queue = buttonByText("Queue");
    const interrupt = buttonByText("Interrupt-and-send");
    await act(async () => queue.click());
    expect(onSubmitRoute).toHaveBeenCalledWith("follow_up");
    await act(async () => interrupt.click());
    expect(onSubmitRoute).toHaveBeenCalledWith("interrupt");
  });

  it("the sheet close control calls onClose", () => {
    seed("ready");
    render(true);
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="close prompt options"]')!;
    expect(close).not.toBeNull();
    act(() => close.click());
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("fast mode shows the declined wording and the switch drives set_fast_mode", async () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: {
        [TAB]: {
          ...s.rpc[TAB]!,
          session: { ...s.rpc[TAB]!.session, fastModeEnabled: true, fastModeActive: false },
        },
      },
    }));
    render(true);
    expect(document.body.textContent).toContain("on — provider declined");
    const sw = document.querySelector<HTMLButtonElement>(
      `button[role="switch"][aria-label="fast mode"]`,
    )!;
    expect(sw).not.toBeNull();
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await act(async () => sw.click());
    expect(setFastMode).toHaveBeenCalledWith(TAB, false);
  });

  it("the fast mode switch on an off session sends enable", async () => {
    seed("ready");
    render(true);
    const sw = document.querySelector<HTMLButtonElement>(
      `button[role="switch"][aria-label="fast mode"]`,
    )!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("fast mode");
    await act(async () => sw.click());
    expect(setFastMode).toHaveBeenCalledWith(TAB, true);
  });

  // Placement rule (issue #689): exactly one fast control per sheet — the
  // model/effort section while the gate is open, the session section while
  // it is closed. Two switches with one accessible name is the defect.
  const fastSwitches = (): HTMLButtonElement[] =>
    [...document.body.querySelectorAll<HTMLButtonElement>('button[role="switch"][aria-label="fast mode"]')];

  it("rides the model/effort section on a family-backed model, quiet state", () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: { [TAB]: { ...s.rpc[TAB]!, model: { ...s.rpc[TAB]!.model!, provider: "openai" } } },
    }));
    render(true);
    const switches = fastSwitches();
    expect(switches).toHaveLength(1);
    expect(switches[0]!.closest("section")!.textContent).toContain("model & effort");
  });

  it("keeps the always-available session-section row on an unsupported quiet model", () => {
    seed("ready");
    render(true);
    const switches = fastSwitches();
    expect(switches).toHaveLength(1);
    expect(switches[0]!.closest("section")!.textContent).toContain("session");
  });

  it("keeps the fast mode switch for an OpenAI model without service tiers", () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: { [TAB]: { ...s.rpc[TAB]!, model: { ...s.rpc[TAB]!.model!, provider: "openai" } } },
    }));
    render(true);
    expect(fastSwitches()).toHaveLength(1);
    expect(fastSwitches()[0]!.getAttribute("aria-checked")).toBe("false");
    expect(document.body.querySelector('[role="group"][aria-label="fast mode"]')).toBeNull();
  });

  it("keeps the fast mode switch for an OpenAI model advertising only priority", () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: {
        [TAB]: {
          ...s.rpc[TAB]!,
          model: { ...s.rpc[TAB]!.model!, provider: "openai", serviceTiers: ["priority"] },
        },
      },
    }));
    render(true);
    expect(fastSwitches()).toHaveLength(1);
    expect(fastSwitches()[0]!.getAttribute("aria-checked")).toBe("false");
    expect(document.body.querySelector('[role="group"][aria-label="fast mode"]')).toBeNull();
  });

  it("offers off, priority and ultrafast and dispatches tier selection and off", async () => {
    seedTier(null, false, false);
    render(true);
    const group = document.body.querySelector('[role="group"][aria-label="fast mode"]')!;
    expect(group).not.toBeNull();
    expect(fastSwitches()).toHaveLength(0);
    const choices = [...group.querySelectorAll<HTMLButtonElement>("button")];
    expect(choices.map((button) => button.textContent)).toEqual([
      t("hud.fast.tierOff"),
      t("hud.fast.tierPriority"),
      t("hud.fast.tierUltrafast"),
    ]);
    await act(async () => choices[2]!.click());
    expect(setServiceTier).toHaveBeenCalledWith(TAB, "ultrafast");
    await act(async () => choices[1]!.click());
    expect(setServiceTier).toHaveBeenCalledWith(TAB, "priority");
    expect(setFastMode).not.toHaveBeenCalled();
    await act(async () => choices[0]!.click());
    expect(setFastMode).toHaveBeenCalledWith(TAB, false);
  });

  it.each([
    { serviceTier: null, enabled: true, selected: "priority" },
    { serviceTier: "priority" as const, enabled: true, selected: "priority" },
    { serviceTier: "ultrafast" as const, enabled: true, selected: "ultrafast" },
    { serviceTier: "ultrafast" as const, enabled: false, selected: "off" },
  ])("selects $selected for record tier $serviceTier with enabled=$enabled", ({ serviceTier, enabled, selected }) => {
    seedTier(serviceTier, enabled, enabled);
    render(true);
    const group = document.body.querySelector('[role="group"][aria-label="fast mode"]')!;
    const choices = [...group.querySelectorAll<HTMLButtonElement>("button")];
    expect(choices.filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => button.textContent)).toEqual([selected]);
    expect(choices.filter((button) => button.getAttribute("aria-pressed") === "false")).toHaveLength(2);
  });

  it("keeps declined ultrafast selected with the declined tooltip and allows retry", async () => {
    seedTier("ultrafast", true, false);
    render(true);
    const group = document.body.querySelector('[role="group"][aria-label="fast mode"]')!;
    const choices = [...group.querySelectorAll<HTMLButtonElement>("button")];
    const ultrafast = choices.find((button) => button.textContent === t("hud.fast.tierUltrafast"))!;
    expect(ultrafast.getAttribute("aria-pressed")).toBe("true");
    expect(ultrafast.title).toBe(t("hud.fast.declinedTitle"));
    expect(choices.find((button) => button.textContent === t("hud.fast.tierPriority"))!.title)
      .toBe(t("hud.fast.tierPriorityTitle"));
    await act(async () => ultrafast.click());
    expect(setServiceTier).toHaveBeenCalledWith(TAB, "ultrafast");
  });

  it("lists the queued follow-ups below the branch row when omp reports them", () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: {
        [TAB]: {
          ...s.rpc[TAB]!,
          session: { ...s.rpc[TAB]!.session, queuedMessages: { steering: [], followUp: ["first", "second"] } },
        },
      },
    }));
    render(true);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("parked: 2");
    expect(dialog.textContent).toContain("follow-up");
    expect(dialog.textContent).toContain("first");
    expect(dialog.textContent).toContain("second");
  });
});
