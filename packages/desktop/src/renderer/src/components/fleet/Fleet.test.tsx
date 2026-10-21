// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetPendingDispatch, FleetProvenance } from "@omp-ui/core/fleet";
import type { ProjectGroup, SessionSummary } from "@omp-ui/core/types";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  fleetMachines: vi.fn(async () => []),
  fleetAudit: vi.fn(async () => []),
  fleetDispatch: vi.fn(),
  fleetDismissPending: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports: store.ts → ./backend reads window.ompBackend at module load.
const { useStore } = await import("../../store");
const { Fleet } = await import("./Fleet");

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function provenance(dispatchId: string, batchId: string | null, dispatchedAt: string): FleetProvenance {
  return {
    dispatchId,
    batchId,
    dispatchedAt,
    requestedBy: { instanceId: "inst-me", label: "desk", kind: "user", sourceTabId: null },
  };
}

function session(tabId: string, title: string, fleet: FleetProvenance | null): SessionSummary {
  return {
    tabId,
    sessionId: null,
    lineageDir: `lineage-${tabId}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    fleet,
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
    cachedTitle: title,
    cachedModified: "t",
    title,
    status: "complete",
    live: "dormant",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  };
}

function group(sessions: SessionSummary[]): ProjectGroup {
  return {
    project: {
      path: "/p",
      name: "P",
      addedAt: "t",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
      browserClock: false,
      reviewRoster: null,
      knowledgeHome: null,
      repositoryKey: null,
    },
    sessions,
  };
}

function pending(dispatchId: string, title: string): FleetPendingDispatch {
  return {
    dispatchId,
    batchId: null,
    machineKey: "inst-1",
    nickname: "box-a",
    projectCwd: "/remote/p",
    title,
    since: "2026-10-20T00:00:00.000Z",
    message: "remote connection lost",
  };
}

function render(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Fleet />));
}

const buttons = (scope: Element, text: string): HTMLButtonElement[] =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === text);

describe("Fleet view", () => {
  it("groups dispatched sessions by batch and offers Retry only for requests this renderer still holds", () => {
    useStore.setState({
      fleet: { machines: [], audit: null, loading: false, error: null },
      fleetLastRequests: {
        "d-live": {
          req: { targets: { kind: "auto", reference: { machineKey: "local", projectCwd: "/p" }, count: 1 }, prompt: "go", title: null, workspace: "worktree", planMode: false },
          pick: { machineKey: "inst-1", projectCwd: "/remote/p" },
        },
      },
      rpc: {},
      state: backendState({
        projects: [
          group([
            session("t-a", "Batch work", provenance("d-a", "b-1", "2026-10-20T00:00:01.000Z")),
            session("t-b", "Batch work", provenance("d-b", "b-1", "2026-10-20T00:00:02.000Z")),
            session("t-solo", "Solo work", provenance("d-solo", null, "2026-10-20T00:00:03.000Z")),
            session("t-plain", "Not dispatched", null),
          ]),
        ],
        fleetPending: [pending("d-live", "Still held"), pending("d-reloaded", "Lost on reload")],
      }),
    });
    render();

    const batch = document.body.querySelector('[data-batch-id="b-1"]');
    expect(batch).not.toBeNull();
    expect([...batch!.querySelectorAll("[data-tab-id]")].map((row) => row.getAttribute("data-tab-id"))).toEqual(["t-b", "t-a"]);
    expect(document.body.querySelectorAll("[data-tab-id]")).toHaveLength(3);
    expect(document.body.querySelector('[data-tab-id="t-plain"]')).toBeNull();

    const held = document.body.querySelector('[data-dispatch-id="d-live"]')!;
    expect(buttons(held, "Retry")).toHaveLength(1);
    expect(buttons(held, "Dismiss")).toHaveLength(1);
    const reloaded = document.body.querySelector('[data-dispatch-id="d-reloaded"]')!;
    expect(buttons(reloaded, "Retry")).toHaveLength(0);
    expect(buttons(reloaded, "Dismiss")).toHaveLength(1);
    expect(reloaded.textContent).toContain("Retry unavailable after reload");
    expect(reloaded.textContent).toContain("Outcome unknown — resolves when box-a reconnects");
  });
});
