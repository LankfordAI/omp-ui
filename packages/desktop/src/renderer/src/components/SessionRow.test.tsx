// @vitest-environment jsdom
// Seance consult (issue #885): the sidebar row's ghost action. Only the
// affordance's presence/absence and its omp-version gate are covered here;
// the consult launch itself is the store slice's test surface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OmpUpdateState, SessionSummary } from "@omp-ui/core/types";
import type { TabInfo, UiStore } from "../store";
import { t } from "../lib/i18n";

// The row only fires store actions this file replaces, so a no-op backend
// mock suffices (SessionTreeViewer pattern).
vi.mock("../backend", () => ({
  backend: new Proxy({}, { get: () => vi.fn(async () => undefined) }),
  backendFor: () => new Proxy({}, { get: () => vi.fn(async () => undefined) }),
}));
// Static import cannot work here: store.ts → ./backend captures window.ompBackend
// at module evaluation, so the mock above must land first — this test
// intentionally exercises that module-loading boundary.
const { useStore } = await import("../store");
const { SessionRow } = await import("./SessionRow");
// Fixtures touch no bridge at load, so a static import is safe here.
import { rpcTabState } from "../test/fixtures";
import { TONE_DOT } from "./ui/tone";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = "tab-row";

const idleOmpUpdate: OmpUpdateState = {
  status: "idle",
  installPath: null,
  installedVersion: null,
  latestVersion: null,
  belowMinimum: false,
  progress: null,
  error: null,
};

/** A dormant saved session — the one shape the ghost action attaches to. */
function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    tabId: TAB,
    sessionId: "session-1",
    lineageDir: "omp-ui--one--session-1",
    projectCwd: "/projects/one",
    launchedAt: "2026-10-01T00:00:00.000Z",
    mode: "rpc-ui",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    fleet: null,
    agentMode: "build",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    autoTitled: false,
    snoozed: false,
    snoozedUntilMs: null,
    pinnedAtMs: null,
    settledAtMs: 1_000,
    heldPrompt: null,
    scheduledPrompt: null,
    pullRequests: [],
    autoSettleOnMerge: null,
    private: false,
    chat: false,
    askSource: null,
    cachedTitle: "Dormant session",
    cachedModified: "2026-10-01T00:00:00.000Z",
    title: "Dormant session",
    status: "complete",
    live: "dormant",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  };
}

const consultFromRow = vi.fn(async () => {});
let root: Root | null = null;

function render(
  s: SessionSummary,
  installedVersion: string | null,
  instanceNickname?: string | null,
  storePatch?: Partial<Pick<UiStore, "tabs" | "exited" | "activeTabId" | "rpc">>,
  density?: "tile" | "slim",
): HTMLElement {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  useStore.setState({
    activeTabId: TAB,
    exited: {},
    rpc: {},
    liveVoice: {},
    ompUpdate: { ...idleOmpUpdate, installedVersion },
    consultFromRow,
    ...storePatch,
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SessionRow s={s} instanceNickname={instanceNickname} density={density} />));
  return host;
}

function seanceButton(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector<HTMLButtonElement>(`button[aria-label="${t("sidebar.session.seance")}"]`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("sidebar ghost action (Seance consult, #885)", () => {
  it("consults a dormant saved session when omp clears the floor", () => {
    const el = render(summary(), "18.11.3");
    const button = seanceButton(el)!;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(consultFromRow).toHaveBeenCalledWith(TAB);
  });

  it("never mounts on live, missing, or never-materialized rows", () => {
    for (const s of [
      summary({ live: "live" }),
      summary({ live: "missing" }),
      summary({ sessionId: null }),
    ]) {
      const el = render(s, "18.11.3");
      expect(seanceButton(el)).toBeNull();
      act(() => root!.unmount());
      root = null;
      document.body.replaceChildren();
    }
    expect(consultFromRow).not.toHaveBeenCalled();
  });

  it("stays mounted disabled below the floor and names the unlocking version", () => {
    const el = render(summary(), "18.11.2");
    const button = el.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("sidebar.session.seanceNeedsOmp", { version: "18.11.3" })}"]`,
    )!;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
    // Floor plan precedent: the tooltip names the version that unlocks it.
    expect(button.title).toContain("18.11.3");
  });
});

// Unified project view (#903): rows whose session lives on a joined remote
// instance name that machine in the meta line; local rows stay bare.
describe("unified-view machine chip (#903)", () => {
  const chipTitle = t("sidebar.session.machine", { machine: "workbox" });

  it("names the owning machine on remote-instance rows", () => {
    const el = render(summary(), "18.11.3", "workbox");
    expect(el.textContent).toContain("workbox");
    expect(el.querySelector(`span[title="${chipTitle}"]`)).not.toBeNull();
  });

  it("renders no machine text for local rows (absent, null, or empty)", () => {
    for (const nickname of [undefined, null, ""]) {
      const el = render(summary(), "18.11.3", nickname);
      expect(el.textContent).not.toContain("workbox");
      expect(el.querySelector(`span[title="${chipTitle}"]`)).toBeNull();
      act(() => root!.unmount());
      root = null;
      document.body.replaceChildren();
    }
  });
});

// Issue #926: a session that dies before materializing on disk lands in
// Settled as a missing row while its dead tab sits hidden in `tabs`. The
// row must still un-hide that mounted tab — openSession's existing-tab
// branch only unhides+focuses and never spawns — while the click refusal
// stands when there is no mounted tab to resurface.
describe("settled missing row resurfaces its hidden tab (#926)", () => {
  const hiddenDeadTab: TabInfo = {
    tabId: TAB,
    mode: "rpc-ui",
    projectCwd: "/projects/one",
    hidden: true,
    instanceId: null,
  };

  it("un-hides and focuses the mounted dead tab on click", async () => {
    const el = render(summary({ live: "missing", sessionId: null }), "18.11.3", null, {
      tabs: [hiddenDeadTab],
      exited: { [TAB]: 143 },
      activeTabId: null,
    });
    const button = el.querySelector<HTMLButtonElement>("button")!;
    expect(button).not.toBeNull();
    // Honest affordances: the missingHint claims an unreadable transcript,
    // but this click resurfaces the exit card instead.
    expect(button.title).toBe(summary().title);
    expect(button.className).not.toContain("cursor-default");
    await act(async () => button.click());
    expect(useStore.getState().tabs.find((t) => t.tabId === TAB)?.hidden).toBe(false);
    expect(useStore.getState().activeTabId).toBe(TAB);
  });

  it("stays a no-op when nothing is mounted to resurface", async () => {
    const el = render(summary({ live: "missing", sessionId: null }), "18.11.3", null, {
      tabs: [],
      exited: {},
      activeTabId: null,
    });
    const button = el.querySelector<HTMLButtonElement>("button")!;
    expect(button.title).toBe(t("sidebar.session.missingHint"));
    expect(button.className).toContain("cursor-default");
    await act(async () => button.click());
    expect(useStore.getState().tabs).toEqual([]);
    expect(useStore.getState().activeTabId).toBeNull();
  });
});

// Issue #938: the tile quotes what a waiting session asks, marks plan mode,
// and keeps its hover actions out of the click path at rest.
describe("session tile (#938)", () => {
  function unmount(): void {
    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
  }

  function planChip(el: HTMLElement): Element | null {
    return el.querySelector(`[title="${t("hud.mode.planDescription")}"]`);
  }

  it("quotes the pending question on the tile but not on the slim row", () => {
    const waiting = summary({
      live: "live",
      awaitingHumanAnswer: true,
      pendingDialogs: [{ type: "extension_ui_request", id: "q1", method: "select", title: "Which DB? (1/2)" }],
    });
    const tile = render(waiting, "18.11.3");
    expect(tile.textContent).toContain("Which DB?");
    // The page marker is dropped, as on the dialog card's heading.
    expect(tile.textContent).not.toContain("(1/2)");
    expect(tile.textContent).toContain(t("sidebar.session.quoteQuestion"));
    unmount();

    const slim = render(waiting, "18.11.3", null, undefined, "slim");
    expect(slim.textContent).not.toContain("Which DB?");
    expect(slim.textContent).not.toContain(t("sidebar.session.quoteQuestion"));
  });

  it("shows the plan chip for a plan-mode rpc-ui record only", () => {
    const el = render(summary({ agentMode: "plan" }), "18.11.3");
    const chip = planChip(el);
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe(t("sidebar.session.planChip"));
    unmount();

    // agentMode records the last rpc-ui incarnation; a terminal tab never shows it.
    const pty = render(summary({ agentMode: "plan", mode: "pty" }), "18.11.3");
    expect(planChip(pty)).toBeNull();
  });

  it("keeps the hover action cluster out of the click path at rest", () => {
    const el = render(summary(), "18.11.3");
    const del = el.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("sidebar.session.deleteFiles")}"]`,
    )!;
    expect(del).not.toBeNull();
    expect(del.parentElement!.classList.contains("pointer-events-none")).toBe(true);
  });
});

// Issue #1037: the leading Dot is gone in both densities — an always-rendered
// status band carries the state's tone, and the verb text keeps the wording.
describe("status band replaces the dot (#1037)", () => {
  function unmount(): void {
    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
  }

  /** The row's left band: the only span carrying the inset-y-1.5 rail class. */
  function band(el: HTMLElement): HTMLElement | null {
    return [...el.querySelectorAll<HTMLElement>("span")].find((s) => s.classList.contains("inset-y-1.5")) ?? null;
  }

  /** An unselected row (no active tab), so the band shows the state's tone. */
  function renderState(
    patch: Partial<SessionSummary>,
    rpcStatus: "ready" | "running" | "error",
    density?: "tile" | "slim",
  ): HTMLElement {
    return render(
      summary({ live: "live", ...patch }),
      null,
      null,
      { activeTabId: null, rpc: { [TAB]: rpcTabState({ status: rpcStatus }) } },
      density,
    );
  }

  it("tones the band by state in ready, working, and error", () => {
    const ready = renderState({}, "ready");
    // ready's face tone is signal — the same class the selection override uses.
    expect(band(ready)!.classList.contains(TONE_DOT.signal)).toBe(true);
    unmount();

    const working = renderState({}, "running");
    expect(band(working)!.classList.contains(TONE_DOT.copper)).toBe(true);
    unmount();

    const errored = renderState({}, "error");
    expect(band(errored)!.classList.contains(TONE_DOT.rose)).toBe(true);
    unmount();
  });

  it("renders no dot markup in either density, keeps the state text on tiles only, and bands live rows", () => {
    for (const density of ["tile", "slim"] as const) {
      const el = renderState({}, "running", density);
      // The Dot's signature size class is gone from both densities.
      expect(el.querySelector('[class*="size-1.5"]')).toBeNull();
      // The verb text still names the state (accessibility contract).
      expect(el.textContent).toContain(t("sidebar.status.workingLabel"));
      if (density === "tile") {
        // The Dot's hover tooltip rides the band; settled (slim) rows carry
        // no band at all — it is the live-tile state channel (round-2 judge).
        expect(band(el)!.title).toBe(t("sidebar.status.workingTitle"));
      } else {
        expect(band(el)).toBeNull();
      }
      unmount();
    }
  });

  it("leaves a settled slim row without a band", () => {
    const el = render(summary(), "18.11.3", null, undefined, "slim");
    expect(band(el)).toBeNull();
    // The meta line reads time + outcome, never the dormant "no process".
    expect(el.textContent).not.toContain(t("sidebar.status.dormantLabel"));
    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
  });

  it("keeps the state tone on the band of a selected row (round-8 judge)", () => {
    // render()'s default activeTabId is TAB, so this row reads selected.
    // A selected Working row must not read as ready: the bar stays copper,
    // and selection rides the row's fill + ring instead.
    const el = render(summary({ live: "live" }), null, null, {
      rpc: { [TAB]: rpcTabState({ status: "running" }) },
    });
    const b = band(el)!;
    expect(b.classList.contains(TONE_DOT.copper)).toBe(true);
    expect(b.classList.contains("bg-signal")).toBe(false);
  });
});
