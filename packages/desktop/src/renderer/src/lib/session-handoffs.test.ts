import type {
  PlanImplementationSource,
  SessionSummary,
} from "@omp-ui/core/types";
import { describe, expect, it } from "vitest";
import { NO_HANDOFF, resolveSessionHandoffs } from "./session-handoffs";

const PROJECT = "/project";

function source(
  sourceTabId: string,
  planTitle = `Plan from ${sourceTabId}`,
): PlanImplementationSource {
  return {
    sourceTabId,
    planTitle,
    planFilePath: `local://plans/${sourceTabId}.md`,
  };
}

function session(tabId: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    tabId,
    sessionId: null,
    lineageDir: `lineage-${tabId}`,
    projectCwd: PROJECT,
    worktree: null,
    planImplementationSource: null, experiment: null, fleet: null,
    launchedAt: "2026-08-19T12:00:00.000Z",
    mode: "rpc-ui",
    model: null,
    thinkingLevel: null,
    agentMode: "build",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
 proposedPlans: [],
 autoTitled: false,
 snoozed: false,
 snoozedUntilMs: null,
 pinnedAtMs: null,
 heldPrompt: null,
 private: false,
 chat: false,
 askSource: null,
    cachedTitle: null,
    cachedModified: null,
    title: `Session ${tabId}`,
    status: null,
    live: "dormant",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  };
}

describe("resolveSessionHandoffs", () => {
  it("links an implementation to its same-project source wherever it sits", () => {
    const implementation = session("implementation", {
      planImplementationSource: source("plan"),
    });
    const standalone = session("standalone");
    const plan = session("plan");

    const result = resolveSessionHandoffs([implementation, standalone, plan]);

    expect(result.get("implementation")).toEqual({
      source: plan,
      orphanSource: null,
      hasDescendants: false,
    });
    expect(result.get("plan")).toEqual({ source: null, orphanSource: null, hasDescendants: true });
    expect(result.get("standalone")).toEqual(NO_HANDOFF);
  });

  it("keeps the immediate source through a chain", () => {
    const fourth = session("fourth", { planImplementationSource: source("grandchild") });
    const grandchild = session("grandchild", { planImplementationSource: source("child") });
    const child = session("child", { planImplementationSource: source("plan") });
    const plan = session("plan");

    const result = resolveSessionHandoffs([fourth, grandchild, child, plan]);

    expect(
      ["plan", "child", "grandchild", "fourth"].map((id) => [
        result.get(id)?.source?.tabId ?? null,
        result.get(id)?.hasDescendants,
      ]),
    ).toEqual([
      [null, true],
      ["plan", true],
      ["child", true],
      ["grandchild", false],
    ]);
  });

  it("leaves missing and cross-project sources orphaned with their saved metadata", () => {
    const missingSource = source("missing", "Saved missing plan");
    const crossProjectPlan = session("other-plan", { projectCwd: "/other-project" });
    const crossProjectSource = source("other-plan", "Saved cross-project plan");
    const missing = session("missing-implementation", {
      planImplementationSource: missingSource,
    });
    const crossProject = session("cross-project-implementation", {
      planImplementationSource: crossProjectSource,
    });

    const result = resolveSessionHandoffs([missing, crossProject, crossProjectPlan]);

    expect(result.get("missing-implementation")).toEqual({
      source: null,
      orphanSource: missingSource,
      hasDescendants: false,
    });
    expect(result.get("cross-project-implementation")).toEqual({
      source: null,
      orphanSource: crossProjectSource,
      hasDescendants: false,
    });
    expect(result.get("other-plan")).toEqual(NO_HANDOFF);
  });

  it("keeps a source marked missing independent and exposes only its saved snapshot", () => {
    const missingSource = source("missing-plan", "Saved files-gone plan");
    const implementation = session("implementation", {
      planImplementationSource: missingSource,
    });
    const missingPlan = session("missing-plan", { live: "missing" });

    const result = resolveSessionHandoffs([implementation, missingPlan]);

    expect(result.get("implementation")).toEqual({
      source: null,
      orphanSource: missingSource,
      hasDescendants: false,
    });
    expect(result.get("missing-plan")).toEqual(NO_HANDOFF);
  });

  it("falls self-links and every cycle member back to their saved snapshots", () => {
    const selfSource = source("self", "Self plan");
    const sourceA = source("b", "Plan B");
    const sourceB = source("a", "Plan A");
    const self = session("self", { planImplementationSource: selfSource });
    const a = session("a", { planImplementationSource: sourceA });
    const b = session("b", { planImplementationSource: sourceB });

    const result = resolveSessionHandoffs([self, a, b]);

    expect(result.get("self")).toEqual({ source: null, orphanSource: selfSource, hasDescendants: false });
    expect(result.get("a")).toEqual({ source: null, orphanSource: sourceA, hasDescendants: false });
    expect(result.get("b")).toEqual({ source: null, orphanSource: sourceB, hasDescendants: false });
  });

  it("treats a duplicated source tab id as unresolvable and keeps the first row's entry", () => {
    const dupSource = source("dup", "Ambiguous plan");
    const implementation = session("implementation", { planImplementationSource: dupSource });
    const first = session("dup", { title: "first" });
    const second = session("dup", {
      title: "second",
      planImplementationSource: source("other"),
    });
    const other = session("other");

    const result = resolveSessionHandoffs([implementation, first, second, other]);

    expect(result.get("implementation")).toEqual({
      source: null,
      orphanSource: dupSource,
      hasDescendants: false,
    });
    // First occurrence wins: the second "dup" row's link to "other" never surfaces.
    expect(result.get("dup")).toEqual(NO_HANDOFF);
    expect(result.get("other")).toEqual({ source: null, orphanSource: null, hasDescendants: true });
  });

  it("ignores malformed saved metadata", () => {
    const broken = session("broken", {
      planImplementationSource: { sourceTabId: "plan" } as unknown as PlanImplementationSource,
    });
    const plan = session("plan");

    const result = resolveSessionHandoffs([broken, plan]);

    expect(result.get("broken")).toEqual(NO_HANDOFF);
    expect(result.get("plan")).toEqual(NO_HANDOFF);
  });
});
