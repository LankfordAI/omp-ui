import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineRunHistory, type OwnedSessionRecord, type RoutineRunRow } from "@omp-ui/core";
import { RoutineRetention } from "./routine-retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const ROUTINE_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const MARK = { id: ROUTINE_ID, name: "Inbox", approvalEntries: {}, deniedBuiltins: [], warnCostUsd: 2, maxCostUsd: 5 };

function rec(tabId: string, launchedDaysAgo: number, modifiedDaysAgo: number | null, routine = true): OwnedSessionRecord {
  return {
    tabId,
    routine: routine ? MARK : null,
    launchedAt: new Date(NOW - launchedDaysAgo * DAY).toISOString(),
    cachedModified: modifiedDaysAgo === null ? null : new Date(NOW - modifiedDaysAgo * DAY).toISOString(),
  } as unknown as OwnedSessionRecord;
}

function row(id: string, tabId: string | null, firedDaysAgo: number): RoutineRunRow {
  return {
    id,
    routineId: ROUTINE_ID,
    routineName: "Inbox",
    firedAtMs: NOW - firedDaysAgo * DAY,
    scheduledForMs: null,
    trigger: "clock",
    outcome: "on-time",
    tabId,
    reasonCode: null,
    missed: 0,
    pruned: false,
    staleCatalog: false,
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-routine-ret-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function harness(sessions: OwnedSessionRecord[], rows: RoutineRunRow[]) {
  const history = new RoutineRunHistory(path.join(dir, "routine-runs.json"));
  for (const r of [...rows].reverse()) history.record(r);
  const live = new Set<string>();
  const awaiting = new Set<string>();
  const enabled = { value: true };
  const deleteSession = vi.fn(async (tabId: string) => {
    const i = sessions.findIndex((s) => s.tabId === tabId);
    if (i >= 0) sessions.splice(i, 1);
  });
  const retention = new RoutineRetention({
    history,
    isEnabled: () => enabled.value,
    sessions: () => sessions,
    isLive: (t) => live.has(t),
    awaitingHumanAnswer: (t) => awaiting.has(t),
    deleteSession,
    publish: () => {},
    now: () => NOW,
  });
  return { retention, history, live, awaiting, enabled, deleteSession, sessions };
}

describe("RoutineRetention (U11)", () => {
  it("deletes a 31-day-inactive dormant run via deleteSession(tabId, false) and marks its row pruned", async () => {
    const h = harness([rec("old", 31, null)], [row("r-old", "old", 29)]);
    expect(await h.retention.prune()).toBe(1);
    expect(h.deleteSession).toHaveBeenCalledWith("old", false);
    expect(h.history.list()[0]).toMatchObject({ id: "r-old", pruned: true });
  });

  it("exempts a 40-day-old run whose cachedModified advanced 5 days ago (human replied)", async () => {
    const h = harness([rec("replied", 40, 5)], []);
    expect(await h.retention.prune()).toBe(0);
    expect(h.deleteSession).not.toHaveBeenCalled();
  });

  it("never prunes a live or awaiting-answer run, nor a non-routine (forked) session", async () => {
    const h = harness([rec("live", 60, null), rec("waiting", 60, null), rec("forked", 60, null, false)], []);
    h.live.add("live");
    h.awaiting.add("waiting");
    expect(await h.retention.prune()).toBe(0);
    expect(h.deleteSession).not.toHaveBeenCalled();
  });

  it("ages history rows out 30 days after fire, keeping pruned rows younger than that", async () => {
    const h = harness([], [row("young", "gone", 10), row("ancient", null, 31)]);
    await h.retention.prune();
    expect(h.history.list().map((r) => r.id)).toEqual(["young"]);
  });

  it("skips entirely while the gate is off", async () => {
    const h = harness([rec("old", 45, null)], [row("ancient", null, 45)]);
    h.enabled.value = false;
    expect(await h.retention.prune()).toBe(0);
    expect(h.deleteSession).not.toHaveBeenCalled();
    expect(h.history.list()).toHaveLength(1);
  });

  it("a failed delete leaves the row unpruned and continues with the rest", async () => {
    const h = harness([rec("a", 40, null), rec("b", 40, null)], [row("ra", "a", 20), row("rb", "b", 20)]);
    h.deleteSession.mockImplementationOnce(async () => {
      throw new Error("busy");
    });
    expect(await h.retention.prune()).toBe(1);
    expect(h.history.list().find((r) => r.id === "ra")!.pruned).toBe(false);
    expect(h.history.list().find((r) => r.id === "rb")!.pruned).toBe(true);
  });
});
