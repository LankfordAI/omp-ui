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
  storePatch?: Partial<Pick<UiStore, "tabs" | "exited" | "activeTabId">>,
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
  act(() => root!.render(<SessionRow s={s} instanceNickname={instanceNickname} />));
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
