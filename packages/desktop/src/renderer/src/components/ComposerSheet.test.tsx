// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList, ServiceTier } from "@omp-ui/core/types";
import { backendState, rpcTabState } from "../test/fixtures";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
import { emptySessionRuntime } from "../lib/rpc-types";
import { t } from "../lib/i18n";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const peerMocks = vi.hoisted(() => ({ available: false }));

// The live row gates on this client opening a call peer (issue #968); jsdom
// has no WebRTC, so the live-gate tests opt in.
vi.mock("../lib/live-peer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live-peer")>()),
  canOpenLivePeer: () => peerMocks.available,
}));

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
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  setSessionModel: vi.fn(async () => {}),
  rpcSend: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ComposerSheet } = await import("./ComposerSheet");
const realSetThinkingLevel = useStore.getState().setThinkingLevel;

const TAB = "tab-sheet";
const state = backendState({
  projects: [{ project: { path: "/p", name: "P", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null, browserClock: false, councilRoster: null, knowledgeHome: null, repositoryKey: null, icon: null }, sessions: [{
    tabId: TAB, sessionId: "s", lineageDir: "lineage", projectCwd: "/p", launchedAt: "t", mode: "rpc-ui",
    worktree: null, planImplementationSource: null, experiment: null, fleet: null, agentMode: "build", compactionMethod: null, approvalMode: null, serviceTier: null, model: null, thinkingLevel: null, advisor: false, advisorModel: null, subagentModels: null, proposedPlans: [], autoTitled: false, snoozed: false, snoozedUntilMs: null, pinnedAtMs: null, heldPrompt: null, scheduledPrompt: null, pullRequests: [], autoSettleOnMerge: null, private: false, chat: false, askSource: null, cachedTitle: "Sheet", cachedModified: "t", title: "Sheet", status: "complete", live: "live", pendingPlan: null, planSettle: null, streamStalled: false,
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

/** Live-capable seed: omp 18.5.1 advertises the native live verbs (issue #778). */
function seedLiveCapable(): void {
  seed("ready");
  useStore.setState((s) => ({
    rpc: {
      [TAB]: {
        ...s.rpc[TAB]!,
        capabilities: { ompVersion: "18.14.0" } as unknown as CapabilitySnapshot,
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
        stash="stash"
        onStash={() => {}}
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
  peerMocks.available = false;
});

describe("ComposerSheet", () => {
  const voiceActions = { startLiveVoice: useStore.getState().startLiveVoice };
  afterEach(() => useStore.setState(voiceActions));

  it("keeps live voice available by default and starts it from the sheet", async () => {
    peerMocks.available = true;
    seed("ready");
    const start = vi.fn(async () => {});
    useStore.setState((current) => ({
      exited: {}, liveVoice: {}, liveReplay: null,
      startLiveVoice: start,
      rpc: {
        [TAB]: {
          ...current.rpc[TAB]!,
          capabilities: {
            version: 1 as const, processKey: "voice-process", sessionId: null,
            revision: 1, updatedAt: 0, ompVersion: "18.14.0", skillCommandsEnabled: null,
            skills: { status: "unavailable" as const, reason: "missing-api" as const },
            tools: { status: "unavailable" as const, reason: "missing-api" as const },
            magicKeywords: { status: "unavailable" as const, reason: "missing-api" as const },
            toolControl: "unsupported" as const, toolMutation: null,
          },
        },
      },
    }));
    render();
    const startButton = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] button[aria-label="start live voice"]',
    )!;
    expect(startButton).not.toBeNull();
    expect(startButton.disabled).toBe(false);
    await act(async () => startButton.click());
    expect(start).toHaveBeenCalledExactlyOnceWith(TAB);
  });

  it("stays unmounted while closed", () => {
    seed("ready");
    render(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens with the selected model, thinking level, and parked queue count", () => {
    seed("ready");
    render(true);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('button[title="model-x"]')).not.toBeNull();
    const thinking = dialog.querySelector('[role="group"][aria-label="thinking"]')!;
    expect([...thinking.querySelectorAll('button[aria-pressed="true"]')].map((button) => button.textContent))
      .toEqual(["medium"]);
    expect(dialog.textContent).toContain("parked: 2");
  });

  it("selects automatic thinking and commits a manual level with the sheet slider keyboard controls", async () => {
    seed("ready");
    useStore.setState({ setThinkingLevel: realSetThinkingLevel });
    render(true);
    const dialog = document.querySelector('[role="dialog"]')!;
    const auto = dialog.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="auto"]')!;
    const thinking = dialog.querySelector('[role="group"][aria-label="thinking"]')!;
    const ticks = [...thinking.querySelectorAll<HTMLButtonElement>("button")];

    async function change(action: () => void): Promise<void> {
      await act(async () => {
        action();
        const [tabId, command] = backendMock.rpcSend.mock.calls.at(-1)! as [string, Record<string, unknown>];
        useStore.getState().handleRpcFrame(tabId, {
          type: "response", id: command.id, command: command.type, success: true, data: {},
        });
      });
    }

    expect(auto.getAttribute("aria-checked")).toBe("false");
    await change(() => auto.click());
    expect(useStore.getState().rpc[TAB]!.session.thinkingConfigured).toBe("auto");
    expect(useStore.getState().rpc[TAB]!.session.thinkingLevel).toBe("medium");
    expect(auto.getAttribute("aria-checked")).toBe("true");
    expect(ticks.every((tick) => tick.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(backendMock.setSessionModel).toHaveBeenLastCalledWith(TAB, "test/model-x", "auto");

    await change(() => auto.click());
    expect(useStore.getState().rpc[TAB]!.session.thinkingConfigured).toBeNull();
    expect(ticks.find((tick) => tick.textContent === "medium")!.getAttribute("aria-pressed")).toBe("true");
    expect(backendMock.setSessionModel).toHaveBeenLastCalledWith(TAB, "test/model-x", "medium");

    await change(() => auto.click());
    await change(() => ticks.find((tick) => tick.textContent === "medium")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    ));
    expect(useStore.getState().rpc[TAB]!.session.thinkingConfigured).toBeNull();
    expect(useStore.getState().rpc[TAB]!.session.thinkingLevel).toBe("high");
    expect(auto.getAttribute("aria-checked")).toBe("false");
    expect(ticks.find((tick) => tick.textContent === "high")!.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(ticks.find((tick) => tick.textContent === "high"));
    expect(backendMock.setSessionModel).toHaveBeenLastCalledWith(TAB, "test/model-x", "high");
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
    expect(document.body.textContent).toContain(t("hud.fast.declined"));
    const sw = document.querySelector<HTMLButtonElement>(
      `button[role="switch"][aria-label="fast mode"]`,
    )!;
    expect(sw).not.toBeNull();
    expect(sw.title).toBe(t("hud.fast.declinedTitle"));
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await act(async () => sw.click());
    expect(setFastMode).toHaveBeenCalledWith(TAB, false);
  });

  it("the fast mode switch on an off session sends enable", async () => {
    seed("ready");
    useStore.setState((s) => ({
      rpc: { [TAB]: { ...s.rpc[TAB]!, model: { ...s.rpc[TAB]!.model!, provider: "openai" } } },
    }));
    render(true);
    const sw = document.querySelector<HTMLButtonElement>(
      `button[role="switch"][aria-label="fast mode"]`,
    )!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("fast mode");
    await act(async () => sw.click());
    expect(setFastMode).toHaveBeenCalledWith(TAB, true);
  });

  // A sheet must never present duplicate controls for the same fast setting.
  const fastSwitches = (): HTMLButtonElement[] =>
    [...document.body.querySelectorAll<HTMLButtonElement>('button[role="switch"][aria-label="fast mode"]')];


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

// Issue #968: the sheet's live row shows wherever this client can open the
// call's peer — desktop, remote web client, or a joined remote-instance
// tab — next to the model/effort controls it belongs to; a client with no
// WebRTC or microphone (a non-secure origin) never offers it.
describe("ComposerSheet live voice gate (issue #968)", () => {
  const liveSwitch = (): HTMLButtonElement | null =>
    document.body.querySelector<HTMLButtonElement>(
      `button[role="switch"][aria-label="${t("composer.live.start")}"]`,
    );

  beforeEach(() => {
    peerMocks.available = true;
  });

  afterEach(() => {
    peerMocks.available = false;
  });


  it("is absent on a client that cannot open a peer", () => {
    peerMocks.available = false;
    seedLiveCapable();
    render(true);
    expect(liveSwitch()).toBeNull();
    expect(document.body.textContent).not.toContain(t("composer.live.start"));
  });
});
