// Plan-execution slice tests (moved verbatim from store.test.ts for #295).
import { describe, expect, it, vi } from "vitest";
import type {
  BackendState,
  PendingPlan,
  PlanSettle,
} from "@omp-ui/core/types";

import { planProposalItem } from "../../lib/transcript";
import { rpcTabState } from "../../test/fixtures";
import { h } from "../../test/store-harness";

describe("proposed plans: defer keeps the gate unanswered, history tracks verdicts", () => {
  const planReviewFrame = (id: string, planFilePath = "local://p.md") => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title: "omp-ui:plan-review:" + JSON.stringify({ title: "t", planFilePath }),
  });

  it("records a proposal, defers without answering, and re-opens on demand", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().handleRpcFrame(h.TAB, planReviewFrame("d1"));
    let rpc = h.useStore.getState().rpc[h.TAB]!;
    expect(rpc.planReview?.request.planFilePath).toBe("local://p.md");
    expect(rpc.planDeferred).toBe(false);
    expect(rpc.plans).toEqual([
      { key: "local://p.md", title: "t", status: "pending" },
    ]);

    // "not now" dismisses the pane but never answers the blocked gate: the
    // agent stays paused and the plan stays pending for later.
    h.useStore.getState().deferPlanReview(h.TAB);
    rpc = h.useStore.getState().rpc[h.TAB]!;
    expect(rpc.planDeferred).toBe(true);
    expect(rpc.planReview).not.toBeNull();
    expect(h.sent.some((s) => s.cmd.type === "extension_ui_response")).toBe(
      false,
    );
    expect(
      h.deriveSidebarSessionState(
        h.stateWithRecord(null).projects[0]!.sessions[0]!,
        rpc,
        undefined,
      ),
    ).toBe("awaiting-answer");

    // Restoring the review from the plans tab clears the deferral.
    h.useStore.getState().showPlanReview(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]!.planDeferred).toBe(false);
  });

  it("settles the pending record to refined on a refine verdict", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().handleRpcFrame(h.TAB, planReviewFrame("d2"));
    h.useStore.getState().refinePlan(h.TAB);
    const rpc = h.useStore.getState().rpc[h.TAB]!;
    expect(rpc.plans).toEqual([
      { key: "local://p.md", title: "t", status: "refined" },
    ]);
    expect(
      h.sent.find((s) => s.cmd.type === "extension_ui_response")!.cmd.value,
    ).toBe("refine");
  });

  it("settles the pending record to executed, and a repropose keeps one record", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().handleRpcFrame(h.TAB, planReviewFrame("d3"));
    h.useStore.getState().executePlan(h.TAB, "existing");
    let rpc = h.useStore.getState().rpc[h.TAB]!;
    expect(rpc.plans[0]!.status).toBe("executed");
    // The planner comes back with a revised draft for the same plan file.
    h.useStore.getState().handleRpcFrame(h.TAB, planReviewFrame("d4"));
    rpc = h.useStore.getState().rpc[h.TAB]!;
    expect(rpc.plans).toHaveLength(1);
    expect(rpc.plans[0]).toEqual({
      key: "local://p.md",
      title: "t",
      status: "pending",
    });
  });
});

describe("plan-review gate reconciliation (issue #215)", () => {
  const PENDING: PendingPlan = {
    title: "add auth",
    planFilePath: "local://auth-plan.html",
    planAbsPath: "/l/auth-plan.html",
    frameId: "p1",
    proposedAt: "2026-08-17T00:00:00.000Z",
  };

  const gateState = (gate: {
    pendingPlan?: PendingPlan | null;
    planSettle?: PlanSettle | null;
  }): BackendState => {
    const base = h.stateWithRecord(null);
    return {
      ...base,
      projects: [
        {
          ...base.projects[0]!,
          sessions: [
            {
              ...base.projects[0]!.sessions[0]!,
              pendingPlan: gate.pendingPlan ?? null,
              planSettle: gate.planSettle ?? null,
            },
          ],
        },
      ],
    };
  };

  /**
   * A fresh store module (init latches per evaluation) with the real
   * onStateChanged handler captured — the entry point every broadcast
   * passes through, and where reconciliation runs.
   */
  const initFreshStore = async (): Promise<{
    store: typeof import("../../store").useStore;
    onStateChanged: (state: BackendState) => void;
  }> => {
    vi.resetModules();
    const { useStore: fresh } = await import("../../store");
    const init = fresh.getState().init();
    const onStateChanged = h.mockBackend.onStateChanged.mock.calls[0]![0] as (
      state: BackendState,
    ) => void;
    await init;
    return { store: fresh, onStateChanged };
  };

  const reviewedTab = (patch: Partial<ReturnType<typeof rpcTabState>> = {}) =>
    rpcTabState({
      planReview: {
        request: {
          title: "add auth",
          planFilePath: "local://auth-plan.html",
          planAbsPath: "/l/auth-plan.html",
        },
        frame: { id: "p1" },
      },
      plans: [{ key: "local://auth-plan.html", title: "add auth", status: "pending" }],
      ...patch,
    });

  it("hydrates a late-joining renderer from the record alone", async () => {
    const { store, onStateChanged } = await initFreshStore();
    store.setState({ rpc: { [h.TAB]: rpcTabState() } });

    onStateChanged(gateState({ pendingPlan: PENDING }));
    let tab = store.getState().rpc[h.TAB]!;
    expect(tab.planReview).toEqual({
      request: {
        title: "add auth",
        planFilePath: "local://auth-plan.html",
        planAbsPath: "/l/auth-plan.html",
      },
      frame: { id: "p1" },
    });
    expect(tab.planDeferred).toBe(false);
    expect(tab.plans).toEqual([
      { key: "local://auth-plan.html", title: "add auth", status: "pending" },
    ]);
    expect(h.mockBackend.readPlanFile).toHaveBeenCalledWith(h.TAB, "/l/auth-plan.html");
    await h.flushMicrotasks();
    tab = store.getState().rpc[h.TAB]!;
    expect(tab.planText).toBe("<h1>Plan</h1>");
    expect(tab.planHtml).toBe("<h1>Plan</h1>");
  });

  it("settles a verdict another client made, matching the proposal frame id", async () => {
    const { store, onStateChanged } = await initFreshStore();
    const planItem = planProposalItem("add auth", "local://auth-plan.html", "/l/auth-plan.html");
    store.setState({ rpc: { [h.TAB]: reviewedTab({ items: [planItem] }) } });

    onStateChanged(gateState({ planSettle: { frameId: "p1", verdict: "executed" } }));
    const tab = store.getState().rpc[h.TAB]!;
    expect(tab.planReview).toBeNull();
    expect(tab.plans).toEqual([
      { key: "local://auth-plan.html", title: "add auth", status: "executed" },
    ]);
    expect(tab.items).toEqual([{ ...planItem, status: "executed" }]);
  });

  it("closes the pane when the settle is for a different gate", async () => {
    const { store, onStateChanged } = await initFreshStore();
    store.setState({ rpc: { [h.TAB]: reviewedTab() } });

    onStateChanged(gateState({ planSettle: { frameId: "p2", verdict: "executed" } }));
    const tab = store.getState().rpc[h.TAB]!;
    expect(tab.planReview).toBeNull();
    expect(tab.planText).toBeNull();
    expect(tab.planDeferred).toBe(false);
    // The row stays a dimmed pending record — no verdict was observed for it.
    expect(tab.plans).toEqual([
      { key: "local://auth-plan.html", title: "add auth", status: "pending" },
    ]);
  });

  it("replaces a stale local review when the record proposes a different frame", async () => {
    const { store, onStateChanged } = await initFreshStore();
    store.setState({
      rpc: {
        [h.TAB]: reviewedTab({
          planReview: {
            request: {
              title: "add auth",
              planFilePath: "local://auth-plan.html",
              planAbsPath: "/l/auth-plan.html",
            },
            frame: { id: "old" },
          },
        }),
      },
    });

    onStateChanged(gateState({ pendingPlan: { ...PENDING, frameId: "new" } }));
    expect(store.getState().rpc[h.TAB]!.planReview?.frame).toEqual({ id: "new" });
  });

  it("marks the sidebar awaiting-answer from the record alone", () => {
    const record = {
      ...h.stateWithRecord(null).projects[0]!.sessions[0]!,
      pendingPlan: PENDING,
    };
    expect(h.deriveSidebarSessionState(record, undefined, undefined)).toBe(
      "awaiting-answer",
    );
  });
});
