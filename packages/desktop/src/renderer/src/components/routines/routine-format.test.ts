import { describe, expect, it } from "vitest";
import type { RoutineRecord, RoutineRunRow } from "@omp-ui/core/routine";
import { visibleRoutines, type RoutineGalleryQuery } from "./routine-format";

function routine(patch: Partial<RoutineRecord> & { id: string }): RoutineRecord {
  return {
    name: patch.id,
    instructions: "",
    schedule: { kind: "cron", expr: "0 8 * * *" },
    timeZone: "UTC",
    destination: { projectCwd: "/projects/one", workspace: "worktree" },
    mode: "build",
    model: null,
    thinkingLevel: null,
    spend: { warnUsd: null, maxUsd: null },
    toolPolicy: { allow: [], deny: [], lastReviewedAt: null, reviewedCatalog: [] },
    scripts: { pre: "", post: "" },
    timeoutMinutes: null,
    notifications: { onStart: false, onComplete: false, onFail: false, onApproval: false, agentMessage: false },
    artifact: null,
    enabled: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastRunTabId: null,
    notices: [],
    ...patch,
  } as RoutineRecord;
}

function run(patch: Partial<RoutineRunRow> & { routineId: string }): RoutineRunRow {
  return {
    id: `run-${patch.routineId}-${patch.firedAtMs ?? 0}`,
    routineName: patch.routineId,
    firedAtMs: 0,
    scheduledForMs: null,
    trigger: "clock",
    outcome: "on-time",
    tabId: null,
    reasonCode: null,
    missed: 0,
    pruned: false,
    staleCatalog: false,
    ...patch,
  } as RoutineRunRow;
}

const query = (patch: Partial<RoutineGalleryQuery> = {}): RoutineGalleryQuery => ({
  query: "",
  filter: "all",
  sort: "next",
  ...patch,
});

const ids = (rows: readonly RoutineRecord[]): string[] => rows.map((r) => r.id);

describe("visibleRoutines (routines gallery)", () => {
  const morning = routine({ id: "morning", name: "Morning overview", nextRunAtMs: 200 });
  const evening = routine({ id: "evening", name: "Evening digest", nextRunAtMs: 100 });
  const paused = routine({ id: "paused", name: "Paused job", enabled: false, nextRunAtMs: 50 });
  const never = routine({ id: "never", name: "Zebra never", enabled: true, nextRunAtMs: null });
  const refresh = routine({
    id: "refresh",
    name: "Refresh dashboard",
    nextRunAtMs: 300,
    artifact: { artifactId: "art-1", datasetIds: ["d"], autoApply: false },
  });
  const all = [morning, evening, paused, never, refresh];
  const runs = [
    run({ routineId: "morning", firedAtMs: 10 }),
    run({ routineId: "evening", firedAtMs: 40, outcome: "waiting-approval" }),
    run({ routineId: "paused", firedAtMs: 20 }),
  ];

  it("sorts by next fire ascending with paused/never last alphabetically", () => {
    expect(ids(visibleRoutines(all, runs, query()))).toEqual([
      "evening",
      "morning",
      "refresh",
      "paused",
      "never",
    ]);
  });

  it("sorts by name and by newest fire with never-run last", () => {
    expect(ids(visibleRoutines(all, runs, query({ sort: "name" })))).toEqual([
      "Evening digest",
      "Morning overview",
      "Paused job",
      "Refresh dashboard",
      "Zebra never",
    ].map((name) => all.find((r) => r.name === name)!.id));
    // Fires: evening 40, paused 20, morning 10; refresh/never have no runs.
    expect(ids(visibleRoutines(all, runs, query({ sort: "lastrun" })))).toEqual([
      "evening",
      "paused",
      "morning",
      "refresh",
      "never",
    ]);
  });

  it("filters enabled, paused, waiting (runs-based), and refresh (artifact-bound)", () => {
    expect(ids(visibleRoutines(all, runs, query({ filter: "enabled" })))).toContain("never");
    expect(ids(visibleRoutines(all, runs, query({ filter: "enabled" }))).includes("paused")).toBe(false);
    expect(ids(visibleRoutines(all, runs, query({ filter: "paused" })))).toEqual(["paused"]);
    expect(ids(visibleRoutines(all, runs, query({ filter: "waiting" })))).toEqual(["evening"]);
    expect(ids(visibleRoutines(all, runs, query({ filter: "refresh" })))).toEqual(["refresh"]);
  });

  it("matches name, project path, and schedule words case-insensitively", () => {
    const weekly = routine({
      id: "weekly",
      name: "Friday report",
      schedule: { kind: "cron", expr: "0 9 * * 5" },
      destination: { projectCwd: "/home/me/Reports", workspace: "checkout" },
    });
    const set = [...all, weekly];
    expect(ids(visibleRoutines(set, runs, query({ query: "friday" })))).toEqual(["weekly"]);
    expect(ids(visibleRoutines(set, runs, query({ query: "reports" })))).toEqual(["weekly"]);
    expect(ids(visibleRoutines(set, runs, query({ query: "fri at 09:00" })))).toEqual(["weekly"]);
    expect(ids(visibleRoutines(set, runs, query({ query: "digest" })))).toEqual(["evening"]);
    expect(visibleRoutines(set, runs, query({ query: "nothing matches" }))).toEqual([]);
  });
});
