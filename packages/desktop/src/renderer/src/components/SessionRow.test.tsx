// @vitest-environment jsdom
// Seance consult (issue #885): the sidebar row's ghost action. Only the
// affordance's presence/absence and its omp-version gate are covered here;
// the consult launch itself is the store slice's test surface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OmpUpdateState, SessionSummary } from "@omp-ui/core/types";
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

function render(s: SessionSummary, installedVersion: string | null): HTMLElement {
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
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SessionRow s={s} />));
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
