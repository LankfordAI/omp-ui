import type {
  PlanImplementationSource,
  SessionSummary,
} from "@omp-ui/core/types";
import { describe, expect, it } from "vitest";
import { PAGE } from "./session-window";
import {
  type ArrangedSessionHandoffs,
  arrangeSessionHandoffs,
} from "./session-handoffs";

const PROJECT = "/project";
const ALL = 100;

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
    planImplementationSource: null,
    launchedAt: "2026-08-19T12:00:00.000Z",
    mode: "rpc-ui",
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
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

function ids(result: ArrangedSessionHandoffs): string[] {
  return result.entries.map((entry) => entry.session.tabId);
}

describe("arrangeSessionHandoffs", () => {
  it("places a source before its newer implementation", () => {
    const implementation = session("implementation", {
      planImplementationSource: source("plan"),
    });
    const plan = session("plan");

    const result = arrangeSessionHandoffs([implementation, plan], "", false, ALL, null);

    expect(ids(result)).toEqual(["plan", "implementation"]);
    expect(result.entries).toMatchObject([
      {
        depth: 0,
        source: null,
        orphanSource: null,
        hasDescendants: true,
        treeId: "plan",
      },
      {
        depth: 1,
        source: { tabId: "plan" },
        orphanSource: null,
        hasDescendants: false,
        treeId: "plan",
      },
    ]);
    expect(result).toMatchObject({ shown: 2, remaining: 0, total: 2 });
  });

  it("supports multiple children and orders sibling subtrees by their newest member", () => {
    const newestGrandchild = session("newest-grandchild", {
      planImplementationSource: source("older-child"),
    });
    const newerChild = session("newer-child", {
      planImplementationSource: source("plan"),
    });
    const olderChild = session("older-child", {
      planImplementationSource: source("plan"),
    });
    const plan = session("plan");

    const result = arrangeSessionHandoffs(
      [newestGrandchild, newerChild, olderChild, plan],
      "",
      false,
      ALL,
      null,
    );

    expect(ids(result)).toEqual(["plan", "older-child", "newest-grandchild", "newer-child"]);
  });

  it("keeps immediate sources through a chain and caps only visual depth", () => {
    const fourth = session("fourth", { planImplementationSource: source("grandchild") });
    const grandchild = session("grandchild", { planImplementationSource: source("child") });
    const child = session("child", { planImplementationSource: source("plan") });
    const plan = session("plan");

    const result = arrangeSessionHandoffs([fourth, grandchild, child, plan], "", false, ALL, null);

    expect(ids(result)).toEqual(["plan", "child", "grandchild", "fourth"]);
    expect(result.entries.map(({ depth, source: immediateSource }) => [
      depth,
      immediateSource?.tabId ?? null,
    ])).toEqual([
      [0, null],
      [1, "plan"],
      [2, "child"],
      [2, "grandchild"],
    ]);
  });

  it("sorts whole trees by their newest member rather than their root", () => {
    const newestImplementation = session("implementation", {
      planImplementationSource: source("old-plan"),
    });
    const standalone = session("standalone");
    const oldPlan = session("old-plan");

    const result = arrangeSessionHandoffs(
      [newestImplementation, standalone, oldPlan],
      "",
      false,
      ALL,
      null,
    );

    expect(ids(result)).toEqual(["old-plan", "implementation", "standalone"]);
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

    const result = arrangeSessionHandoffs(
      [missing, crossProject, crossProjectPlan],
      "",
      false,
      ALL,
      null,
    );

    expect(ids(result)).toEqual([
      "missing-implementation",
      "cross-project-implementation",
      "other-plan",
    ]);
    expect(result.entries[0]).toMatchObject({ source: null, orphanSource: missingSource });
    expect(result.entries[1]).toMatchObject({ source: null, orphanSource: crossProjectSource });
  });

  it("keeps a source marked missing independent and exposes only its saved snapshot", () => {
    const missingSource = source("missing-plan", "Saved files-gone plan");
    const implementation = session("implementation", {
      planImplementationSource: missingSource,
    });
    const standalone = session("standalone");
    const missingPlan = session("missing-plan", { live: "missing" });

    const result = arrangeSessionHandoffs(
      [implementation, standalone, missingPlan],
      "",
      false,
      ALL,
      null,
    );

    expect(ids(result)).toEqual(["implementation", "standalone", "missing-plan"]);
    expect(result.entries).toMatchObject([
      {
        session: { tabId: "implementation" },
        depth: 0,
        source: null,
        orphanSource: missingSource,
        hasDescendants: false,
        treeId: "implementation",
      },
      {
        session: { tabId: "standalone" },
        depth: 0,
        source: null,
        orphanSource: null,
        hasDescendants: false,
        treeId: "standalone",
      },
      {
        session: { tabId: "missing-plan", live: "missing" },
        depth: 0,
        source: null,
        orphanSource: null,
        hasDescendants: false,
        treeId: "missing-plan",
      },
    ]);
  });

  it("falls self-links and every cycle member back to independent recency rows", () => {
    const selfSource = source("self", "Self plan");
    const sourceA = source("b", "Plan B");
    const sourceB = source("a", "Plan A");
    const self = session("self", { planImplementationSource: selfSource });
    const a = session("a", { planImplementationSource: sourceA });
    const b = session("b", { planImplementationSource: sourceB });

    const result = arrangeSessionHandoffs([self, a, b], "", false, ALL, null);

    expect(ids(result)).toEqual(["self", "a", "b"]);
    expect(result.entries.map(({ source: immediateSource, orphanSource, treeId }) => ({
      source: immediateSource,
      orphanSource,
      treeId,
    }))).toEqual([
      { source: null, orphanSource: selfSource, treeId: "self" },
      { source: null, orphanSource: sourceA, treeId: "a" },
      { source: null, orphanSource: sourceB, treeId: "b" },
    ]);
  });

  it("searches titles and saved plan titles at whole-tree scope", () => {
    const implementation = session("implementation", {
      title: "Build the ordinary thing",
      planImplementationSource: source("plan", "Celestial migration"),
    });
    const plan = session("plan", { title: "An unrelated session title" });
    const unrelated = session("unrelated", { title: "Nothing to see" });

    const titleMatch = arrangeSessionHandoffs(
      [implementation, plan, unrelated],
      "ordinary",
      false,
      ALL,
      null,
    );
    const savedPlanMatch = arrangeSessionHandoffs(
      [implementation, plan, unrelated],
      "celestial",
      false,
      ALL,
      null,
    );
    const projectMatch = arrangeSessionHandoffs(
      [implementation, plan, unrelated],
      "no session matches this",
      true,
      ALL,
      null,
    );

    expect(ids(titleMatch)).toEqual(["plan", "implementation"]);
    expect(ids(savedPlanMatch)).toEqual(["plan", "implementation"]);
    expect(ids(projectMatch)).toEqual(["plan", "implementation", "unrelated"]);
    expect(savedPlanMatch.total).toBe(2);
  });

  it("widens through the end of a focused descendant's tree", () => {
    const youngest = session("youngest", { planImplementationSource: source("child") });
    const child = session("child", { planImplementationSource: source("plan") });
    const plan = session("plan");
    const trailing = session("trailing");

    const result = arrangeSessionHandoffs(
      [youngest, child, plan, trailing],
      "",
      false,
      1,
      "child",
    );

    expect(ids(result)).toEqual(["plan", "child", "youngest"]);
    expect(result).toMatchObject({ shown: 3, remaining: 1, total: 4 });
  });

  it("extends a PAGE boundary through the final intersected tree", () => {
    const preceding = Array.from({ length: PAGE - 1 }, (_, index) =>
      session(`standalone-${index}`),
    );
    const implementation = session("implementation", {
      planImplementationSource: source("plan"),
    });
    const plan = session("plan");
    const trailing = session("trailing");

    const result = arrangeSessionHandoffs(
      [...preceding, implementation, plan, trailing],
      "",
      false,
      PAGE,
      null,
    );

    expect(ids(result)).toEqual([
      ...preceding.map(({ tabId }) => tabId),
      "plan",
      "implementation",
    ]);
    expect(result).toMatchObject({ shown: PAGE + 1, remaining: 1, total: PAGE + 2 });
  });
});
