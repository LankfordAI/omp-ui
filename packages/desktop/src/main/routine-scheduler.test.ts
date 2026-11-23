import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RoutineRunHistory,
  RoutineStore,
  type FleetDispatchRequest,
  type FleetDispatchResult,
  type OwnedSessionRecord,
  type RoutineCatalogSnapshot,
  type RoutineRecord,
  type SessionRoutine,
} from "@omp-ui/core";
import {
  ROUTINE_BUSY_REFUSAL,
  ROUTINE_SCHEDULER_MAX_WAIT_MS,
  ROUTINES_DISABLED_ERROR,
  RoutineScheduler,
} from "./routine-scheduler";
import type { RoutineScriptEnv, RoutineScriptResult } from "./routine-scripts";

const ID_A = "AAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "BBBBBBBBBBBBBBBBBBBBBB";
const T0 = Date.parse("2026-11-22T08:00:00.000Z");

const CATALOG: RoutineCatalogSnapshot = {
  tools: [
    { key: "read", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "" },
    { key: "bash", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "" },
  ],
  staleServers: [],
  enumerationError: null,
  capturedAt: new Date(T0).toISOString(),
};

function routine(id: string, overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id,
    name: `Routine ${id.slice(0, 1)}`,
    instructions: "Summarize the inbox.",
    schedule: { kind: "cron", expr: "0 * * * *" },
    timeZone: "UTC",
    destination: { projectCwd: "/proj", workspace: "worktree" },
    mode: "build",
    model: null,
    thinkingLevel: null,
    spend: { warnUsd: null, maxUsd: 7 },
    toolPolicy: { allow: ["read"], deny: ["bash"], lastReviewedAt: new Date(T0).toISOString(), reviewedCatalog: ["read", "bash"] },
    scripts: { pre: "", post: "" },
    enabled: true,
    createdAt: new Date(T0).toISOString(),
    nextRunAtMs: T0,
    lastRunAtMs: null,
    lastRunTabId: null,
    notices: [],
    ...overrides,
  };
}

function session(tabId: string, routineId: string | null): OwnedSessionRecord {
  return {
    tabId,
    routine:
      routineId === null
        ? null
        : { id: routineId, name: "r", approvalEntries: {}, deniedBuiltins: [], warnCostUsd: 2, maxCostUsd: 5 },
  } as unknown as OwnedSessionRecord;
}

interface Harness {
  scheduler: RoutineScheduler;
  store: RoutineStore;
  history: RoutineRunHistory;
  dispatches: Array<{ req: FleetDispatchRequest; routine: SessionRoutine }>;
  started: string[];
  live: Set<string>;
  running: Set<string>;
  awaiting: Set<string>;
  sessions: OwnedSessionRecord[];
  setDispatch: (fn: () => Promise<FleetDispatchResult>) => void;
  enabled: { value: boolean };
  preRuns: Array<{ command: string; cwd: string; env: RoutineScriptEnv }>;
  preResult: { current: RoutineScriptResult };
  postRunningTabs: Set<string>;
}

let dir: string;
let nextTab = 0;

function harness(routines: RoutineRecord[]): Harness {
  const store = new RoutineStore(path.join(dir, "routines.json"));
  for (const r of routines) store.add(r);
  const history = new RoutineRunHistory(path.join(dir, "routine-runs.json"));
  const dispatches: Harness["dispatches"] = [];
  const started: string[] = [];
  const live = new Set<string>();
  const running = new Set<string>();
  const awaiting = new Set<string>();
  const sessions: OwnedSessionRecord[] = [];
  const enabled = { value: true };
  const preRuns: Harness["preRuns"] = [];
  const preResult = { current: { kind: "ok" } as RoutineScriptResult };
  const postRunningTabs = new Set<string>();
  let dispatchImpl = async (): Promise<FleetDispatchResult> => {
    const tabId = `tab-${++nextTab}`;
    return {
      batchId: null,
      outcomes: [{ dispatchId: "d", machineKey: "local", projectCwd: "/proj", status: "started", tabId, choice: null }],
    } as unknown as FleetDispatchResult;
  };
  const scheduler = new RoutineScheduler({
    store,
    history,
    isEnabled: () => enabled.value,
    defaultWarnCostUsd: () => 2,
    defaultMaxCostUsd: () => 5,
    hasProject: () => true,
    sessions: () => sessions,
    isLive: (tabId) => live.has(tabId),
    isTurnRunning: (tabId) => running.has(tabId),
    awaitingHumanAnswer: (tabId) => awaiting.has(tabId),
    listCatalog: async () => CATALOG,
    dispatch: async (req, who) => {
      dispatches.push({ req, routine: who.routine });
      const result = await dispatchImpl();
      const outcome = result.outcomes[0];
      if (outcome?.status === "started") {
        // The spawned run is live, actively turning, and routine-marked.
        live.add(outcome.tabId);
        running.add(outcome.tabId);
        sessions.push(session(outcome.tabId, who.routine.id));
      }
      return result;
    },
    onRunStarted: (tabId) => started.push(tabId),
    runScript: async (command, cwd, env) => {
      preRuns.push({ command, cwd, env });
      return preResult.current;
    },
    postRunning: (tabId) => postRunningTabs.has(tabId),
    publish: () => {},
    now: () => Date.now(),
  });
  return {
    scheduler,
    store,
    history,
    dispatches,
    started,
    live,
    running,
    awaiting,
    sessions,
    setDispatch: (fn) => {
      dispatchImpl = fn;
    },
    enabled,
    preRuns,
    preResult,
    postRunningTabs,
  };
}

/** Lets pending dispatch promises settle under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-routine-sched-"));
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("RoutineScheduler clock (U4)", () => {
  it("caps every wait at 60 s and steps toward a distant fire", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: T0 + 10 * 60_000 })]);
    const spy = vi.spyOn(globalThis, "setTimeout");
    h.scheduler.sync();
    expect(spy.mock.calls.at(-1)?.[1]).toBe(ROUTINE_SCHEDULER_MAX_WAIT_MS);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(h.dispatches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(h.dispatches).toHaveLength(1);
    h.scheduler.dispose();
  });

  it("fires on time, advances nextRunAtMs before dispatch, and compiles the SessionRoutine", async () => {
    const h = harness([routine(ID_A)]);
    let nextAtDispatch: number | null = null;
    h.setDispatch(async () => {
      nextAtDispatch = h.store.get(ID_A)!.nextRunAtMs;
      throw new Error("child died");
    });
    h.scheduler.sync();
    await flush();
    // Advanced before the dispatch call ran.
    expect(nextAtDispatch).toBe(T0 + 3_600_000);
    // A failed dispatch is never re-sent for the same occurrence.
    h.scheduler.sync();
    await flush();
    expect(h.dispatches).toHaveLength(1);
    expect(h.history.list()[0]).toMatchObject({ outcome: "failed", reasonCode: "dispatch-failed", tabId: null });
    expect(h.store.get(ID_A)!.notices[0]).toMatchObject({ kind: "failed", error: "Could not start session" });
    const sent = h.dispatches[0]!;
    expect(sent.routine).toEqual({
      id: ID_A,
      name: "Routine A",
      approvalEntries: { bash: "deny", read: "allow" },
      deniedBuiltins: ["bash"],
      warnCostUsd: 2,
      maxCostUsd: 7,
    });
    expect(sent.req.targets).toEqual({ kind: "explicit", picks: [{ machineKey: "local", projectCwd: "/proj" }] });
    expect(sent.req.prompt).toContain("untrusted data");
    expect(sent.req.title).toBe("Routine A · 2026-11-22 08:00");
    expect(sent.req.workspace).toBe("worktree");
    expect(sent.req.planMode).toBe(false);
    h.scheduler.dispose();
  });

  it("boot catch-up past 120 s fires once with a late notice folding the missed count", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: T0 - 5 * 3_600_000 })]);
    h.scheduler.sync();
    await flush();
    expect(h.dispatches).toHaveLength(1);
    const rec = h.store.get(ID_A)!;
    expect(rec.nextRunAtMs).toBe(T0 + 3_600_000);
    expect(rec.notices[0]).toMatchObject({ kind: "late", dueAtMs: T0 - 5 * 3_600_000, missed: 5 });
    expect(h.history.list()[0]).toMatchObject({ trigger: "late", outcome: "running", missed: 5 });
    h.scheduler.dispose();
  });

  it("skips (never queues) while the previous run is open, including a run parked on an Approval card", async () => {
    const h = harness([routine(ID_A, { lastRunTabId: "parked", nextRunAtMs: T0 })]);
    h.live.add("parked");
    h.awaiting.add("parked"); // card-parked: not turning, awaiting human
    h.scheduler.sync();
    await flush();
    expect(h.dispatches).toHaveLength(0);
    const rec = h.store.get(ID_A)!;
    expect(rec.nextRunAtMs).toBe(T0 + 3_600_000);
    expect(rec.notices[0]).toMatchObject({ kind: "skipped" });
    expect(h.history.list()[0]).toMatchObject({ outcome: "skipped", reasonCode: "overlap", tabId: null });
    h.scheduler.dispose();
  });

  it("Run now fires without advancing nextRunAtMs and occupies the overlap lane", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: T0 + 30 * 60_000 })]);
    const result = await h.scheduler.runNow(ID_A);
    const rec = h.store.get(ID_A)!;
    expect(rec.nextRunAtMs).toBe(T0 + 30 * 60_000);
    expect(rec.lastRunTabId).toBe(result.tabId);
    expect(h.history.list()[0]).toMatchObject({ trigger: "manual", outcome: "running", tabId: result.tabId });
    // The manual run is still turning: the clock fire skips on the per-routine latch.
    h.running.delete(result.tabId);
    h.awaiting.add(result.tabId);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    h.scheduler.sync();
    await flush();
    expect(h.dispatches).toHaveLength(1);
    expect(h.history.list()[0]).toMatchObject({ outcome: "skipped", reasonCode: "overlap" });
    h.scheduler.dispose();
  });

  it("never fires a disabled routine, and fires nothing while the gate is off", async () => {
    const h = harness([routine(ID_A, { enabled: false }), routine(ID_B)]);
    h.enabled.value = false;
    h.scheduler.sync();
    await flush();
    expect(h.dispatches).toHaveLength(0);
    await expect(h.scheduler.runNow(ID_B)).rejects.toThrow(ROUTINES_DISABLED_ERROR);
    h.enabled.value = true;
    h.scheduler.sync();
    await flush();
    expect(h.dispatches.map((d) => d.routine.id)).toEqual([ID_B]);
    h.scheduler.dispose();
  });
});

describe("RoutineScheduler host lane (U5)", () => {
  it("a second routine's fire skips while routine A actively turns, and proceeds once A parks on a card", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: T0 + 1 }), routine(ID_B, { nextRunAtMs: T0 + 60_000 })]);
    await h.scheduler.runNow(ID_A);
    const tabA = h.started[0]!;
    // A actively turns: B's fire skips on the host lane.
    await vi.advanceTimersByTimeAsync(60_000);
    h.scheduler.sync();
    await flush();
    expect(h.dispatches).toHaveLength(1);
    const skipB = h.history.list().find((r) => r.routineId === ID_B)!;
    expect(skipB).toMatchObject({ outcome: "skipped", reasonCode: "host-lane-busy" });

    // A parks on an Approval card: omp raises it mid-turn, so the turn latch
    // stays set (observed live in the S6 smoke). The host lane is released
    // anyway; A's own latch still holds.
    h.awaiting.add(tabA);
    h.store.replaceScheduleState(ID_B, { nextRunAtMs: Date.now() });
    h.store.replaceScheduleState(ID_A, { nextRunAtMs: Date.now() });
    h.scheduler.sync();
    await flush();
    expect(h.dispatches.map((d) => d.routine.id)).toEqual([ID_A, ID_B]);
    const latestA = h.history.list().find((r) => r.routineId === ID_A)!;
    expect(latestA).toMatchObject({ outcome: "skipped", reasonCode: "overlap" });
    h.scheduler.dispose();
  });

  it("busy Run now refuses inline with the exact string, spawns nothing, and adds no notice or row", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: T0 + 3_600_000 }), routine(ID_B, { nextRunAtMs: T0 + 3_600_000 })]);
    await h.scheduler.runNow(ID_A);
    const rowsBefore = h.history.list().length;
    await expect(h.scheduler.runNow(ID_B)).rejects.toThrow(ROUTINE_BUSY_REFUSAL);
    expect(h.dispatches).toHaveLength(1);
    expect(h.history.list()).toHaveLength(rowsBefore);
    expect(h.store.get(ID_B)!.notices).toEqual([]);
    h.scheduler.dispose();
  });

  it("a run in its settle-grace window (inRun false) blocks neither lane", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: T0 + 3_600_000 }), routine(ID_B, { nextRunAtMs: T0 + 3_600_000 })]);
    await h.scheduler.runNow(ID_A);
    const tabA = h.started[0]!;
    // Terminal agent_end: still live, no turn, no gate; the lifecycle finalizes the row.
    h.running.delete(tabA);
    h.history.updateByTabId(tabA, { outcome: "on-time" });
    await h.scheduler.runNow(ID_B);
    await h.scheduler.runNow(ID_A).catch(() => undefined);
    expect(h.dispatches.map((d) => d.routine.id)).toEqual([ID_A, ID_B]);
    // A's second Run now refused only on the host lane (B is turning), not its own latch.
    h.running.clear();
    h.history.updateByTabId(h.started[1]!, { outcome: "on-time" });
    await h.scheduler.runNow(ID_A);
    expect(h.dispatches.map((d) => d.routine.id)).toEqual([ID_A, ID_B, ID_A]);
    h.scheduler.dispose();
  });

  it("a dispatched run before omp's first agent_start still holds both lanes", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: T0 + 3_600_000 }), routine(ID_B, { nextRunAtMs: T0 + 3_600_000 })]);
    await h.scheduler.runNow(ID_A);
    // The spawn answered, but the child has not announced its turn yet.
    h.running.clear();
    await expect(h.scheduler.runNow(ID_A)).rejects.toThrow("Previous run is still open");
    await expect(h.scheduler.runNow(ID_B)).rejects.toThrow(ROUTINE_BUSY_REFUSAL);
    expect(h.dispatches).toHaveLength(1);
    h.scheduler.dispose();
  });
});
