import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HELD_PROMPT_MARGIN_MS,
  LIMITS_STATUS_KEY,
  OMP_ERROR_FLAG_USAGE_LIMIT,
  type OwnedSessionRecord,
  type RpcFrame,
} from "@omp-ui/core";
import { HeldPromptScheduler } from "./held-prompt-scheduler";
import { ownedSessionRecord } from "./test/fixtures";

const TAB = "tab-1";
const NOW = 1_800_000_000_000;

interface Harness {
  scheduler: HeldPromptScheduler;
  record: () => OwnedSessionRecord;
  sent: RpcFrame[];
  resumes: string[];
  setLive: (live: boolean) => void;
  setCanSend: (can: boolean) => void;
}

let dir: string;

function harness(): Harness {
  let records: OwnedSessionRecord[] = [ownedSessionRecord({ tabId: TAB, mode: "rpc-ui", lineageDir: "lin" })];
  let live = true;
  let canSend = true;
  const sent: RpcFrame[] = [];
  const resumes: string[] = [];
  const scheduler = new HeldPromptScheduler({
    sessions: () => records,
    updateSession: (tabId, patch) => {
      records = records.map((r) => (r.tabId === tabId ? { ...r, ...patch } : r));
    },
    broadcast: () => {},
    lineageDir: (record) => path.join(dir, record.lineageDir),
    canSendNow: () => canSend,
    isLive: () => live,
    busy: () => false,
    send: (_tabId, cmd) => sent.push(cmd),
    resume: async (tabId) => {
      resumes.push(tabId);
    },
    refreshLimits: () => {},
  });
  return {
    scheduler,
    record: () => records[0]!,
    sent,
    resumes,
    setLive: (v) => (live = v),
    setCanSend: (v) => (canSend = v),
  };
}

function ack(id: string, success: boolean, error?: string): RpcFrame {
  return { type: "response", id, command: "prompt", success, ...(error ? { error } : {}) } as RpcFrame;
}

function assistantEnd(errorId?: number): RpcFrame {
  return {
    type: "message_end",
    message: { role: "assistant", stopReason: errorId === undefined ? "stop" : "error", errorId },
  } as RpcFrame;
}

function limits(resetsAtMs: number, percent = 100): RpcFrame {
  return {
    type: "extension_ui_request",
    id: "s1",
    method: "setStatus",
    statusKey: LIMITS_STATUS_KEY,
    statusText: JSON.stringify({
      available: true,
      provider: "anthropic",
      windows: [{ id: "5h", label: "5 hour", percent, resetsAtMs }],
      bankedResets: 0,
      fetchedAtMs: NOW,
    }),
  } as RpcFrame;
}

/** Holds a prompt due at `resetAtMs`, lets the process report ready, and returns its command id. */
function holdReady(h: Harness, resetAtMs: number): void {
  h.scheduler.onFrame(TAB, { type: "ready" } as RpcFrame);
  h.scheduler.hold(TAB, { text: "next step", preview: "next step", images: [], documents: [], resetAtMs });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-prompt-"));
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("HeldPromptScheduler", () => {
  it("sends nothing before the reset plus margin, then the held wire text once", () => {
    const h = harness();
    holdReady(h, NOW + 10 * 60_000);
    expect(h.record().heldPrompt?.sendAtMs).toBe(NOW + 10 * 60_000 + HELD_PROMPT_MARGIN_MS);
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sent).toEqual([]);
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ type: "prompt", message: "next step" });
    vi.advanceTimersByTime(5 * 60_000);
    expect(h.sent).toHaveLength(1);
  });

  it("waits while the session is mid-turn and fires at the turn's end", () => {
    const h = harness();
    h.setCanSend(false);
    holdReady(h, NOW);
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    expect(h.sent).toEqual([]);
    h.setCanSend(true);
    h.scheduler.onFrame(TAB, { type: "agent_end" } as RpcFrame);
    expect(h.sent).toHaveLength(1);
  });

  it("consumes the prompt when its turn ends clean", () => {
    const h = harness();
    holdReady(h, NOW);
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    const id = h.sent[0]!.id as string;
    h.scheduler.onFrame(TAB, ack(id, true));
    expect(h.record().heldPrompt?.sentAtMs).toBe(NOW + HELD_PROMPT_MARGIN_MS);
    h.scheduler.onFrame(TAB, { type: "agent_start" } as RpcFrame);
    h.scheduler.onFrame(TAB, assistantEnd());
    h.scheduler.onFrame(TAB, { type: "agent_end" } as RpcFrame);
    expect(h.record().heldPrompt).toBeNull();
    expect(fs.existsSync(path.join(dir, "lin", "held-prompt.json"))).toBe(false);
  });

  it("re-arms on the next reported reset when the turn fails on the usage limit again", () => {
    const h = harness();
    holdReady(h, NOW);
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    h.scheduler.onFrame(TAB, ack(h.sent[0]!.id as string, true));
    h.scheduler.onFrame(TAB, { type: "agent_start" } as RpcFrame);
    h.scheduler.onFrame(TAB, assistantEnd(OMP_ERROR_FLAG_USAGE_LIMIT));
    h.scheduler.onFrame(TAB, { type: "agent_end" } as RpcFrame);
    expect(h.record().heldPrompt).toMatchObject({ sendAtMs: null, sentAtMs: null, attempts: 1 });
    const nextReset = Date.now() + 30 * 60_000;
    h.scheduler.onFrame(TAB, limits(nextReset));
    expect(h.record().heldPrompt?.sendAtMs).toBe(nextReset + HELD_PROMPT_MARGIN_MS);
    vi.advanceTimersByTime(30 * 60_000 + HELD_PROMPT_MARGIN_MS);
    expect(h.sent).toHaveLength(2);
  });

  it("keeps a rejected prompt for the user instead of retrying", () => {
    const h = harness();
    holdReady(h, NOW);
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    h.scheduler.onFrame(TAB, ack(h.sent[0]!.id as string, false, "model is held"));
    expect(h.record().heldPrompt).toMatchObject({ sendAtMs: null, error: "model is held" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sent).toHaveLength(1);
  });

  it("never re-sends an admitted prompt after its process died", () => {
    const h = harness();
    holdReady(h, NOW);
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    h.scheduler.onFrame(TAB, ack(h.sent[0]!.id as string, true));
    h.setLive(false);
    h.scheduler.onExit(TAB);
    expect(h.record().heldPrompt).toBeNull();
    expect(h.scheduler.initialCommand(h.record(), false)).toBeNull();
  });

  it("resumes a session that is not running and rides the spawn's initial commands", () => {
    const h = harness();
    h.setLive(false);
    h.scheduler.hold(TAB, { text: "next step", preview: "next step", images: [], documents: [], resetAtMs: NOW });
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    expect(h.resumes).toEqual([TAB]);
    expect(h.scheduler.initialCommand(h.record(), true)).toBeNull();
    expect(h.scheduler.initialCommand(h.record(), false)).toMatchObject({ type: "prompt", message: "next step" });
  });

  it("cancel returns the wire text and drops the prompt", () => {
    const h = harness();
    holdReady(h, NOW + 60 * 60_000);
    expect(h.scheduler.cancel(TAB)).toEqual({ text: "next step", images: [] });
    expect(h.record().heldPrompt).toBeNull();
    vi.advanceTimersByTime(2 * 60 * 60_000);
    expect(h.sent).toEqual([]);
  });
});
