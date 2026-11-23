import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_CAPTURE_TOOL_NAME,
  DEFAULT_ROUTINE_NOTIFICATIONS,
  ROUTINE_NOTIFY_TOOL_KEY,
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
import type { RoutineNotificationPayload } from "./desktop-notifier";
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
    timeoutMinutes: null,
    notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
    artifact: null,
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
  notifications: RoutineNotificationPayload[];
  hasProjectFlag: { value: boolean };
  artifactBlocked: { value: string | null };
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
  const notifications: RoutineNotificationPayload[] = [];
  const hasProjectFlag = { value: true };
  const artifactBlocked = { value: null as string | null };
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
    hasProject: () => hasProjectFlag.value,
    sessions: () => sessions,
    isLive: (tabId) => live.has(tabId),
    isTurnRunning: (tabId) => running.has(tabId),
    awaitingHumanAnswer: (tabId) => awaiting.has(tabId),
    listCatalog: async () => CATALOG,
    artifactRefreshBlocked: () => artifactBlocked.value,
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
    notifyRoutine: (payload) => notifications.push(payload),
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
    notifications,
    hasProjectFlag,
    artifactBlocked,
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

describe("RoutineScheduler pre-run hook (#1283)", () => {
  it("refuses the fire with a failed/pre-script row and dispatches nothing; Run now refuses inline", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: null, scripts: { pre: "git fetch --all", post: "" } })]);
    h.preResult.current = { kind: "failed", timedOut: false, exitCode: 128 };
    await expect(h.scheduler.runNow(ID_A)).rejects.toThrow("Pre-run script failed");
    const rows = h.history.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failed", reasonCode: "pre-script", tabId: null });
    expect(h.store.get(ID_A)!.notices[0]).toMatchObject({ kind: "failed", error: "Pre-run script failed" });
    expect(h.dispatches).toHaveLength(0);
    // The hook ran in the checkout with the fire-time env.
    expect(h.preRuns).toHaveLength(1);
    expect(h.preRuns[0]!.cwd).toBe("/proj");
    expect(h.preRuns[0]!.env).toMatchObject({
      OMP_UI_ROUTINE_ID: ID_A,
      OMP_UI_ROUTINE_TRIGGER: "manual",
      OMP_UI_ROUTINE_WORKSPACE: "worktree",
    });
    h.scheduler.dispose();
  });

  it("a timed-out pre records the timeout message", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: null, scripts: { pre: "sleep 999", post: "" } })]);
    h.preResult.current = { kind: "failed", timedOut: true, exitCode: null };
    await expect(h.scheduler.runNow(ID_A)).rejects.toThrow("Pre-run script timed out");
    expect(h.history.list()[0]).toMatchObject({ outcome: "failed", reasonCode: "pre-script" });
    h.scheduler.dispose();
  });

  it("exit 78 on a manual fire resolves with an empty tabId, records skipped/pre-script-skip, and leaves the schedule untouched", async () => {
    const next = T0 + 3_600_000;
    const h = harness([routine(ID_A, { nextRunAtMs: next, scripts: { pre: "exit 78", post: "" } })]);
    h.preResult.current = { kind: "skip" };
    const result = await h.scheduler.runNow(ID_A);
    expect(result).toEqual({ tabId: "", runId: expect.any(String) });
    expect(h.history.list()[0]).toMatchObject({ outcome: "skipped", reasonCode: "pre-script-skip" });
    expect(h.store.get(ID_A)!.notices[0]).toMatchObject({ kind: "skipped" });
    expect(h.store.get(ID_A)!.nextRunAtMs).toBe(next); // untouched by a manual fire
    expect(h.dispatches).toHaveLength(0);
    h.scheduler.dispose();
  });

  it("a clock fire whose pre exits 78 advances the schedule exactly once", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: T0, scripts: { pre: "exit 78", post: "" } })]);
    h.preResult.current = { kind: "skip" };
    h.scheduler.sync();
    await flush();
    expect(h.history.list()).toHaveLength(1);
    expect(h.history.list()[0]).toMatchObject({ outcome: "skipped", reasonCode: "pre-script-skip", trigger: "clock" });
    expect(h.store.get(ID_A)!.nextRunAtMs).toBe(T0 + 3_600_000); // advanced once, not twice
    h.scheduler.dispose();
  });

  it("the post-advance skip merges into the current record without dropping a late notice written during the hook", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: null, scripts: { pre: "exit 78", post: "" } })]);
    const gate = Promise.withResolvers<RoutineScriptResult>();
    // Rebuild with a hook that stays pending until we release it.
    const scheduler = new RoutineScheduler({
      store: h.store,
      history: h.history,
      isEnabled: () => true,
      defaultWarnCostUsd: () => 2,
      defaultMaxCostUsd: () => 5,
      hasProject: () => true,
      sessions: () => [],
      isLive: () => false,
      isTurnRunning: () => false,
      awaitingHumanAnswer: () => false,
      listCatalog: async () => CATALOG,
      artifactRefreshBlocked: () => null,
      dispatch: async () => {
        throw new Error("must not dispatch on skip");
      },
      onRunStarted: () => undefined,
      runScript: () => gate.promise,
      postRunning: () => false,
      publish: () => undefined,
      now: () => Date.now(),
    });
    const fired = scheduler.runNow(ID_A);
    await Promise.resolve();
    // A late notice lands from elsewhere while the hook is in flight.
    h.store.replaceScheduleState(ID_A, {
      notices: [{ kind: "late", atMs: Date.now(), dueAtMs: T0 - 1, missed: 2, error: null }],
    });
    gate.resolve({ kind: "skip" });
    const result = await fired;
    expect(result.tabId).toBe("");
    // The skip notice was prepended onto the re-read record: both survive.
    const kinds = h.store.get(ID_A)!.notices.map((n) => n.kind);
    expect(kinds).toEqual(["skipped", "late"]);
    scheduler.dispose();
  });

  it("a pre hook that finishes after gate-off or deletion dispatches nothing", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: null, scripts: { pre: "slow", post: "" } })]);
    const gate = Promise.withResolvers<RoutineScriptResult>();
    const enabled = { value: true };
    const scheduler = new RoutineScheduler({
      store: h.store,
      history: h.history,
      isEnabled: () => enabled.value,
      defaultWarnCostUsd: () => 2,
      defaultMaxCostUsd: () => 5,
      hasProject: () => true,
      sessions: () => [],
      isLive: () => false,
      isTurnRunning: () => false,
      awaitingHumanAnswer: () => false,
      artifactRefreshBlocked: () => null,
      listCatalog: async () => {
        throw new Error("must not compile the catalog after gate-off");
      },
      dispatch: async () => {
        throw new Error("must not dispatch after gate-off");
      },
      onRunStarted: () => undefined,
      runScript: () => gate.promise,
      postRunning: () => false,
      publish: () => undefined,
      now: () => Date.now(),
    });
    const fired = scheduler.runNow(ID_A);
    await Promise.resolve();
    // The gate flips (or the routine is deleted) while the hook runs.
    enabled.value = false;
    gate.resolve({ kind: "ok" });
    await expect(fired).resolves.toEqual({ tabId: "", runId: "" });
    expect(h.history.list()).toHaveLength(0); // records nothing
    scheduler.dispose();
  });

  it("postRunning for a dead tab holds the per-routine latch while leaving the host lane free", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: T0 + 3_600_000 }), routine(ID_B, { nextRunAtMs: T0 + 3_600_000 })]);
    await h.scheduler.runNow(ID_A);
    const tabA = h.started[0]!;
    // Post-hook phase: run ended and reaped — not live, no turn, row finalized.
    h.live.delete(tabA);
    h.running.delete(tabA);
    h.history.updateByTabId(tabA, { outcome: "on-time" });
    h.postRunningTabs.add(tabA);
    await h.scheduler.runNow(ID_A).catch(() => undefined); // own latch: refuses
    expect(h.dispatches.map((d) => d.routine.id)).toEqual([ID_A]); // A never re-dispatched
    // Host lane free for another routine — a post hook holds no model work.
    await h.scheduler.runNow(ID_B);
    expect(h.dispatches.map((d) => d.routine.id)).toEqual([ID_A, ID_B]);
    // Clock overlap path: A due while its post runs → skipped/overlap row.
    h.postRunningTabs.add(tabA);
    h.store.replaceScheduleState(ID_A, { nextRunAtMs: Date.now() });
    h.scheduler.sync();
    await flush();
    expect(h.history.list().some((r) => r.routineId === ID_A && r.outcome === "skipped" && r.reasonCode === "overlap")).toBe(true);
    h.scheduler.dispose();
  });
});

describe("RoutineScheduler notifications (#1294)", () => {
  it("posts onStart for clock/late/manual runs and suppresses when off", async () => {
    const h = harness([
      routine(ID_A, {
        name: "Alpha",
        nextRunAtMs: T0,
        notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS, onStart: true },
      }),
      routine(ID_B, {
        name: "Beta",
        nextRunAtMs: null,
        notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
      }),
    ]);
    h.scheduler.sync();
    await flush();
    expect(h.notifications).toEqual([
      { routineId: ID_A, tabId: h.started[0]!, title: "Alpha", body: "Routine started" },
    ]);

    // Release run A so manual run fires cleanly.
    h.live.delete(h.started[0]!);
    h.running.delete(h.started[0]!);
    h.history.updateByTabId(h.started[0]!, { outcome: "on-time" });
    await h.scheduler.runNow(ID_A);
    expect(h.notifications[1]).toEqual({
      routineId: ID_A,
      tabId: h.started[1]!,
      title: "Alpha",
      body: "Routine started (manual)",
    });

    // Release run A again and trigger a late fire (> 120 s past due).
    h.live.delete(h.started[1]!);
    h.running.delete(h.started[1]!);
    h.history.updateByTabId(h.started[1]!, { outcome: "on-time" });
    h.store.replaceScheduleState(ID_A, { nextRunAtMs: T0 });
    vi.setSystemTime(T0 + 5 * 60_000);
    h.scheduler.sync();
    await flush();
    expect(h.notifications[2]).toEqual({
      routineId: ID_A,
      tabId: h.started[2]!,
      title: "Alpha",
      body: "Routine started (late)",
    });

    // Routine with onStart off posts nothing.
    h.live.delete(h.started[2]!);
    h.running.delete(h.started[2]!);
    h.history.updateByTabId(h.started[2]!, { outcome: "on-time" });
    await h.scheduler.runNow(ID_B);
    expect(h.notifications).toHaveLength(3);
    h.scheduler.dispose();
  });

  it("posts onFail with tabId=null for project-missing, pre-script, and dispatch-failed, never for skips", async () => {
    const h = harness([
      routine(ID_A, {
        name: "Alpha",
        nextRunAtMs: null,
        scripts: { pre: "check", post: "" },
        notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS, onFail: true },
      }),
    ]);

    // Pre-script skip (exit 78) posts no failure banner.
    h.preResult.current = { kind: "skip" };
    await h.scheduler.runNow(ID_A);
    expect(h.notifications).toHaveLength(0);

    // Pre-script failure posts failure banner.
    h.preResult.current = { kind: "failed", timedOut: false, exitCode: 1 };
    await h.scheduler.runNow(ID_A).catch(() => undefined);
    expect(h.notifications[0]).toEqual({
      routineId: ID_A,
      tabId: null,
      title: "Alpha",
      body: "Failed — Pre-run script failed",
    });

    // Project-missing posts failure banner.
    h.hasProjectFlag.value = false;
    await h.scheduler.runNow(ID_A).catch(() => undefined);
    expect(h.notifications[1]).toEqual({
      routineId: ID_A,
      tabId: null,
      title: "Alpha",
      body: "Failed — Destination project unavailable",
    });

    // Dispatch failure posts failure banner.
    h.hasProjectFlag.value = true;
    h.preResult.current = { kind: "ok" };
    h.setDispatch(async () => ({ batchId: null, outcomes: [] }) as unknown as FleetDispatchResult);
    await h.scheduler.runNow(ID_A).catch(() => undefined);
    expect(h.notifications[2]).toEqual({
      routineId: ID_A,
      tabId: null,
      title: "Alpha",
      body: "Failed — Could not start session",
    });
    h.scheduler.dispose();
  });

  it("compiles omp-ui_notify allow and injects prompt instruction iff onComplete && agentMessage", async () => {
    const h = harness([
      routine(ID_A, {
        nextRunAtMs: null,
        notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS, onComplete: true, agentMessage: true },
      }),
      routine(ID_B, {
        nextRunAtMs: null,
        notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS, onComplete: false, agentMessage: true },
      }),
    ]);
    await h.scheduler.runNow(ID_A);
    expect(h.dispatches[0]!.routine.approvalEntries[ROUTINE_NOTIFY_TOOL_KEY]).toBe("allow");
    expect(h.dispatches[0]!.req.prompt).toContain("omp-ui_notify");

    h.live.delete(h.started[0]!);
    h.running.delete(h.started[0]!);
    h.history.updateByTabId(h.started[0]!, { outcome: "on-time" });
    await h.scheduler.runNow(ID_B);
    expect(h.dispatches[1]!.routine.approvalEntries[ROUTINE_NOTIFY_TOOL_KEY]).toBeUndefined();
    expect(h.dispatches[1]!.req.prompt).not.toContain("omp-ui_notify");
    h.scheduler.dispose();
  });

  it("fails a bound fire whose artifact selection no longer resolves, before catalog or dispatch (ADR-0101)", async () => {
    const binding = { artifactId: "0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b", datasetIds: ["rows"], autoApply: false };
    const h = harness([
      routine(ID_A, {
        name: "Refresher",
        nextRunAtMs: null,
        artifact: binding,
        notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS, onFail: true },
      }),
    ]);
    h.artifactBlocked.value = "The bound artifact no longer exists";
    await h.scheduler.runNow(ID_A).catch(() => undefined);
    expect(h.dispatches).toHaveLength(0);
    expect(h.history.list()[0]).toMatchObject({ outcome: "failed", reasonCode: "artifact-missing", tabId: null });
    expect(h.notifications[0]).toEqual({
      routineId: ID_A,
      tabId: null,
      title: "Refresher",
      body: "Failed — The bound artifact no longer exists",
    });

    // Selection resolves again: the fire dispatches with the capture allow and the pinned binding.
    h.artifactBlocked.value = null;
    await h.scheduler.runNow(ID_A);
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]!.routine.approvalEntries[ARTIFACT_CAPTURE_TOOL_NAME]).toBe("allow");
    expect(h.dispatches[0]!.routine.artifact).toEqual(binding);
    h.scheduler.dispose();
  });

  it("leaves the capture tool unlisted for an unbound fire", async () => {
    const h = harness([routine(ID_A, { nextRunAtMs: null })]);
    await h.scheduler.runNow(ID_A);
    expect(h.dispatches[0]!.routine.approvalEntries[ARTIFACT_CAPTURE_TOOL_NAME]).toBeUndefined();
    expect(h.dispatches[0]!.routine.artifact).toBeUndefined();
    h.scheduler.dispose();
  });
});
