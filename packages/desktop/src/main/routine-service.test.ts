import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROUTINE_ID_PATTERN,
  RoutineRunHistory,
  RoutineStore,
  type FleetDispatchResult,
  type OwnedSessionRecord,
  type RoutineCatalogSnapshot,
  type RoutineInput,
  type RoutinesState,
} from "@omp-ui/core";
import { RoutineLifecycleManager } from "./routine-lifecycle";
import { ROUTINES_DISABLED_ERROR } from "./routine-scheduler";
import { RoutineService } from "./routine-service";
import { cancelAllRoutineScripts, runRoutineScript } from "./routine-scripts";

vi.mock("./routine-scripts", () => ({
  ROUTINE_SCRIPT_ENV_PREFIX: "OMP_UI_ROUTINE_",
  ROUTINE_TEST_OUTPUT_CAP: 16_384,
  cancelAllRoutineScripts: vi.fn(),
  runRoutineScript: vi.fn(async () => ({ kind: "ok" as const })),
  runRoutineScriptForTest: vi.fn(async () => ({
    kind: "ok" as const,
    timedOut: false,
    exitCode: 0,
    stdout: "hello\n",
    stderr: "",
  })),
}));

const T0 = Date.parse("2026-11-22T07:30:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const CATALOG: RoutineCatalogSnapshot = {
  tools: [
    { key: "read", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "" },
    { key: "mcp__jira_search", source: "mcp", group: "mcp:jira", groupLabel: "jira", description: "" },
  ],
  staleServers: [],
  enumerationError: null,
  capturedAt: new Date(T0).toISOString(),
};

function input(overrides: Partial<RoutineInput> = {}): RoutineInput {
  return {
    name: "Morning overview",
    instructions: "Summarize yesterday.",
    schedule: { kind: "cron", expr: "0 8 * * *" },
    timeZone: "UTC",
    destination: { projectCwd: "/proj", workspace: "worktree" },
    mode: "build",
    model: null,
    thinkingLevel: null,
    spend: { warnUsd: null, maxUsd: null },
    toolPolicy: { allow: ["read"], deny: [], lastReviewedAt: "2026-01-01T00:00:00.000Z", reviewedCatalog: [] },
    scripts: { pre: "", post: "" },
    enabled: true,
    ...overrides,
  };
}

let dir: string;

function harness() {
  const store = new RoutineStore(path.join(dir, "routines.json"));
  const history = new RoutineRunHistory(path.join(dir, "routine-runs.json"));
  const enabled = { value: true };
  const sessions: OwnedSessionRecord[] = [];
  const live = new Set<string>();
  const running = new Set<string>();
  const settleSession = vi.fn(async () => true);
  const deleteSession = vi.fn(async () => undefined);
  const dispatch = vi.fn(async (): Promise<FleetDispatchResult> => {
    const tabId = `tab-${dispatch.mock.calls.length}`;
    live.add(tabId);
    running.add(tabId);
    return {
      batchId: null,
      outcomes: [{ dispatchId: "d", machineKey: "local", projectCwd: "/proj", status: "started", tabId, choice: null }],
    } as unknown as FleetDispatchResult;
  });
  const listCatalog = vi.fn(async () => CATALOG);
  const published: RoutinesState[] = [];
  const lifecycle = new RoutineLifecycleManager({
    history,
    isEnabled: () => enabled.value,
    isRoutineTab: () => true,
    inRun: (t) => running.has(t),
    awaitingHumanAnswer: () => false,
    openDialogIds: () => [],
    settleSession,
    rpcSend: () => {},
    runScript: async () => ({ kind: "failed", timedOut: false, exitCode: null }),
    runDirectory: () => "/work/run-dir",
    publish: () => {},
  });
  const service = new RoutineService({
    store,
    history,
    catalog: { list: listCatalog },
    lifecycle,
    isEnabled: () => enabled.value,
    defaultWarnCostUsd: () => 2,
    defaultMaxCostUsd: () => 5,
    hasProject: (cwd) => cwd === "/proj",
    sessions: () => sessions,
    clearSessionRoutine: (tabId) => {
      const s = sessions.find((x) => x.tabId === tabId);
      if (s) s.routine = null;
    },
    isLive: (t) => live.has(t),
    isTurnRunning: (t) => running.has(t),
    awaitingHumanAnswer: () => false,
    deleteSession,
    dispatch,
    machineLabel: () => "desk",
    send: (state) => published.push(state),
    broadcast: () => {},
    now: () => Date.now(),
  });
  return { service, store, history, enabled, sessions, live, running, settleSession, deleteSession, dispatch, listCatalog, published, lifecycle };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-routine-svc-"));
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("RoutineService CRUD", () => {
  it("create mints a 128-bit base64url id, computes nextRunAtMs, and snapshots the reviewed catalog", async () => {
    const h = harness();
    const rec = await h.service.create(input());
    expect(rec.id).toMatch(ROUTINE_ID_PATTERN);
    expect(rec.nextRunAtMs).toBe(Date.parse("2026-11-22T08:00:00.000Z"));
    expect(rec.toolPolicy.reviewedCatalog).toEqual(["mcp__jira_search", "read"]);
    expect(rec.toolPolicy.lastReviewedAt).toBe(new Date(T0).toISOString());
    expect(h.store.get(rec.id)).toEqual(rec);
    expect(h.published.at(-1)).toMatchObject({ enabled: true, machineLabel: "desk", activeRunTabId: null });
    h.service.dispose();
  });

  it("refuses an unregistered destination project", async () => {
    const h = harness();
    await expect(h.service.create(input({ destination: { projectCwd: "/elsewhere", workspace: "checkout" } }))).rejects.toThrow(
      /registered project/,
    );
    h.service.dispose();
  });

  it("dryRun compiles over the live catalog with zero writes and zero spawns", async () => {
    const h = harness();
    const rec = await h.service.create(input());
    const routinesBefore = fs.readFileSync(path.join(dir, "routines.json"), "utf8");
    const result = await h.service.dryRun({ kind: "saved", id: rec.id });
    expect(result.compiled.overlayEntries).toEqual({ mcp__jira_search: "prompt", read: "allow" });
    expect(result).toMatchObject({ routineId: rec.id, warnCostUsd: 2, maxCostUsd: 5 });
    const draft = await h.service.dryRun({ kind: "draft", input: input({ spend: { warnUsd: 0, maxUsd: 1 } }) });
    expect(draft).toMatchObject({ routineId: null, warnCostUsd: 0, maxCostUsd: 1 });
    expect(draft.compiled.addedLater).toEqual(["mcp__jira_search"]);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, "routines.json"), "utf8")).toBe(routinesBefore);
    expect(fs.existsSync(path.join(dir, "routine-runs.json"))).toBe(false);
    h.service.dispose();
  });
});

describe("RoutineService updateFromAgent (ADR-0100 amendment 2)", () => {
  it("throws for an unknown id and disarms a stored enabled routine, reporting wasEnabled", async () => {
    const h = harness();
    await expect(
      h.service.updateFromAgent({ id: "AbCdEfGhIjKlMnOpQrStUv", name: "x" }, new Date(T0).toISOString()),
    ).rejects.toThrow(/unknown routine/);
    const rec = await h.service.create(input());
    expect(rec.enabled).toBe(true);
    const { record, wasEnabled } = await h.service.updateFromAgent(
      { id: rec.id, instructions: "Summarize twice.", allow: ["read", "grep"] },
      new Date(T0).toISOString(),
    );
    expect(wasEnabled).toBe(true);
    expect(record.enabled).toBe(false);
    expect(record.instructions).toBe("Summarize twice.");
    // update() restamped the review against the live catalog.
    expect(record.toolPolicy.reviewedCatalog).toEqual(["mcp__jira_search", "read"]);
    expect(h.store.get(rec.id)?.enabled).toBe(false);
    h.service.dispose();
  });
});

describe("RoutineService gate (U12)", () => {
  it("gate off rejects every mutation and run with the exact message and the clock fires nothing", async () => {
    const h = harness();
    const rec = await h.service.create(input());
    h.enabled.value = false;
    h.service.onEnabledChanged(false);
    for (const call of [
      () => h.service.create(input()),
      () => h.service.update(rec.id, { enabled: false }),
      () => Promise.resolve().then(() => h.service.remove(rec.id)),
      () => h.service.runNow(rec.id),
      () => h.service.dryRun({ kind: "saved", id: rec.id }),
      () => Promise.resolve().then(() => h.service.toolCatalog("/proj")),
    ]) {
      await expect(call()).rejects.toThrow(ROUTINES_DISABLED_ERROR);
    }
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.service.state().enabled).toBe(false);
    expect(h.store.list()).toHaveLength(1);
    h.service.dispose();
  });

  it("toggling off mid-run parks the per-run timers without reaping; re-enable resumes scheduling and timers", async () => {
    const h = harness();
    const rec = await h.service.create(input());
    const { tabId } = await h.service.runNow(rec.id);
    h.enabled.value = false;
    h.service.onEnabledChanged(false);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    expect(h.live.has(tabId)).toBe(true);
    expect(h.history.list()[0]).toMatchObject({ tabId, outcome: "running" });

    h.enabled.value = true;
    h.service.onEnabledChanged(true);
    await vi.advanceTimersByTimeAsync(0);
    // The parked 30-min wall clock was already past: it fires on resume.
    expect(h.settleSession).toHaveBeenCalledWith(tabId);
    expect(h.history.list().find((r) => r.tabId === tabId)).toMatchObject({ outcome: "failed", reasonCode: "wall-clock" });
    h.service.dispose();
  });

  it("gate re-enable runs retention", async () => {
    const h = harness();
    h.sessions.push({
      tabId: "old",
      routine: { id: "AAAAAAAAAAAAAAAAAAAAAA", name: "x", approvalEntries: {}, deniedBuiltins: [], warnCostUsd: 2, maxCostUsd: 5 },
      launchedAt: new Date(T0 - 40 * DAY).toISOString(),
      cachedModified: null,
    } as unknown as OwnedSessionRecord);
    h.enabled.value = false;
    h.service.onEnabledChanged(false);
    expect(h.deleteSession).not.toHaveBeenCalled();
    h.enabled.value = true;
    h.service.onEnabledChanged(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.deleteSession).toHaveBeenCalledWith("old", false);
    h.service.dispose();
  });
});

describe("RoutineService remove (U12)", () => {
  it("removes record and history without reaping and clears routine: null on surviving records", async () => {
    const h = harness();
    const keep = await h.service.create(input({ name: "Keep" }));
    const doomed = await h.service.create(input({ name: "Doomed" }));
    const { tabId } = await h.service.runNow(doomed.id);
    const mark = { id: doomed.id, name: "Doomed", approvalEntries: {}, deniedBuiltins: [], warnCostUsd: 2, maxCostUsd: 5 };
    const otherMark = { ...mark, id: keep.id, name: "Keep" };
    h.sessions.push(
      { tabId, routine: { ...mark } } as unknown as OwnedSessionRecord,
      { tabId: "retained", routine: { ...mark } } as unknown as OwnedSessionRecord,
      { tabId: "other", routine: otherMark } as unknown as OwnedSessionRecord,
    );
    expect(h.service.remove(doomed.id)).toEqual({ releasedSessions: 2 });
    expect(h.store.get(doomed.id)).toBeNull();
    expect(h.history.list(doomed.id)).toEqual([]);
    expect(h.sessions.find((s) => s.tabId === tabId)!.routine).toBeNull();
    expect(h.sessions.find((s) => s.tabId === "retained")!.routine).toBeNull();
    expect(h.sessions.find((s) => s.tabId === "other")!.routine).toEqual(otherMark);
    expect(h.settleSession).not.toHaveBeenCalled();
    expect(h.deleteSession).not.toHaveBeenCalled();
    expect(h.live.has(tabId)).toBe(true);
    h.service.dispose();
  });
});

describe("RoutineService diagnostics", () => {
  it("reports counts and flags only", async () => {
    const h = harness();
    const a = await h.service.create(input());
    await h.service.create(input({ name: "Paused", enabled: false }));
    const { tabId } = await h.service.runNow(a.id);
    h.sessions.push({
      tabId,
      routine: { id: a.id, name: "Morning overview", approvalEntries: {}, deniedBuiltins: [], warnCostUsd: 2, maxCostUsd: 5 },
    } as unknown as OwnedSessionRecord);
    const diag = h.service.diagnostics();
    expect(diag).toEqual({
      enabled: true,
      warnCostUsd: 2,
      maxCostUsd: 5,
      routineCount: 2,
      enabledCount: 1,
      activeRunTabId: tabId,
      waitingApprovalCount: 0,
      recentOutcomeCounts: { running: 1, "waiting-approval": 0, "on-time": 0, late: 0, skipped: 0, failed: 0 },
    });
    expect(JSON.stringify(diag)).not.toContain("Morning overview");
    h.service.dispose();
  });
});

describe("RoutineService script hooks (#1283)", () => {
  it("the Test action refuses with the gate off or an unregistered project and touches nothing", async () => {
    const h = harness();
    await expect(h.service.testScript({ projectCwd: "/proj", command: "true" })).resolves.toEqual({
      kind: "ok",
      timedOut: false,
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
    });
    await expect(h.service.testScript({ projectCwd: "/nope", command: "true" })).rejects.toThrow(/registered project/);
    h.enabled.value = false;
    await expect(h.service.testScript({ projectCwd: "/proj", command: "true" })).rejects.toThrow(
      ROUTINES_DISABLED_ERROR,
    );
    // No store or history writes from any of the three calls.
    expect(h.store.list()).toHaveLength(0);
    expect(h.history.list()).toHaveLength(0);
    h.service.dispose();
  });

  it("dryRun returns scripts verbatim without invoking the runner", async () => {
    const h = harness();
    const created = await h.service.create(input({ scripts: { pre: "git fetch", post: "echo done" } }));
    const dry = await h.service.dryRun({ kind: "saved", id: created.id });
    expect(dry.scripts).toEqual({ pre: "git fetch", post: "echo done" });
    expect(vi.mocked(runRoutineScript)).not.toHaveBeenCalled();
    h.service.dispose();
  });

  it("gate-off and dispose cancel live hook children", async () => {
    const h = harness();
    const before = vi.mocked(cancelAllRoutineScripts).mock.calls.length;
    h.service.onEnabledChanged(false);
    expect(vi.mocked(cancelAllRoutineScripts).mock.calls.length).toBe(before + 1);
    h.service.dispose();
    expect(vi.mocked(cancelAllRoutineScripts).mock.calls.length).toBe(before + 2);
  });

  it("a save round-trips hooks through update", async () => {
    const h = harness();
    const created = await h.service.create(input());
    const updated = await h.service.update(created.id, { scripts: { pre: "", post: "echo bye" } });
    expect(updated.scripts).toEqual({ pre: "", post: "echo bye" });
    expect(h.store.get(created.id)!.scripts.post).toBe("echo bye");
    h.service.dispose();
  });
});
