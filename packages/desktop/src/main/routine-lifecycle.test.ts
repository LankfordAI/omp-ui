import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OMP_ERROR_FLAG_USAGE_LIMIT, RoutineRunHistory, type RoutineRunRow, type RpcFrame } from "@omp-ui/core";
import { RoutineLifecycleManager } from "./routine-lifecycle";

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

function harness(trigger: RoutineRunRow["trigger"] = "clock") {
  const history = new RoutineRunHistory(path.join(dir, `routine-runs-${++fileSeq}.json`));
  history.record(row("run-1", trigger));
  const enabled = { value: true };
  const running = new Set<string>();
  const awaiting = new Set<string>();
  const openDialogs: string[] = [];
  const settleSession = vi.fn(async () => true);
  const sent: Array<{ tabId: string; cmd: RpcFrame }> = [];
  const lifecycle = new RoutineLifecycleManager({
    history,
    isEnabled: () => enabled.value,
    isRoutineTab: (tabId) => tabId === TAB,
    inRun: (tabId) => running.has(tabId) || awaiting.has(tabId),
    awaitingHumanAnswer: (tabId) => awaiting.has(tabId),
    openDialogIds: () => [...openDialogs],
    settleSession,
    rpcSend: (tabId, cmd) => sent.push({ tabId, cmd }),
    publish: () => {},
    now: () => Date.now(),
  });
  lifecycle.trackStart(TAB, "run-1", trigger, T0);
  const frame = (f: RpcFrame): void => lifecycle.onFrame(TAB, f);
  const rowNow = (): RoutineRunRow => history.list().find((r) => r.id === "run-1")!;
  return { lifecycle, history, enabled, running, awaiting, openDialogs, settleSession, sent, frame, rowNow };
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
    h.lifecycle.trackStart(TAB, "run-1", "clock", Date.now() + 48 * 3_600_000);
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
    h.lifecycle.trackStart(TAB, "run-1", "clock", Date.now() + 48 * 3_600_000);
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
    h.lifecycle.trackStart(TAB, "run-1", "clock", Date.now() + 48 * 3_600_000);
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
    const lifecycle = new RoutineLifecycleManager({
      history,
      isEnabled: () => true,
      isRoutineTab: () => true,
      inRun: () => false,
      awaitingHumanAnswer: () => false,
      openDialogIds: () => [],
      settleSession: async () => true,
      rpcSend: () => {},
      publish: () => {},
    });
    lifecycle.onFrame("tab-early", { type: "agent_end" });
    lifecycle.trackStart("tab-early", "run-early", "clock", T0);
    expect(history.list()[0]).toMatchObject({ outcome: "on-time" });
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
