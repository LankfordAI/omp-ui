import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROUTINE_NOTIFICATIONS,
  OMP_ERROR_FLAG_USAGE_LIMIT,
  ROUTINE_RUN_WALL_CLOCK_MS,
  RoutineRunHistory,
  type RoutineNotifications,
  type RoutineRunRow,
  type RpcFrame,
} from "@omp-ui/core";
import type { RoutineNotificationPayload } from "./desktop-notifier";
import { RoutineLifecycleManager } from "./routine-lifecycle";
import type { RoutineScriptEnv } from "./routine-scripts";

const T0 = Date.parse("2026-11-22T08:00:00.000Z");
const TAB = "tab-r";
const ROUTINE_ID = "AAAAAAAAAAAAAAAAAAAAAA";

const approvalFrame = (id: string): RpcFrame => ({
  type: "extension_ui_request",
  id,
  method: "select",
  title: "Allow tool: mcp__gmail_send_message",
  options: ["Approve", "Deny"],
});

function row(id: string, trigger: RoutineRunRow["trigger"] = "clock"): RoutineRunRow {
  return {
    id,
    routineId: ROUTINE_ID,
    routineName: "Inbox",
    firedAtMs: T0,
    scheduledForMs: T0,
    trigger,
    outcome: "running",
    tabId: TAB,
    reasonCode: null,
    missed: 0,
    pruned: false,
    staleCatalog: false,
  };
}

let dir: string;
let fileSeq = 0;

function harness(
  trigger: RoutineRunRow["trigger"] = "clock",
  wallClockMs: number | null = ROUTINE_RUN_WALL_CLOCK_MS,
  notifications: RoutineNotifications = { ...DEFAULT_ROUTINE_NOTIFICATIONS },
  bindImmediately = true,
) {
  const history = new RoutineRunHistory(path.join(dir, `routine-runs-${++fileSeq}.json`));
  history.record(row("run-1", trigger));
  const enabled = { value: true };
  const running = new Set<string>();
  const awaiting = new Set<string>();
  const viewed = new Set<string>();
  const openDialogs: string[] = [];
  const settleSession = vi.fn(async () => true);
  const sent: Array<{ tabId: string; cmd: RpcFrame }> = [];
  const postRuns: Array<{ command: string; cwd: string; env: RoutineScriptEnv }> = [];
  const routineNotifications: RoutineNotificationPayload[] = [];
  const clearedNotifications: string[] = [];
  const scriptResult = { current: { kind: "ok" as "ok" | "skip" | "failed", timedOut: false, exitCode: 0 as number | null } };
  const runScript = vi.fn(async (command: string, cwd: string, env: RoutineScriptEnv) => {
    postRuns.push({ command, cwd, env });
    return scriptResult.current;
  });
  const lifecycle = new RoutineLifecycleManager({
    history,
    isEnabled: () => enabled.value,
    isRoutineTab: (tabId) => tabId === TAB,
    inRun: (tabId) => running.has(tabId) || awaiting.has(tabId),
    awaitingHumanAnswer: (tabId) => awaiting.has(tabId),
    isViewed: (tabId) => viewed.has(tabId),
    openDialogIds: () => [...openDialogs],
    settleSession,
    rpcSend: (tabId, cmd) => sent.push({ tabId, cmd }),
    runScript,
    runDirectory: () => "/work/run-dir",
    publish: () => {},
    notifyRoutine: (payload) => routineNotifications.push(payload),
    clearRoutineNotification: (tabId) => clearedNotifications.push(tabId),
    now: () => Date.now(),
  });
  const bind = (overrideNotifications: RoutineNotifications = notifications, post = ""): void => {
    lifecycle.trackStart(TAB, "run-1", trigger, T0, {
      scripts: { pre: "", post },
      routineId: ROUTINE_ID,
      routineName: "Inbox",
      projectCwd: "/proj",
      workspace: "worktree",
      wallClockMs,
      notifications: overrideNotifications,
    });
  };
  if (bindImmediately) bind();
  const frame = (f: RpcFrame): void => lifecycle.onFrame(TAB, f);
  const rowNow = (): RoutineRunRow => history.list().find((r) => r.id === "run-1")!;
  /** Re-bind with a post hook configured, as the scheduler would at fire time. */
  const withPostHook = (post: string): void => bind(notifications, post);
  return {
    lifecycle,
    history,
    enabled,
    running,
    awaiting,
    viewed,
    openDialogs,
    settleSession,
    sent,
    frame,
    rowNow,
    postRuns,
    scriptResult,
    withPostHook,
    bind,
    routineNotifications,
    clearedNotifications,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-routine-life-"));
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("RoutineLifecycleManager settle grace (U9a)", () => {
  it("settles 60 s after a terminal agent_end and records an on-time row", async () => {
    const h = harness();
    h.frame({ type: "agent_start" });
    h.frame({ type: "agent_end", isTerminal: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    h.frame({ type: "agent_end" });
    expect(h.rowNow()).toMatchObject({ outcome: "on-time", reasonCode: null });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.settleSession).toHaveBeenCalledWith(TAB);
  });

  it("agent_start inside the grace cancels it and the next terminal end re-arms", async () => {
    const h = harness("late");
    h.frame({ type: "agent_end" });
    expect(h.rowNow().outcome).toBe("late");
    await vi.advanceTimersByTimeAsync(30_000);
    h.frame({ type: "agent_start" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    h.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).toHaveBeenCalledTimes(1);
  });

  it("an open answer gate at expiry skips the settle (inRun re-checked)", async () => {
    const h = harness();
    h.frame({ type: "agent_end" });
    h.awaiting.add(TAB);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).not.toHaveBeenCalled();
  });

  it("defers self-Settle while a client views the tab and settles 60 s after leaving view (#1305)", async () => {
    const h = harness();
    h.viewed.add(TAB);
    h.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    h.viewed.delete(TAB);
    h.lifecycle.noteViewedChanged(TAB, "other-tab");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.settleSession).toHaveBeenCalledWith(TAB);
  });

  it("trackResume settles a resumed run 60 s after leaving view without touching history, post hooks, or notifications (#1305)", async () => {
    const h = harness("clock", ROUTINE_RUN_WALL_CLOCK_MS, { ...DEFAULT_ROUTINE_NOTIFICATIONS, onComplete: true }, false);
    const beforeRow = h.rowNow();
    h.viewed.add(TAB);
    h.lifecycle.trackResume(TAB);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    // Leaving view arms a fresh 60 s grace.
    h.viewed.delete(TAB);
    h.lifecycle.noteViewedChanged(TAB, null);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.settleSession).toHaveBeenCalledWith(TAB);
    expect(h.postRuns).toHaveLength(0);
    expect(h.routineNotifications).toHaveLength(0);
    expect(h.rowNow()).toEqual(beforeRow);
  });

  it("trackResume settle is cancelled by agent_start and re-armed after follow-up agent_end (#1305)", async () => {
    const h = harness("clock", ROUTINE_RUN_WALL_CLOCK_MS, { ...DEFAULT_ROUTINE_NOTIFICATIONS }, false);
    h.lifecycle.trackResume(TAB);
    await vi.advanceTimersByTimeAsync(30_000);
    h.frame({ type: "agent_start" });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    h.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).toHaveBeenCalledWith(TAB);
  });
});

describe("RoutineLifecycleManager approval auto-Deny (U9b)", () => {
  it("answers verbatim Deny over the reply rail at 24 h (never kills) and the run finishes into settle", async () => {
    const h = harness();
    h.frame({ type: "agent_start" });
    h.frame(approvalFrame("card-1"));
    h.openDialogs.push("card-1");
    expect(h.rowNow().outcome).toBe("waiting-approval");
    expect(h.lifecycle.waitingApprovalCount()).toBe(1);
    // Wall clock fires first at 30 min unless the run continues; simulate a human continuation (resume path)
    // by checking only the approval clock: re-bind without a wall deadline.
    h.lifecycle.trackStart(TAB, "run-1", "clock", Date.now() + 48 * 3_600_000, {
      scripts: { pre: "", post: "" },
      routineId: ROUTINE_ID,
      routineName: "Inbox",
      notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
      projectCwd: "/proj",
      workspace: "worktree",
      wallClockMs: null,
    });
    await vi.advanceTimersByTimeAsync(24 * 3_600_000 - 60_000);
    expect(h.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sent).toEqual([{ tabId: TAB, cmd: { type: "extension_ui_response", id: "card-1", value: "Deny" } }]);
    expect(h.settleSession).not.toHaveBeenCalled();
    h.lifecycle.onSend(TAB, h.sent[0]!.cmd);
    h.frame({ type: "agent_end" });
    expect(h.rowNow()).toMatchObject({ outcome: "on-time", reasonCode: "approval-timeout" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).toHaveBeenCalledTimes(1);
  });

  it("a human answer (local or remote rpcSend) or a cancel frame cancels the 24 h timer", async () => {
    const h = harness();
    h.lifecycle.trackStart(TAB, "run-1", "clock", Date.now() + 48 * 3_600_000, {
      scripts: { pre: "", post: "" },
      routineId: ROUTINE_ID,
      routineName: "Inbox",
      notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
      projectCwd: "/proj",
      workspace: "worktree",
      wallClockMs: null,
    });
    h.frame(approvalFrame("card-1"));
    h.frame(approvalFrame("card-2"));
    h.openDialogs.push("card-1", "card-2");
    h.lifecycle.onSend(TAB, { type: "extension_ui_response", id: "card-1", value: "Approve" });
    h.frame({ type: "extension_ui_request", method: "cancel", targetId: "card-2" });
    expect(h.lifecycle.waitingApprovalCount()).toBe(0);
    expect(h.rowNow().outcome).toBe("running");
    await vi.advanceTimersByTimeAsync(25 * 3_600_000);
    expect(h.sent).toEqual([]);
  });

  it("does not answer a card omp already closed", async () => {
    const h = harness();
    h.lifecycle.trackStart(TAB, "run-1", "clock", Date.now() + 48 * 3_600_000, {
      scripts: { pre: "", post: "" },
      routineId: ROUTINE_ID,
      routineName: "Inbox",
      notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
      projectCwd: "/proj",
      workspace: "worktree",
      wallClockMs: null,
    });
    h.frame(approvalFrame("card-1"));
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.sent).toEqual([]);
  });
});

describe("RoutineLifecycleManager wall clock (U9c)", () => {
  it("runs through parked-card time and settles at 30 min from fire with a wall-clock Failed row", async () => {
    const h = harness();
    h.frame({ type: "agent_start" });
    h.frame(approvalFrame("card-1"));
    h.openDialogs.push("card-1");
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 60_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).toHaveBeenCalledWith(TAB);
    expect(h.rowNow()).toMatchObject({ outcome: "failed", reasonCode: "wall-clock" });
    expect(h.sent).toEqual([]);
  });

  it("a terminal agent_end before 30 min cancels the wall clock", async () => {
    const h = harness();
    h.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(h.settleSession).toHaveBeenCalledTimes(1);
    expect(h.rowNow().outcome).toBe("on-time");
  });

  it("enforces a shorter custom wall clock (5 min)", async () => {
    const h = harness("clock", 5 * 60_000);
    h.frame({ type: "agent_start" });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).toHaveBeenCalledWith(TAB);
    expect(h.rowNow()).toMatchObject({ outcome: "failed", reasonCode: "wall-clock" });
  });

  it("enforces a longer custom wall clock (90 min) past the 30-min default", async () => {
    const h = harness("clock", 90 * 60_000);
    h.frame({ type: "agent_start" });
    await vi.advanceTimersByTimeAsync(35 * 60_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(h.settleSession).toHaveBeenCalledWith(TAB);
    expect(h.rowNow()).toMatchObject({ outcome: "failed", reasonCode: "wall-clock" });
  });

  it("unlimited (wallClockMs: null) never reaps for wall-clock, while Approval auto-Deny and settle grace still fire", async () => {
    const h = harness("clock", null);
    h.frame({ type: "agent_start" });
    await vi.advanceTimersByTimeAsync(30 * 3_600_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    expect(h.rowNow()).toMatchObject({ outcome: "running", reasonCode: null });

    // Approval card still auto-Denies at 24 h even without a wall clock.
    h.frame(approvalFrame("card-u"));
    h.openDialogs.push("card-u");
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.sent).toEqual([{ tabId: TAB, cmd: { type: "extension_ui_response", id: "card-u", value: "Deny" } }]);
    expect(h.settleSession).not.toHaveBeenCalled();
    h.lifecycle.onSend(TAB, h.sent[0]!.cmd);

    // Terminal agent_end still self-Settles after 60 s.
    h.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).toHaveBeenCalledTimes(1);
  });
});

describe("RoutineLifecycleManager outcomes (U9d-e)", () => {
  it("records a cost-cap Failed row from the cost-gate notice and cost_cap prompt_result, then settles via grace", async () => {
    const h = harness();
    h.frame({ type: "notice", level: "error", source: "cost-gate", message: "cap hit" });
    h.frame({ type: "prompt_result", error: { code: "cost_cap", retryable: false } });
    h.frame({ type: "agent_end" });
    expect(h.rowNow()).toMatchObject({ outcome: "failed", reasonCode: "cost-cap" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).toHaveBeenCalledTimes(1);
  });

  it("records a usage-limit Failed row from the first prompt's assistant error, else a generic error row", () => {
    const h = harness();
    h.frame({ type: "message_end", message: { role: "assistant", stopReason: "error", errorId: OMP_ERROR_FLAG_USAGE_LIMIT } });
    h.frame({ type: "agent_end" });
    expect(h.rowNow()).toMatchObject({ outcome: "failed", reasonCode: "usage-limit" });

    const g = harness();
    g.frame({ type: "message_end", message: { role: "assistant", stopReason: "error", errorId: 1 } });
    g.frame({ type: "agent_end" });
    expect(g.rowNow()).toMatchObject({ outcome: "failed", reasonCode: "error" });
  });

  it("a process exit before the terminal end records a fixed failed outcome", () => {
    const h = harness();
    h.frame({ type: "agent_start" });
    h.lifecycle.onExit(TAB);
    expect(h.rowNow()).toMatchObject({ outcome: "failed", reasonCode: "error" });
  });

  it("buffers outcome writes that arrive before the run row is bound", () => {
    const history = new RoutineRunHistory(path.join(dir, "early.json"));
    history.record({ ...row("run-early"), tabId: "tab-early" });
    const postRuns: string[] = [];
    const lifecycle = new RoutineLifecycleManager({
      history,
      isEnabled: () => true,
      isRoutineTab: () => true,
      inRun: () => false,
      awaitingHumanAnswer: () => false,
      isViewed: () => false,
      openDialogIds: () => [],
      settleSession: async () => true,
      rpcSend: () => {},
      runScript: async (command) => {
        postRuns.push(command);
        return { kind: "ok" };
      },
      runDirectory: () => "/work/early",
      publish: () => {},
    });
    lifecycle.onFrame("tab-early", { type: "agent_end" });
    lifecycle.trackStart("tab-early", "run-early", "clock", T0, {
      scripts: { pre: "", post: "echo deferred" },
      routineId: ROUTINE_ID,
      routineName: "Inbox",
      notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
      projectCwd: "/proj",
      workspace: "worktree",
      wallClockMs: ROUTINE_RUN_WALL_CLOCK_MS,
    });
    expect(history.list()[0]).toMatchObject({ outcome: "on-time" });
    // Pre-bind race (#1283): finalization happened on the early frame; the
    // deferred post still runs exactly once at bind, without re-arming settle.
    expect(postRuns).toEqual(["echo deferred"]);
    lifecycle.disposeAll();
  });
});

describe("RoutineLifecycleManager gate-off park", () => {
  it("parkAll clears every timer without settling or answering, and resumeAll re-arms from absolute deadlines", async () => {
    const h = harness();
    h.frame(approvalFrame("card-1"));
    h.openDialogs.push("card-1");
    h.enabled.value = false;
    h.lifecycle.parkAll();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(h.settleSession).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    h.enabled.value = true;
    h.lifecycle.resumeAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.settleSession).toHaveBeenCalledTimes(1);
    expect(h.rowNow().reasonCode).toBe("wall-clock");
  });

  it("ignores frames from non-routine tabs", () => {
    const h = harness();
    h.lifecycle.onFrame("coding-tab", approvalFrame("x"));
    expect(h.lifecycle.waitingApprovalCount()).toBe(0);
  });
});

describe("RoutineLifecycleManager post-run hook (#1283)", () => {
  it("runs the hook exactly once on terminal end, before the settle grace is armed", async () => {
    const h = harness();
    h.withPostHook("echo done");
    h.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.postRuns).toHaveLength(1);
    expect(h.postRuns[0]!.command).toBe("echo done");
    expect(h.postRuns[0]!.cwd).toBe("/work/run-dir");
    expect(h.postRuns[0]!.env).toMatchObject({
      OMP_UI_ROUTINE_ID: ROUTINE_ID,
      OMP_UI_ROUTINE_TRIGGER: "clock",
      OMP_UI_ROUTINE_PROJECT_CWD: "/proj",
      OMP_UI_ROUTINE_WORKSPACE: "worktree",
      OMP_UI_ROUTINE_OUTCOME: "on-time",
      OMP_UI_ROUTINE_REASON_CODE: "",
      OMP_UI_ROUTINE_TAB_ID: TAB,
      OMP_UI_ROUTINE_RUN_CWD: "/work/run-dir",
    });
    expect(h.rowNow()).toMatchObject({ outcome: "on-time", postScript: "ok" });
    // Settle armed after the hook: the grace fires 60 s after it resolved.
    expect(h.settleSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settleSession).toHaveBeenCalledTimes(1);
  });

  it("maps skip to failed and timeout to timeout on the row", async () => {
    const h = harness();
    h.withPostHook("exit 78");
    h.scriptResult.current = { kind: "skip", timedOut: false, exitCode: 78 };
    h.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rowNow().postScript).toBe("failed"); // skip convention is pre-only

    const g = harness();
    g.withPostHook("sleep 999");
    g.scriptResult.current = { kind: "failed", timedOut: true, exitCode: null };
    g.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(0);
    expect(g.rowNow().postScript).toBe("timeout");
  });

  it("never re-runs the hook on a continuation turn and never rewrites the outcome", async () => {
    const h = harness();
    h.withPostHook("echo done");
    h.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.postRuns).toHaveLength(1);
    // A human continuation turn ends with its own agent_end: no second hook,
    // and the failed/cost-cap from first finalization survives.
    h.scriptResult.current = { kind: "failed", timedOut: false, exitCode: 3 };
    h.frame({ type: "agent_start" });
    h.awaiting.add(TAB);
    h.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.postRuns).toHaveLength(1);
    expect(h.rowNow().outcome).toBe("on-time"); // first finalization wins
    expect(h.rowNow().postScript).toBe("ok"); // the second result never overwrote it
  });

  it("wall clock runs the hook only after a successful reap, and onExit cannot steal it", async () => {
    const h = harness();
    h.withPostHook("notify");
    let releaseReap!: (v: boolean) => void;
    h.settleSession.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (releaseReap = resolve)),
    );
    h.frame({ type: "agent_start" });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.settleSession).toHaveBeenCalledWith(TAB);
    expect(h.postRuns).toHaveLength(0); // still awaiting the reap
    // The reap notifies onExit synchronously mid-await; the claim already landed.
    h.lifecycle.onExit(TAB);
    releaseReap(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.postRuns).toHaveLength(1);
    expect(h.postRuns[0]!.env.OMP_UI_ROUTINE_OUTCOME).toBe("failed");
    expect(h.postRuns[0]!.env.OMP_UI_ROUTINE_REASON_CODE).toBe("wall-clock");
    const late = h.history.list().find((r) => r.id === "run-1")!;
    expect(late.reasonCode).toBe("wall-clock"); // never rewritten to error
    expect(late.postScript).toBe("ok");
  });

  it("records interrupted and runs nothing when the reap resolves false", async () => {
    const h = harness();
    h.withPostHook("notify");
    h.settleSession.mockResolvedValueOnce(false);
    h.frame({ type: "agent_start" });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.postRuns).toHaveLength(0);
    expect(h.rowNow()).toMatchObject({ reasonCode: "wall-clock", postScript: "interrupted" });
  });

  it("skips the hook when none is configured, and records interrupted when the gate is off at post time", async () => {
    const plain = harness();
    plain.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(0);
    expect(plain.postRuns).toHaveLength(0);
    expect(plain.rowNow().postScript).toBeUndefined();

    const h = harness();
    h.withPostHook("notify");
    h.enabled.value = false;
    h.frame({ type: "agent_end" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.postRuns).toHaveLength(0);
    expect(h.rowNow().postScript).toBe("interrupted");
  });

  it("a post hook keeps the latch set while it runs and releases it when it settles", async () => {
    const gate = Promise.withResolvers<{ kind: "ok" }>();
    const history = new RoutineRunHistory(path.join(dir, `latch-${++fileSeq}.json`));
    history.record(row("run-1"));
    const mgr = new RoutineLifecycleManager({
      history,
      isEnabled: () => true,
      isRoutineTab: () => true,
      inRun: () => false,
      awaitingHumanAnswer: () => false,
      isViewed: () => false,
      openDialogIds: () => [],
      settleSession: async () => true,
      rpcSend: () => {},
      runScript: () => gate.promise,
      runDirectory: () => "/work/run-dir",
      publish: () => {},
    });
    mgr.trackStart(TAB, "run-1", "clock", T0, {
      scripts: { pre: "", post: "slow" },
      routineId: ROUTINE_ID,
      routineName: "Inbox",
      projectCwd: "/proj",
      workspace: "worktree",
      wallClockMs: ROUTINE_RUN_WALL_CLOCK_MS,
      notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
    });
    mgr.onFrame(TAB, { type: "agent_end" });
    await vi.advanceTimersByTimeAsync(0);
    // The hook is in flight; the latch holds even though the settle grace has
    // not been armed yet (§7.4).
    expect(mgr.postRunning(TAB)).toBe(true);
    gate.resolve({ kind: "ok" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.postRunning(TAB)).toBe(false);
  });

  it("a continuation in flight when the hook settles leaves the settle deadline disarmed", async () => {
    const settleSession = vi.fn(async () => true);
    const gate = Promise.withResolvers<{ kind: "ok" }>();
    const history = new RoutineRunHistory(path.join(dir, `cont-${++fileSeq}.json`));
    history.record(row("run-1"));
    const awaiting = new Set<string>();
    const mgr = new RoutineLifecycleManager({
      history,
      isEnabled: () => true,
      isRoutineTab: () => true,
      inRun: (tabId) => awaiting.has(tabId),
      awaitingHumanAnswer: (tabId) => awaiting.has(tabId),
      isViewed: () => false,
      openDialogIds: () => [],
      settleSession,
      rpcSend: () => {},
      runScript: () => gate.promise,
      runDirectory: () => "/work/run-dir",
      publish: () => {},
    });
    mgr.trackStart(TAB, "run-1", "clock", T0, {
      scripts: { pre: "", post: "slow" },
      routineId: ROUTINE_ID,
      routineName: "Inbox",
      projectCwd: "/proj",
      workspace: "worktree",
      wallClockMs: ROUTINE_RUN_WALL_CLOCK_MS,
      notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
    });
    mgr.onFrame(TAB, { type: "agent_end" });
    // A human continuation parks a card while the hook is still in flight.
    awaiting.add(TAB);
    gate.resolve({ kind: "ok" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settleSession).not.toHaveBeenCalled(); // fence saw awaitingHumanAnswer → no grace armed
  });
});

describe("RoutineLifecycleManager notifications (#1294)", () => {
  it("posts onApproval with tool name, clears on card close, and stays silent when off", () => {
    const h = harness("clock", ROUTINE_RUN_WALL_CLOCK_MS, { ...DEFAULT_ROUTINE_NOTIFICATIONS, onApproval: true });
    h.frame(approvalFrame("req-1"));
    expect(h.routineNotifications).toEqual([
      { routineId: ROUTINE_ID, tabId: TAB, title: "Inbox", body: "Approval needed: mcp__gmail_send_message" },
    ]);
    h.lifecycle.onSend(TAB, { type: "extension_ui_response", id: "req-1", value: "Approve" });
    expect(h.clearedNotifications).toEqual([TAB]);

    const silent = harness("clock", ROUTINE_RUN_WALL_CLOCK_MS, { ...DEFAULT_ROUTINE_NOTIFICATIONS });
    silent.frame(approvalFrame("req-2"));
    expect(silent.routineNotifications).toHaveLength(0);
  });

  it("posts onComplete fallback unless agentMessage && agentNotified, and never re-notifies on continuation turns", () => {
    const fallback = harness("clock", ROUTINE_RUN_WALL_CLOCK_MS, {
      ...DEFAULT_ROUTINE_NOTIFICATIONS,
      onComplete: true,
      agentMessage: true,
    });
    fallback.frame({ type: "agent_end" });
    expect(fallback.routineNotifications).toEqual([
      { routineId: ROUTINE_ID, tabId: TAB, title: "Inbox", body: "Completed" },
    ]);
    // Human continuation turn ends later: must not notify a second time.
    fallback.frame({ type: "agent_start" });
    fallback.frame({ type: "agent_end" });
    expect(fallback.routineNotifications).toHaveLength(1);

    const agentSent = harness("clock", ROUTINE_RUN_WALL_CLOCK_MS, {
      ...DEFAULT_ROUTINE_NOTIFICATIONS,
      onComplete: true,
      agentMessage: true,
    });
    agentSent.lifecycle.markAgentNotified(TAB);
    agentSent.frame({ type: "agent_end" });
    expect(agentSent.routineNotifications).toHaveLength(0);
  });

  it("posts onFail for wall-clock, cost-cap, usage-limit, error, and premature exit even after markAgentNotified", async () => {
    const allOn: RoutineNotifications = {
      onStart: true,
      onComplete: true,
      onFail: true,
      onApproval: true,
      agentMessage: true,
    };

    // Cost cap after agent already notified.
    const cost = harness("clock", ROUTINE_RUN_WALL_CLOCK_MS, allOn);
    cost.lifecycle.markAgentNotified(TAB);
    cost.frame({ type: "notice", source: "cost-gate", level: "error" });
    cost.frame({ type: "agent_end" });
    expect(cost.routineNotifications).toEqual([
      { routineId: ROUTINE_ID, tabId: TAB, title: "Inbox", body: "Failed — Stopped at spend cap" },
    ]);

    // Usage limit.
    const usage = harness("clock", ROUTINE_RUN_WALL_CLOCK_MS, allOn);
    usage.frame({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorId: OMP_ERROR_FLAG_USAGE_LIMIT },
    });
    usage.frame({ type: "agent_end" });
    expect(usage.routineNotifications[0]!.body).toBe("Failed — Provider usage limit reached");

    // Wall-clock timeout.
    const wall = harness("clock", 60_000, allOn);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wall.routineNotifications[0]!.body).toBe("Failed — Timed out (wall-clock limit reached)");

    // Premature exit.
    const crash = harness("clock", ROUTINE_RUN_WALL_CLOCK_MS, allOn);
    crash.lifecycle.onExit(TAB);
    expect(crash.routineNotifications[0]!.body).toBe("Failed — Ended with error");
  });

  it("flushes pre-bind approval and terminal notifications once trackStart binds", () => {
    const preApproval = harness(
      "clock",
      ROUTINE_RUN_WALL_CLOCK_MS,
      { ...DEFAULT_ROUTINE_NOTIFICATIONS, onApproval: true },
      false,
    );
    preApproval.frame(approvalFrame("req-early"));
    expect(preApproval.routineNotifications).toHaveLength(0);
    preApproval.bind();
    expect(preApproval.routineNotifications).toEqual([
      { routineId: ROUTINE_ID, tabId: TAB, title: "Inbox", body: "Approval needed: mcp__gmail_send_message" },
    ]);

    const preEnd = harness(
      "clock",
      ROUTINE_RUN_WALL_CLOCK_MS,
      { ...DEFAULT_ROUTINE_NOTIFICATIONS, onComplete: true },
      false,
    );
    preEnd.frame({ type: "agent_end" });
    expect(preEnd.routineNotifications).toHaveLength(0);
    preEnd.bind();
    expect(preEnd.routineNotifications).toEqual([
      { routineId: ROUTINE_ID, tabId: TAB, title: "Inbox", body: "Completed" },
    ]);
  });

  it("pins notifications at trackStart so mutating the source object mid-run does not alter in-flight alerts", () => {
    const mutable: RoutineNotifications = { ...DEFAULT_ROUTINE_NOTIFICATIONS, onComplete: true };
    const h = harness("clock", ROUTINE_RUN_WALL_CLOCK_MS, mutable);
    mutable.onComplete = false;
    h.frame({ type: "agent_end" });
    expect(h.routineNotifications).toEqual([
      { routineId: ROUTINE_ID, tabId: TAB, title: "Inbox", body: "Completed" },
    ]);
  });
});
