import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactError,
  HELD_PROMPT_MARGIN_MS,
  LIMITS_STATUS_KEY,
  OMP_ERROR_FLAG_USAGE_LIMIT,
  splitArtifactReferenceContext,
  withArtifactReferenceContext,
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

function harness(opts: { record?: OwnedSessionRecord; admitPayload?: (tabId: string, text: string) => void } = {}): Harness {
  let records: OwnedSessionRecord[] = [opts.record ?? ownedSessionRecord({ tabId: TAB, mode: "rpc-ui", lineageDir: "lin" })];
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
    admitPayload: opts.admitPayload,
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

function artifactWire(): string {
  const referenceId = "11111111-1111-4111-8111-111111111111";
  return withArtifactReferenceContext("Continue exactly: 한글 🗃️\nDo not rewrite the held wire.", [{
    version: 1,
    referenceId,
    ownerInstanceId: "22222222-2222-4222-8222-222222222222",
    artifactId: "33333333-3333-4333-8333-333333333333",
    codeRevisionId: "44444444-4444-4444-8444-444444444444",
    dataSnapshotId: "55555555-5555-4555-8555-555555555555",
    title: "Accepted chart",
    snapshotAt: new Date(NOW).toISOString(),
    includeData: false,
    machine: "Local",
    manifestUri: `omp-ui://artifacts/reference/${referenceId}/manifest`,
    definitionUri: `omp-ui://artifacts/reference/${referenceId}/definition`,
  }]);
}

function admissionGate() {
  let enabled = false;
  const admitPayload = vi.fn((tabId: string, text: string) => {
    expect(tabId).toBe(TAB);
    if (!enabled && splitArtifactReferenceContext(text).references.length > 0)
      throw new ArtifactError("disabled", "Artifact library is disabled");
  });
  return { admitPayload, enable: () => { enabled = true; } };
}

function savedPayload(): string {
  return fs.readFileSync(path.join(dir, "lin", "held-prompt.json"), "utf8");
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

  it("parks a disabled artifact reference at its deadline without consuming payload or timer retries", () => {
    const gate = admissionGate();
    const h = harness(gate);
    const text = artifactWire();
    const images = [{ type: "image" as const, data: "aGVsZA==", mimeType: "image/png" }];
    h.scheduler.onFrame(TAB, { type: "ready" } as RpcFrame);
    h.scheduler.hold(TAB, { text, preview: "Continue chart", images, documents: [], resetAtMs: NOW });
    const held = h.record().heldPrompt;
    const payload = savedPayload();
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    expect(h.sent).toEqual([]);
    expect(h.resumes).toEqual([]);
    expect(h.record().heldPrompt).toEqual({ ...held, error: "Artifact library is disabled" });
    expect(savedPayload()).toBe(payload);
    expect(vi.getTimerCount()).toBe(0);
    const attempts = gate.admitPayload.mock.calls.length;
    vi.advanceTimersByTime(10 * 60_000);
    h.scheduler.onFrame(TAB, { type: "ready" } as RpcFrame);
    h.scheduler.onFrame(TAB, { type: "agent_end" } as RpcFrame);
    h.scheduler.onFrame(TAB, limits(Date.now() + 60_000));
    expect(gate.admitPayload).toHaveBeenCalledTimes(attempts);
    expect(h.sent).toEqual([]);
    gate.enable();
    h.scheduler.sync();
    expect(h.sent).toEqual([{ type: "prompt", id: expect.any(String), message: text, images }]);
    expect(h.record().heldPrompt).toMatchObject({ sentAtMs: null, error: null });
    expect(savedPayload()).toBe(payload);
    h.scheduler.onFrame(TAB, ack(h.sent[0]!.id as string, true));
    expect(h.record().heldPrompt).toMatchObject({ sentAtMs: Date.now(), error: null });
  });

  it("rejects Send now without moving its deadline, then revalidates on enable and sends exact wire", () => {
    const gate = admissionGate();
    const h = harness(gate);
    const text = artifactWire();
    h.scheduler.onFrame(TAB, { type: "ready" } as RpcFrame);
    h.scheduler.hold(TAB, { text, preview: "Continue chart", images: [], documents: [], resetAtMs: NOW + 60 * 60_000 });
    const held = h.record().heldPrompt;
    const payload = savedPayload();
    h.scheduler.sendNow(TAB);
    expect(h.record().heldPrompt).toEqual({ ...held, error: "Artifact library is disabled" });
    expect(h.sent).toEqual([]);
    expect(savedPayload()).toBe(payload);
    expect(vi.getTimerCount()).toBe(0);
    gate.enable();
    h.scheduler.sync();
    expect(h.record().heldPrompt).toEqual(held);
    expect(h.sent).toEqual([]);
    h.scheduler.sendNow(TAB);
    expect(h.sent).toEqual([{ type: "prompt", id: expect.any(String), message: text }]);
    expect(savedPayload()).toBe(payload);
  });

  it("admits dormant payloads before resume and again at the initial-command rail", () => {
    const gate = admissionGate();
    const h = harness(gate);
    const text = artifactWire();
    h.setLive(false);
    h.scheduler.hold(TAB, { text, preview: "Continue chart", images: [], documents: [], resetAtMs: NOW });
    const payload = savedPayload();
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    expect(h.resumes).toEqual([]);
    expect(h.scheduler.initialCommand(h.record(), false)).toBeNull();
    expect(h.record().heldPrompt).toMatchObject({ sentAtMs: null, error: "Artifact library is disabled" });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5 * 60_000);
    expect(h.resumes).toEqual([]);
    gate.enable();
    h.scheduler.sync();
    expect(h.resumes).toEqual([TAB]);
    const initial = h.scheduler.initialCommand(h.record(), false);
    expect(initial).toEqual({ type: "prompt", id: expect.any(String), message: text });
    h.setLive(true);
    h.scheduler.onFrame(TAB, { type: "ready" } as RpcFrame);
    expect(h.sent).toEqual([]);
    expect(savedPayload()).toBe(payload);
  });

  it("revalidates a rejected unsent prompt after restart without resume retry spin or wire loss", () => {
    const gate = admissionGate();
    const first = harness(gate);
    const text = artifactWire();
    first.setLive(false);
    first.scheduler.hold(TAB, { text, preview: "Continue chart", images: [], documents: [], resetAtMs: NOW });
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    const record = first.record();
    const payload = savedPayload();
    first.scheduler.disposeAll();
    const restarted = harness({ record, admitPayload: gate.admitPayload });
    restarted.setLive(false);
    restarted.scheduler.sync();
    expect(restarted.resumes).toEqual([]);
    expect(restarted.record()).toEqual(record);
    expect(savedPayload()).toBe(payload);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(restarted.resumes).toEqual([]);
    gate.enable();
    restarted.scheduler.sync();
    expect(restarted.resumes).toEqual([TAB]);
    expect(restarted.scheduler.initialCommand(restarted.record(), false)).toEqual({
      type: "prompt", id: expect.any(String), message: text,
    });
    expect(restarted.record().heldPrompt).toMatchObject({ sentAtMs: null, error: null });
    expect(savedPayload()).toBe(payload);
  });

  it("leaves an existing in-flight latch untouched when initial-command admission rejects", () => {
    let reject = false;
    const h = harness({ admitPayload: () => { if (reject) throw new ArtifactError("disabled", "disabled"); } });
    h.setLive(false);
    h.scheduler.hold(TAB, { text: artifactWire(), preview: "Continue chart", images: [], documents: [], resetAtMs: NOW });
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    const initial = h.scheduler.initialCommand(h.record(), false)!;
    reject = true;
    expect(h.scheduler.initialCommand(h.record(), false)).toBeNull();
    h.setLive(true);
    h.scheduler.onFrame(TAB, { type: "ready" } as RpcFrame);
    reject = false;
    h.scheduler.sync();
    expect(h.sent).toEqual([]);
    h.scheduler.onFrame(TAB, ack(initial.id as string, true));
    expect(h.record().heldPrompt?.sentAtMs).toBe(Date.now());
  });

  it("keeps ordinary held delivery unchanged while artifact admission is disabled", () => {
    const gate = admissionGate();
    const h = harness(gate);
    holdReady(h, NOW);
    vi.advanceTimersByTime(HELD_PROMPT_MARGIN_MS);
    expect(h.sent).toEqual([{ type: "prompt", id: expect.any(String), message: "next step" }]);
    expect(h.record().heldPrompt).toMatchObject({ sentAtMs: null, error: null });
    expect(gate.admitPayload).toHaveBeenCalledWith(TAB, "next step");
  });
});
