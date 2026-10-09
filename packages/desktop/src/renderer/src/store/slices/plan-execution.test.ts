// Plan-execution slice tests (moved verbatim from store.test.ts for #295).
import { describe, expect, it, vi } from "vitest";
import type { PlanAnswerResult } from "@omp-ui/core/plan";
import type {
  BackendState,
  PendingPlan,
  PlanSettle,
} from "@omp-ui/core/types";

import { planProposalItem } from "../../lib/transcript";
import { rpcTabState } from "../../test/fixtures";
import type { RpcTabState } from "../types";
import { h } from "../../test/store-harness";
import { peekTabRuntime } from "./shared";
import { planReviewGateKey } from "./live-work-park";

// The shared bridge mock predates the acknowledged plan-answer channel (issue
// #312 follow-up); an HTML gate settles only through it.
const answerPlanReview = vi.fn(async (): Promise<PlanAnswerResult> => ({ status: "accepted" }));
Object.assign(h.mockBackend, { answerPlanReview });
/** A gated HTML proposal carries the artifact's SHA-256 (64 lowercase hex). */
const SOURCE_HASH = "1f3c".repeat(16);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("plan review: defer keeps the gate unanswered, verdicts answer it", () => {
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

  it("answers the blocked select with refine", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().handleRpcFrame(h.TAB, planReviewFrame("d2"));
    h.useStore.getState().refinePlan(h.TAB);
    expect(
      h.sent.find((s) => s.cmd.type === "extension_ui_response")!.cmd.value,
    ).toBe("refine");
  });

  it("answers the blocked select with execute, un-gated for markdown (§6)", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().handleRpcFrame(h.TAB, planReviewFrame("d3"));
    h.useStore.getState().executePlan(h.TAB, "existing");
    // Markdown keeps its un-gated semantics: the verdict rides the select
    // reply directly and never touches the acknowledged-answer channel (§6).
    expect(
      h.sent.find((s) => s.cmd.type === "extension_ui_response")?.cmd,
    ).toMatchObject({ id: "d3", value: "execute" });
    expect(answerPlanReview).not.toHaveBeenCalled();
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
    expect(h.mockBackend.readPlanFile).toHaveBeenCalledWith(h.TAB, "/l/auth-plan.html");
    await h.flushMicrotasks();
    tab = store.getState().rpc[h.TAB]!;
    expect(tab.planText).toBe("<h1>Plan</h1>");
    expect(tab.planHtml).toBe("<h1>Plan</h1>");
  });

  it("hydrates the record's sourceHash so a late joiner answers with it", async () => {
    const { store, onStateChanged } = await initFreshStore();
    store.setState({ rpc: { [h.TAB]: rpcTabState() } });

    onStateChanged(gateState({ pendingPlan: { ...PENDING, sourceHash: SOURCE_HASH } }));
    // The hash survives hydration: a client that never saw the proposal frame
    // still answers `answerPlanReview` with the identity main validated.
    expect(store.getState().rpc[h.TAB]!.planReview?.request).toEqual({
      title: "add auth",
      planFilePath: "local://auth-plan.html",
      planAbsPath: "/l/auth-plan.html",
      sourceHash: SOURCE_HASH,
    });
  });

  it("hydrates a re-presented gate with its flag (ADR-0033)", async () => {
    const { store, onStateChanged } = await initFreshStore();
    store.setState({ rpc: { [h.TAB]: rpcTabState() } });

    onStateChanged(gateState({ pendingPlan: { ...PENDING, represented: true } }));
    // The flag survives late-join hydration: the execute path must know no
    // advisor review is coming for a review that answers no agent turn.
    expect(store.getState().rpc[h.TAB]!.planReview?.request).toMatchObject({
      represented: true,
    });
  });

  it("settles a verdict another client made, matching the proposal frame id", async () => {
    const { store, onStateChanged } = await initFreshStore();
    const planItem = planProposalItem("add auth", "local://auth-plan.html", "/l/auth-plan.html");
    store.setState({ rpc: { [h.TAB]: reviewedTab({ items: [planItem] }) } });

    onStateChanged(gateState({ planSettle: { frameId: "p1", verdict: "executed" } }));
    const tab = store.getState().rpc[h.TAB]!;
    expect(tab.planReview).toBeNull();
    expect(tab.items).toEqual([{ ...planItem, status: "executed" }]);
  });

  it("settles an invalidated gate with no dispatch and no fold", async () => {
    const { store, onStateChanged } = await initFreshStore();
    const planItem = planProposalItem("add auth", "local://auth-plan.html", "/l/auth-plan.html");
    store.setState({ rpc: { [h.TAB]: reviewedTab({ items: [planItem] }) } });
    h.sent.splice(0);

    onStateChanged(gateState({ planSettle: { frameId: "p1", verdict: "invalidated" } }));
    const tab = store.getState().rpc[h.TAB]!;
    // The validated source changed under review: both representations say so,
    // and no implementation prompt or advisor fold follows a verdict that
    // never happened.
    expect(tab.planReview).toBeNull();
    expect(tab.items).toEqual([{ ...planItem, status: "invalidated" }]);
    expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
    expect(h.sent.some((s) => s.cmd.type === "extension_ui_response")).toBe(false);
  });

  it("closes the pane when the settle is for a different gate", async () => {
    const { store, onStateChanged } = await initFreshStore();
    store.setState({ rpc: { [h.TAB]: reviewedTab() } });

    onStateChanged(gateState({ planSettle: { frameId: "p2", verdict: "executed" } }));
    const tab = store.getState().rpc[h.TAB]!;
    expect(tab.planReview).toBeNull();
    expect(tab.planText).toBeNull();
    expect(tab.planDeferred).toBe(false);
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

  it("record hydration uses full gate provenance and never reloads an unchanged deferred gate", async () => {
    const { store, onStateChanged } = await initFreshStore();
    store.setState({ rpc: { [h.TAB]: rpcTabState() } });
    const pending = { ...PENDING, sourceHash: SOURCE_HASH };
    onStateChanged(gateState({ pendingPlan: pending }));
    await h.flushMicrotasks();
    const sourceKey = store.getState().rpc[h.TAB]!.planSourceKey!;
    store.getState().setPlanReadiness(h.TAB, { sourceKey, status: "ready", identity: SOURCE_HASH });
    store.getState().deferPlanReview(h.TAB);
    onStateChanged(gateState({ pendingPlan: pending }));
    expect(h.mockBackend.readPlanFile).toHaveBeenCalledTimes(1);
    expect(store.getState().rpc[h.TAB]!).toMatchObject({ planDeferred: true, planSourceKey: sourceKey });
    const replacementRead = deferred<string | null>();
    h.mockBackend.readPlanFile.mockReturnValueOnce(replacementRead.promise);
    onStateChanged(gateState({ pendingPlan: { ...pending, sourceHash: "0".repeat(64) } }));
    expect(store.getState().rpc[h.TAB]!).toMatchObject({
      planDeferred: false, planText: null, planHtml: null, planSourceKey: null, planReadiness: null,
    });
    replacementRead.resolve("<p>Record replacement</p>");
    await h.flushMicrotasks();
    expect(store.getState().rpc[h.TAB]!.planText).toBe("<p>Record replacement</p>");
    expect(store.getState().rpc[h.TAB]!.planSourceKey).not.toBe(sourceKey);
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

describe("compacted execution context holds the prompt when compaction stalls (issue #336)", () => {
  const planReviewFrame = (id: string) => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title:
      "omp-ui:plan-review:" +
      JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
  });

  const executeCompacted = (id: string): void => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().handleRpcFrame(h.TAB, planReviewFrame(id));
    h.sent.splice(0);
    h.useStore.getState().executePlan(h.TAB, "compacted", {
      destination: { kind: "project-checkout", branch: "feature/compacted" },
    });
  };

  const implementationPrompts = () =>
    h.sent.filter((s) => s.tabId === h.TAB && s.cmd.type === "prompt");

  it("sends no prompt and posts a warn notice when compaction never settles", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      executeCompacted("c1");
      await h.flushMicrotasks();
      expect(h.sent.some((s) => s.cmd.type === "compact")).toBe(true);

      // 30s alone no longer proves a stall: the execution rides out the
      // whole settle deadline before holding (issue #625).
      await vi.advanceTimersByTimeAsync(h.COMPACT_SETTLE_DEADLINE_MS + 60_000);
      await h.flushMicrotasks();

      expect(implementationPrompts()).toHaveLength(0);
      expect(
        h.sent.some((s) => String(s.cmd.message ?? "").includes("/omp-ui-plan off")),
      ).toBe(false);
      const notices = h.useStore
        .getState()
        .rpc[h.TAB]!.items.filter((i) => i.kind === "notice");
      expect(notices.at(-1)).toMatchObject({
        level: "warn",
        text: expect.stringContaining("compaction did not finish"),
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("dispatches once when the ack lands past the response budget (issue #625)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      executeCompacted("c3");
      await h.flushMicrotasks();
      const compact = h.sent.find((s) => s.cmd.type === "compact")!;
      // A 175s summary is a normal slow compaction, not a wedge.
      await vi.advanceTimersByTimeAsync(175_000);
      h.respond(h.TAB, compact.cmd, { summary: "…" });
      for (let wave = 0; wave < 4; wave++) {
        await h.flushMicrotasks();
        for (const { tabId, cmd } of h.sent.filter((s) => s.cmd.type !== "prompt")) {
          h.respond(tabId, cmd, {});
        }
      }

      expect(implementationPrompts()).toHaveLength(1);
      expect(
        h.useStore
          .getState()
          .rpc[h.TAB]!.items.filter((i) => i.kind === "notice" && i.level === "warn"),
      ).toHaveLength(0);
      expect(h.useStore.getState().rpc[h.TAB]!.compacting).toBeUndefined();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("dispatches the implementation prompt exactly once when compaction lands", async () => {
    executeCompacted("c2");
    await h.flushMicrotasks();
    const compact = h.sent.find((s) => s.cmd.type === "compact")!;
    h.respond(h.TAB, compact.cmd, { summary: "…" });
    for (let wave = 0; wave < 4; wave++) {
      await h.flushMicrotasks();
      for (const { tabId, cmd } of h.sent.filter((s) => s.cmd.type !== "prompt")) {
        h.respond(tabId, cmd, {});
      }
    }

    expect(implementationPrompts()).toHaveLength(1);
    const notices = h.useStore
      .getState()
      .rpc[h.TAB]!.items.filter((i) => i.kind === "notice");
    expect(notices.some((n) => n.text.includes("compaction did not finish"))).toBe(
      false,
    );
  });
});

describe("html gates: only main's accepted answer executes (issue #312 follow-up)", () => {
  const sourceKey = JSON.stringify([JSON.stringify(["g1", "/l/auth-plan.html", SOURCE_HASH]), 1]);
  const htmlTab = (patch: Partial<RpcTabState> = {}) =>
    rpcTabState({
      planReview: {
        request: {
          title: "add auth",
          planFilePath: "local://auth-plan.html",
          planAbsPath: "/l/auth-plan.html",
          sourceHash: SOURCE_HASH,
        },
        frame: { id: "g1" },
      },
      planText: "<h1>Plan</h1>",
      planHtml: "<h1>Plan</h1>",
      planSourceKey: sourceKey,
      planReadiness: { sourceKey, status: "ready", identity: SOURCE_HASH },
      ...patch,
    });

  const implementationPrompts = () =>
    h.sent.filter((s) => s.tabId === h.TAB && s.cmd.type === "prompt");

  it("a rejected execute dispatches nothing and settles nothing from this client", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: htmlTab({ planDeferred: true }) } });
    answerPlanReview.mockResolvedValueOnce({
      status: "rejected",
      reason: "source-changed",
    });

    h.useStore.getState().executePlan(h.TAB, "existing");
    const runtime = peekTabRuntime(h.TAB)!;
    runtime.liveReviewAutoRequestedGateKey = "remembered";
    runtime.liveReviewAppliedSourceKey = sourceKey;
    await h.flushMicrotasks();

    expect(answerPlanReview).toHaveBeenCalledWith(
      h.TAB,
      "g1",
      "execute",
      SOURCE_HASH,
    );
    // The gate stays unanswered — a rejected client must not be the one to
    // release the blocked agent, and nothing may reach the implementation.
    expect(h.sent.some((s) => s.cmd.type === "extension_ui_response")).toBe(false);
    expect(implementationPrompts()).toHaveLength(0);
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.planReview).not.toBeNull();
    expect(tab.planDeferred).toBe(true);
    expect(tab.planSourceKey).toBe(sourceKey);
    expect(tab.planReadiness).toEqual({ sourceKey, status: "ready", identity: SOURCE_HASH });
    expect(runtime.liveReviewAutoRequestedGateKey).toBe("remembered");
    expect(runtime.liveReviewAppliedSourceKey).toBe(sourceKey);
  });

  it.each([
    ["no local preparation at all", null],
    ["a preparation that failed", { sourceKey, status: "failed" as const }],
    [
      "a ready preparation of a different source",
      { sourceKey, status: "ready" as const, identity: "0".repeat(64) },
    ],
    ["a ready preparation from an older read", { sourceKey: "old", status: "ready" as const, identity: SOURCE_HASH }],
  ])("executes nothing for %s, however executePlan is called", async (_label, readiness) => {
    h.useStore.setState({ rpc: { [h.TAB]: htmlTab({ planReadiness: readiness }) } });

    h.useStore.getState().executePlan(h.TAB, "existing");
    await h.flushMicrotasks();

    expect(answerPlanReview).not.toHaveBeenCalled();
    expect(h.sent.some((s) => s.cmd.type === "extension_ui_response")).toBe(false);
    expect(implementationPrompts()).toHaveLength(0);
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).not.toBeNull();
  });

  it.each(["execute", "refine"] as const)("a delayed accepted %s cannot retire or dispatch into a newer gate", async (verdict) => {
    h.useStore.setState({ rpc: { [h.TAB]: htmlTab() } });
    const answer = deferred<PlanAnswerResult>();
    answerPlanReview.mockReturnValueOnce(answer.promise);
    if (verdict === "execute") h.useStore.getState().executePlan(h.TAB, "existing");
    else h.useStore.getState().refinePlan(h.TAB, { text: "only the old gate" });
    const replacement = htmlTab().planReview!;
    replacement.request.sourceHash = "0".repeat(64);
    h.useStore.getState().acceptPlanReview(h.TAB, replacement);
    await h.flushMicrotasks();
    const newer = h.useStore.getState().rpc[h.TAB]!;
    answer.resolve({ status: "accepted" });
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).toEqual(replacement);
    expect(h.useStore.getState().rpc[h.TAB]!.planSourceKey).toBe(newer.planSourceKey);
    expect(implementationPrompts()).toHaveLength(0);
    expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
  });
});

describe("review artifact provenance and gate lifetime", () => {
  const review = (patch: Partial<NonNullable<RpcTabState["planReview"]>["request"]> = {}, id = "source-gate") => ({
    request: {
      title: "reviewed artifact",
      planFilePath: "local://p.html",
      planAbsPath: "/l/p.html",
      sourceHash: SOURCE_HASH,
      ...patch,
    },
    frame: { id },
  });
  const tab = () => h.useStore.getState().rpc[h.TAB]!;
  const seed = () => h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  const publishReady = () => h.useStore.getState().setPlanReadiness(h.TAB, {
    sourceKey: tab().planSourceKey!, status: "ready", identity: SOURCE_HASH,
  });

  it("repeated delivery is a no-op, including the read, deferral, and overview accounting", async () => {
    seed();
    const gate = review();
    h.useStore.getState().acceptPlanReview(h.TAB, gate);
    await h.flushMicrotasks();
    publishReady();
    h.useStore.getState().deferPlanReview(h.TAB);
    const runtime = peekTabRuntime(h.TAB)!;
    runtime.liveReviewAutoRequestedGateKey = planReviewGateKey(gate);
    runtime.liveReviewAppliedSourceKey = tab().planSourceKey;
    const before = tab();
    const sequence = runtime.planReadSequence;
    h.useStore.getState().acceptPlanReview(h.TAB, review({ title: "repeated title" }));
    expect(h.mockBackend.readPlanFile).toHaveBeenCalledTimes(1);
    expect(tab()).toBe(before);
    expect(runtime.planReadSequence).toBe(sequence);
    expect(runtime.liveReviewAutoRequestedGateKey).toBe(planReviewGateKey(gate));
    expect(runtime.liveReviewAppliedSourceKey).toBe(before.planSourceKey);
  });

  it.each([
    { planAbsPath: "/l/replaced.html" },
    { sourceHash: "0".repeat(64) },
  ])("replacement resets bytes and readiness even when the frame id is reused: %o", async (change) => {
    seed();
    h.useStore.getState().acceptPlanReview(h.TAB, review());
    await h.flushMicrotasks();
    publishReady();
    h.useStore.getState().deferPlanReview(h.TAB);
    const runtime = peekTabRuntime(h.TAB)!;
    runtime.liveWorkPark = true;
    runtime.liveOutputLoudAt = 123;
    runtime.liveOrphanRestart = true;
    runtime.liveReviewAutoRequestedGateKey = "old";
    runtime.liveReviewAppliedSourceKey = tab().planSourceKey;
    const replacementRead = deferred<string | null>();
    h.mockBackend.readPlanFile.mockReturnValueOnce(replacementRead.promise);
    const replacement = review(change);
    h.useStore.getState().acceptPlanReview(h.TAB, replacement);
    expect(tab()).toMatchObject({
      planReview: replacement, planText: null, planHtml: null,
      planSourceKey: null, planReadiness: null, planDeferred: false,
    });
    expect(tab().planVoice.ready).toBe(false);
    expect(runtime.liveWorkPark).toBe(false);
    expect(runtime.liveOutputLoudAt).toBeUndefined();
    expect(runtime.liveOrphanRestart).toBe(false);
    expect(runtime.liveReviewAutoRequestedGateKey).toBeUndefined();
    expect(runtime.liveReviewAppliedSourceKey).toBeNull();
    replacementRead.resolve("<p>New artifact</p>");
    await h.flushMicrotasks();
    expect(tab().planText).toBe("<p>New artifact</p>");
  });

  it("an older gate read enriches only its own history row", async () => {
    const oldItem = planProposalItem("old", "local://old.html", "/l/old.html");
    const newItem = planProposalItem("new", "local://new.html", "/l/new.html");
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ items: [oldItem, newItem] }) } });
    const oldRead = deferred<string | null>();
    h.mockBackend.readPlanFile.mockReturnValueOnce(oldRead.promise);
    h.useStore.getState().acceptPlanReview(h.TAB, review({ planFilePath: "local://old.html", planAbsPath: "/l/old.html" }), oldItem.id);
    h.useStore.getState().acceptPlanReview(h.TAB, review({ planFilePath: "local://new.html", planAbsPath: "/l/new.html" }, "new-gate"), newItem.id);
    await h.flushMicrotasks();
    publishReady();
    const source = tab().planSourceKey;
    oldRead.resolve("<p>Old artifact</p>");
    await h.flushMicrotasks();
    expect(tab().planText).toBe("<h1>Plan</h1>");
    expect(tab().planSourceKey).toBe(source);
    expect(tab().planReadiness?.sourceKey).toBe(source);
    expect(tab().items.find((i) => i.id === oldItem.id)).toMatchObject({ text: "<p>Old artifact</p>" });
    expect(tab().items.find((i) => i.id === newItem.id)).toMatchObject({ text: "<h1>Plan</h1>" });
  });

  it("overlapping reads of one gate accept only the newest sequence and reject old readiness cleanup", async () => {
    seed();
    h.useStore.getState().acceptPlanReview(h.TAB, review());
    await h.flushMicrotasks();
    publishReady();
    const oldSource = tab().planSourceKey!;
    const oldRead = deferred<string | null>();
    const freshRead = deferred<string | null>();
    h.mockBackend.readPlanFile.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise);
    const oldLoad = h.useStore.getState().loadPlanText(h.TAB, "/l/p.html");
    const newLoad = h.useStore.getState().loadPlanText(h.TAB, "/l/p.html");
    freshRead.resolve("<p>Fresh bytes</p>");
    await newLoad;
    const freshSource = tab().planSourceKey!;
    expect(freshSource).not.toBe(oldSource);
    publishReady();
    h.useStore.getState().setPlanReadiness(h.TAB, { sourceKey: oldSource, status: "ready", identity: SOURCE_HASH });
    h.useStore.getState().setPlanReadiness(h.TAB, null);
    oldRead.reject(new Error("late old failure"));
    await oldLoad;
    expect(tab().planText).toBe("<p>Fresh bytes</p>");
    expect(tab().planSourceKey).toBe(freshSource);
    expect(tab().planReadiness).toEqual({ sourceKey: freshSource, status: "ready", identity: SOURCE_HASH });
  });

  it("a latest read failure cannot be undone by an older success", async () => {
    seed();
    const oldRead = deferred<string | null>();
    const freshRead = deferred<string | null>();
    h.mockBackend.readPlanFile.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise);
    h.useStore.getState().acceptPlanReview(h.TAB, review());
    const freshLoad = h.useStore.getState().loadPlanText(h.TAB, "/l/p.html");
    freshRead.reject(new Error("latest read failed"));
    await freshLoad;
    oldRead.resolve("<p>Obsolete bytes</p>");
    await h.flushMicrotasks();
    expect(tab()).toMatchObject({ planText: null, planHtml: null, planSourceKey: null, planReadiness: null });
    expect(tab().planVoice.ready).toBe(false);
    expect(tab().planVoice.error).not.toBeNull();
    h.useStore.getState().executePlan(h.TAB, "existing");
    expect(answerPlanReview).not.toHaveBeenCalled();
  });

  it("a read begun without a gate never qualifies a later review", async () => {
    seed();
    const unownedRead = deferred<string | null>();
    const gateRead = deferred<string | null>();
    h.mockBackend.readPlanFile.mockReturnValueOnce(unownedRead.promise).mockReturnValueOnce(gateRead.promise);
    const historyLoad = h.useStore.getState().loadPlanText(h.TAB, "/l/p.html");
    h.useStore.getState().acceptPlanReview(h.TAB, review());
    unownedRead.resolve("<p>Not reviewed</p>");
    await historyLoad;
    expect(tab()).toMatchObject({ planText: null, planHtml: null, planSourceKey: null });
    gateRead.resolve("<p>Reviewed</p>");
    await h.flushMicrotasks();
    expect(tab().planText).toBe("<p>Reviewed</p>");
  });

  it("a replacement process is a lifetime boundary even for an identical gate and read sequence", async () => {
    seed();
    const obsoleteRead = deferred<string | null>();
    h.mockBackend.readPlanFile.mockReturnValueOnce(obsoleteRead.promise);
    h.useStore.getState().acceptPlanReview(h.TAB, review());
    const oldRuntime = peekTabRuntime(h.TAB)!;
    await h.driveBoot(h.TAB);
    expect(tab()).toMatchObject({ planSourceKey: null, planReadiness: null, planVoice: { ready: false, busy: false, error: null } });
    h.useStore.getState().acceptPlanReview(h.TAB, review());
    await h.flushMicrotasks();
    publishReady();
    const source = tab().planSourceKey;
    expect(peekTabRuntime(h.TAB)).not.toBe(oldRuntime);
    obsoleteRead.resolve("<p>Dead process artifact</p>");
    await h.flushMicrotasks();
    expect(tab().planText).toBe("<h1>Plan</h1>");
    expect(tab().planSourceKey).toBe(source);
    expect(tab().planReadiness?.sourceKey).toBe(source);
  });

  it("expected-key retirement preserves a newer gate and current-key retirement clears all readiness", async () => {
    seed();
    const old = review();
    h.useStore.getState().acceptPlanReview(h.TAB, old);
    await h.flushMicrotasks();
    const newer = review({ sourceHash: "0".repeat(64) });
    h.useStore.getState().acceptPlanReview(h.TAB, newer);
    await h.flushMicrotasks();
    const current = tab();
    h.useStore.getState().clearPlanReview(h.TAB, planReviewGateKey(old));
    expect(tab()).toBe(current);
    h.useStore.getState().clearPlanReview(h.TAB, planReviewGateKey(newer));
    expect(tab()).toMatchObject({
      planReview: null, planText: null, planHtml: null, planSourceKey: null,
      planReadiness: null, planDeferred: false, planVoice: { ready: false, busy: false, error: null },
    });
    expect(peekTabRuntime(h.TAB)?.liveReviewAppliedSourceKey).toBeNull();
    expect(peekTabRuntime(h.TAB)?.liveReviewAutoRequestedGateKey).toBeUndefined();
  });

  it("a late source read cannot reopen a retired Markdown review", async () => {
    seed();
    const reading = deferred<string | null>();
    h.mockBackend.readPlanFile.mockReturnValueOnce(reading.promise);
    h.useStore.getState().acceptPlanReview(h.TAB, review({
      planFilePath: "local://p.md", planAbsPath: "/l/p.md",
    }));
    h.useStore.getState().executePlan(h.TAB, "existing");
    expect(h.sent.find((s) => s.cmd.type === "extension_ui_response")?.cmd).toMatchObject({
      id: "source-gate", value: "execute",
    });
    reading.resolve("# Late artifact");
    await h.flushMicrotasks();
    expect(tab()).toMatchObject({
      planReview: null, planText: null, planHtml: null, planSourceKey: null,
      planReadiness: null, planVoice: { ready: false, busy: false, error: null },
    });
    expect(answerPlanReview).not.toHaveBeenCalled();
    expect(h.sent.filter((s) => s.tabId === h.TAB && s.cmd.type === "prompt")).toHaveLength(1);
  });

  it("null reads remain unavailable and requested format controls HTML preparation", async () => {
    seed();
    const unavailableRead = deferred<string | null>();
    h.mockBackend.readPlanFile.mockReturnValueOnce(unavailableRead.promise);
    h.useStore.getState().acceptPlanReview(h.TAB, review());
    expect(h.mockBackend.readPlanFile).toHaveBeenLastCalledWith(h.TAB, "/l/p.html");
    unavailableRead.resolve(null);
    await h.flushMicrotasks();
    expect(tab().planSourceKey).toBeNull();
    expect(tab().planVoice.ready).toBe(false);
    expect(tab().planVoice.error).not.toBeNull();
    h.useStore.getState().setPlanReadiness(h.TAB, { sourceKey: "unloaded", status: "ready", identity: SOURCE_HASH });
    expect(tab().planReadiness).toBeNull();
    const htmlRead = deferred<string | null>();
    h.mockBackend.readPlanFile.mockReturnValueOnce(htmlRead.promise);
    h.useStore.getState().acceptPlanReview(h.TAB, review({ planAbsPath: "/l/no-extension" }, "new"));
    expect(h.mockBackend.readPlanFile).toHaveBeenLastCalledWith(h.TAB, "/l/no-extension");
    htmlRead.resolve("<p>HTML bytes</p>");
    await h.flushMicrotasks();
    expect(tab().planHtml).toBe("<p>HTML bytes</p>");
    expect(tab().planText).toBe("<p>HTML bytes</p>");
    expect(tab().planSourceKey).not.toBeNull();
    expect(tab().planReadiness).toBeNull();
    expect(tab().planVoice.ready).toBe(false);
    publishReady();
    expect(tab().planReadiness?.sourceKey).toBe(tab().planSourceKey);
  });
});

describe("re-presented reviews (ADR-0033)", () => {
  const representedTab = (patch: Partial<RpcTabState> = {}) =>
    rpcTabState({
      planReview: {
        request: { title: "t", planFilePath: "local://p.md", planAbsPath: null, represented: true },
        frame: { id: "r1" },
      },
      ...patch,
    });

  const advisorConfigured = {
    available: true,
    configured: true,
    active: true,
    model: "m",
    subscription: false,
    contextWindow: 200000,
    contextTokens: 0,
    cost: 0,
    totalTokens: 0,
    advisors: [],
    configWarnings: [],
  };

  it("executes without waiting for an advisor review no turn will produce", async () => {
    vi.useFakeTimers();
    try {
      h.useStore.setState({
        rpc: { [h.TAB]: representedTab({ advisorStats: advisorConfigured }) },
      });
      h.useStore.getState().executePlan(h.TAB, "existing");
      await h.flushMicrotasks();
      // The counterpart of the advisor-fold test: a represented review answers
      // no drafting turn, so the implementation dispatches immediately — no
      // timer may be advanced and no concern notice may appear.
      expect(
        h.sent.find((s) => s.cmd.type === "extension_ui_response")!.cmd,
      ).toMatchObject({ id: "r1", value: "execute" });
      expect(h.sent.filter((s) => s.tabId === h.TAB && s.cmd.type === "prompt")).toHaveLength(1);
      const notices = h.useStore
        .getState()
        .rpc[h.TAB]!.items.filter((i) => i.kind === "notice");
      expect(
        notices.some((n) => n.text.includes("waiting for the advisor")),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the plan file in a re-presented refine's notes", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: representedTab() } });
    h.useStore.getState().refinePlan(h.TAB, { text: "drop X" });
    await h.flushMicrotasks();
    // The refine ToolResult that would have named the file is discarded — the
    // prompt must name it so the planner revises the right artifact.
    const prompt = h.sent.find((s) => s.cmd.type === "prompt");
    expect(String(prompt?.cmd.message)).toContain("local://p.md");
    expect(String(prompt?.cmd.message)).toContain("drop X");
  });

  it("representPlan turns Plan on first, then sends the review verb", async () => {
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ plan: null }) },
    });
    const promise = h.useStore.getState().representPlan(h.TAB, "local://p-plan.html", "t");
    const first = h.sent.find((s) => s.cmd.type === "prompt")!;
    expect(String(first.cmd.message)).toBe("/omp-ui-plan on html");
    // Each command awaits its response frame before the next is sent.
    h.respond(h.TAB, first.cmd, {});
    await h.flushMicrotasks();
    const second = h.sent.filter((s) => s.cmd.type === "prompt")[1]!;
    expect(String(second.cmd.message)).toBe(
      "/omp-ui-plan review local://p-plan.html t",
    );
    h.respond(h.TAB, second.cmd, {});
    await promise;
  });

  it("representPlan sends nothing while a turn runs", async () => {
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ status: "running" }) },
    });
    await h.useStore.getState().representPlan(h.TAB, "local://p-plan.html", "t");
    expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
  });

  it("dismissProposedPlan calls the channel, surfacing an older host's error", async () => {
    const dismiss = vi.fn(async (): Promise<void> => {});
    Object.assign(h.mockBackend, { dismissProposedPlan: dismiss });
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    await h.useStore.getState().dismissProposedPlan(h.TAB, "local://p-plan.html");
    expect(dismiss).toHaveBeenCalledWith(h.TAB, "local://p-plan.html");

    Object.assign(h.mockBackend, {
      dismissProposedPlan: vi.fn(async () => {
        throw new Error("no such channel");
      }),
    });
    await h.useStore.getState().dismissProposedPlan(h.TAB, "local://p-plan.html");
    const notices = h.useStore.getState().rpc[h.TAB]!.items.filter((i) => i.kind === "notice");
    expect(notices.at(-1)).toMatchObject({
      level: "warn",
      text: expect.stringContaining("no such channel"),
    });
  });
});
