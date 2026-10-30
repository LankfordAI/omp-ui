import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedSessionRecord, RpcFrame, ScheduledPrompt } from "@omp-ui/core";
import { ScheduledPromptRunner } from "./scheduled-prompt-runner";
import { ownedSessionRecord } from "./test/fixtures";

const TAB = "tab-1";
// 2026-10-30 08:00 UTC.
const NOW = Date.UTC(2026, 9, 30, 8, 0);
const DAILY_9 = { kind: "cron", expr: "0 9 * * *" } as const;

interface Harness {
  runner: ScheduledPromptRunner;
  record: () => OwnedSessionRecord;
  scheduled: () => ScheduledPrompt;
  sent: RpcFrame[];
  resumes: string[];
  setLive: (live: boolean) => void;
  setInRun: (inRun: boolean) => void;
  patchRecord: (patch: Partial<OwnedSessionRecord>) => void;
}

function harness(): Harness {
  let records: OwnedSessionRecord[] = [ownedSessionRecord({ tabId: TAB, mode: "rpc-ui", lineageDir: "lin" })];
  let live = true;
  let inRun = false;
  const sent: RpcFrame[] = [];
  const resumes: string[] = [];
  const patchRecord = (patch: Partial<OwnedSessionRecord>): void => {
    records = records.map((r) => (r.tabId === TAB ? { ...r, ...patch } : r));
  };
  const runner = new ScheduledPromptRunner({
    sessions: () => records,
    updateSession: (_tabId, patch) => patchRecord(patch),
    broadcast: () => {},
    isLive: () => live,
    busy: () => false,
    inRun: () => inRun,
    canSendNow: () => true,
    planBridgeLoaded: () => true,
    send: (_tabId, cmd) => sent.push(cmd),
    resume: async (tabId) => {
      resumes.push(tabId);
    },
  });
  return {
    runner,
    record: () => records[0]!,
    scheduled: () => records[0]!.scheduledPrompt!,
    sent,
    resumes,
    setLive: (v) => (live = v),
    setInRun: (v) => (inRun = v),
    patchRecord,
  };
}

const ack = (id: string, success: boolean): RpcFrame => ({ type: "response", id, command: "prompt", success }) as RpcFrame;

describe("ScheduledPromptRunner (issue #987)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a daily prompt at its time through rpcSend and arms the next day", () => {
    const h = harness();
    h.runner.onFrame(TAB, { type: "ready" } as RpcFrame);
    h.runner.set(TAB, { text: "triage new issues", schedule: DAILY_9, timeZone: "UTC" });
    expect(h.scheduled().nextRunAtMs).toBe(Date.UTC(2026, 9, 30, 9, 0));
    vi.advanceTimersByTime(60 * 60_000);
    expect(h.sent).toEqual([expect.objectContaining({ type: "prompt", message: "triage new issues" })]);
    h.runner.onFrame(TAB, ack(h.sent[0]!.id as string, true));
    expect(h.scheduled()).toMatchObject({ nextRunAtMs: Date.UTC(2026, 9, 31, 9, 0), lastRunAtMs: expect.any(Number), notices: [] });
  });

  it("skips a fire while a run is in progress and records a notice instead of queuing", () => {
    const h = harness();
    h.runner.onFrame(TAB, { type: "ready" } as RpcFrame);
    h.runner.set(TAB, { text: "audit", schedule: DAILY_9, timeZone: "UTC" });
    h.setInRun(true);
    vi.advanceTimersByTime(60 * 60_000);
    expect(h.sent).toEqual([]);
    expect(h.scheduled().notices).toEqual([expect.objectContaining({ kind: "skipped", dueAtMs: Date.UTC(2026, 9, 30, 9, 0) })]);
    expect(h.scheduled().nextRunAtMs).toBe(Date.UTC(2026, 9, 31, 9, 0));
    // The run ending does not send the skipped fire after all.
    h.setInRun(false);
    h.runner.onFrame(TAB, { type: "agent_end" } as RpcFrame);
    expect(h.sent).toEqual([]);
  });

  it("runs fires missed while the app was closed once, at startup, with a late notice", () => {
    const h = harness();
    h.runner.set(TAB, { text: "audit", schedule: DAILY_9, timeZone: "UTC" });
    h.runner.disposeAll();
    // Four days later, the app starts with no process for the session.
    vi.setSystemTime(Date.UTC(2026, 10, 3, 12, 0));
    h.setLive(false);
    const boot = new ScheduledPromptRunner({
      sessions: () => [h.record()],
      updateSession: (_t, patch) => h.patchRecord(patch),
      broadcast: () => {},
      isLive: () => false,
      busy: () => false,
      inRun: () => false,
      canSendNow: () => true,
      planBridgeLoaded: () => true,
      send: () => {},
      resume: async (tabId) => {
        h.resumes.push(tabId);
      },
    });
    boot.sync();
    expect(h.resumes).toEqual([TAB]);
    // The resumed spawn carries the single prompt; plan mode is left first.
    const commands = boot.initialCommands(h.record(), false, true);
    expect(commands.map((c) => c.message)).toEqual(["/omp-ui-plan off", "audit"]);
    expect(h.scheduled().notices).toEqual([expect.objectContaining({ kind: "late", missed: 4 })]);
    expect(h.scheduled().nextRunAtMs).toBe(Date.UTC(2026, 10, 4, 9, 0));
    // A second spawn before the next occurrence sends nothing.
    expect(boot.initialCommands(h.record(), false, false)).toEqual([]);
    boot.disposeAll();
  });

  it("switches a live plan-mode session to Build before the prompt", () => {
    const h = harness();
    h.patchRecord({ agentMode: "plan" });
    h.runner.onFrame(TAB, { type: "ready" } as RpcFrame);
    h.runner.set(TAB, { text: "release check", schedule: DAILY_9, timeZone: "UTC" });
    vi.advanceTimersByTime(60 * 60_000);
    expect(h.sent.map((c) => c.message)).toEqual(["/omp-ui-plan off", "release check"]);
  });

  it("never re-sends a fire whose process died before omp admitted it, and drops an admitted one-shot", () => {
    const h = harness();
    h.runner.onFrame(TAB, { type: "ready" } as RpcFrame);
    h.runner.set(TAB, { text: "once", schedule: { kind: "once", atMs: NOW + 60_000 }, timeZone: "UTC" });
    vi.advanceTimersByTime(60_000);
    expect(h.sent).toHaveLength(1);
    h.runner.onExit(TAB);
    expect(h.scheduled()).toMatchObject({ nextRunAtMs: null, notices: [expect.objectContaining({ kind: "failed" })] });
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sent).toHaveLength(1);

    h.runner.set(TAB, { text: "once", schedule: { kind: "once", atMs: Date.now() + 60_000 }, timeZone: "UTC" });
    h.runner.onFrame(TAB, { type: "ready" } as RpcFrame);
    vi.advanceTimersByTime(60_000);
    h.runner.onFrame(TAB, ack(h.sent[1]!.id as string, true));
    expect(h.record().scheduledPrompt).toBeNull();
  });

  it("returns a snoozed session to the main list when its run starts", () => {
    const h = harness();
    h.patchRecord({ snoozed: true, snoozedUntilMs: null });
    h.runner.onFrame(TAB, { type: "ready" } as RpcFrame);
    h.runner.set(TAB, { text: "audit", schedule: DAILY_9, timeZone: "UTC" });
    vi.advanceTimersByTime(60 * 60_000);
    expect(h.record().snoozed).toBe(false);
  });
});
