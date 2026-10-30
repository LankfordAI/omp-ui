import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  HELD_PROMPT_COMMAND_PREFIX,
  HELD_PROMPT_MARGIN_MS,
  HELD_PROMPT_PREVIEW_MAX,
  LIMITS_STATUS_KEY,
  heldPromptCommandId,
  isObject,
  isUsageLimitError,
  normalizeControlFrame,
  parseLimits,
  usageResetMs,
  writeTextAtomic,
  type HeldPrompt,
  type HeldPromptPayload,
  type HeldPromptRequest,
  type LimitsView,
  type OwnedSessionRecord,
  type RpcFrame,
} from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

/** The lineage artifact holding the held prompt's wire text and images. */
export const HELD_PROMPT_ARTIFACT = "held-prompt.json";

/** Longest single wait: the SnoozeClock rule — Node timers stop while the machine sleeps. */
const MAX_WAIT_MS = 60_000;
/** At most one resume attempt per tab in this window, like a staged fleet wake. */
const RESUME_THROTTLE_MS = 60_000;

/** What the scheduler asks of the session manager and the registry. */
export interface HeldPromptSchedulerDeps {
  sessions: () => readonly OwnedSessionRecord[];
  updateSession: (tabId: string, patch: Pick<OwnedSessionRecord, "heldPrompt">) => unknown;
  broadcast: () => void;
  lineageDir: (record: OwnedSessionRecord) => string;
  /** True while the tab has a live native process that is not booting, held, mid-turn, or waiting on the user. */
  canSendNow: (tabId: string) => boolean;
  isLive: (tabId: string) => boolean;
  /** True while a spawn, hibernate, or other operation holds the tab. */
  busy: (tabId: string) => boolean;
  /** The normal prompt path (`rpcSend`), so observers and the model hold see it. */
  send: (tabId: string, cmd: RpcFrame) => void;
  resume: (tabId: string) => Promise<unknown>;
  /** The limits bridge's pull command, for a prompt whose reset is unknown. */
  refreshLimits: (tabId: string) => void;
}

interface Payload {
  id: string;
  text: string;
  images: HeldPromptPayload["images"];
}

/** Per-tab view of the live process, rebuilt on every spawn. */
interface TabState {
  limits: LimitsView | null;
  /** The last assistant message ended on omp's usage-limit class. */
  failedOnLimit: boolean;
  /** The held prompt's command is in flight on this process; its outcome is not known yet. */
  inFlight: string | null;
  /** The live process sent `ready`: commands sent now follow its handshake. */
  ready: boolean;
}

function isPayload(value: unknown): value is Payload {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    Array.isArray(value.images) &&
    value.images.every(
      (image) =>
        isObject(image) &&
        image.type === "image" &&
        typeof image.data === "string" &&
        typeof image.mimeType === "string",
    )
  );
}

/**
 * Send at reset (issue #986): the owning host keeps one held prompt per
 * native session and sends it once the provider's usage window resets.
 *
 * The record carries the card's view (`heldPrompt`), so it survives a
 * restart and reaches every joined client; the wire text and images ride
 * `held-prompt.json` in the lineage dir, never the broadcast. One timer
 * covers the earliest `sendAtMs`, re-read at least once a minute so a
 * deadline missed while the machine slept fires within a minute of resume.
 *
 * At the deadline a live, idle session gets the prompt through `rpcSend`; a
 * session that is not running is resumed and the prompt rides
 * `initialCommands`. The outcome is read from frames: a rejected command
 * waits for the user; an admitted prompt whose turn ends on omp's
 * usage-limit class re-arms on the next reported reset (with the failed
 * user message left in omp's history, as omp leaves any failed turn);
 * any other turn end consumes it.
 */
export class HeldPromptScheduler implements FrameObserver {
  private readonly tabs = new Map<string, TabState>();
  private readonly resumeAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly deps: HeldPromptSchedulerDeps) {}

  private state(tabId: string): TabState {
    let state = this.tabs.get(tabId);
    if (state === undefined) {
      state = { limits: null, failedOnLimit: false, inFlight: null, ready: false };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  private record(tabId: string): OwnedSessionRecord | undefined {
    return this.deps.sessions().find((s) => s.tabId === tabId);
  }

  private artifact(record: OwnedSessionRecord): string {
    return path.join(this.deps.lineageDir(record), HELD_PROMPT_ARTIFACT);
  }

  private readPayload(record: OwnedSessionRecord): Payload | null {
    const held = record.heldPrompt;
    if (held === null) return null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.artifact(record), "utf8"));
      return isPayload(parsed) && parsed.id === held.id ? parsed : null;
    } catch {
      return null;
    }
  }

  private patch(tabId: string, heldPrompt: HeldPrompt | null): void {
    this.deps.updateSession(tabId, { heldPrompt });
    this.deps.broadcast();
  }

  /** Drops the held prompt and its artifact. */
  private clear(record: OwnedSessionRecord): void {
    fs.rmSync(this.artifact(record), { force: true });
    const state = this.tabs.get(record.tabId);
    if (state !== undefined) state.inFlight = null;
    this.patch(record.tabId, null);
  }

  /** Holds a prompt for `tabId`, replacing any already held. */
  hold(tabId: string, req: HeldPromptRequest): void {
    const record = this.record(tabId);
    if (record === undefined) throw new Error(`unknown session tab ${tabId}`);
    if (record.mode !== "rpc-ui") throw new Error("only a native session can hold a prompt");
    if (record.heldPrompt?.sentAtMs != null) throw new Error("the held prompt was already sent; wait for its turn to end");
    if (req.text.trim() === "" && req.images.length === 0) throw new Error("the prompt is empty");
    for (const doc of req.documents) {
      if (!fs.existsSync(doc)) throw new Error(`document not found: ${doc}`);
    }
    const id = randomUUID();
    const payload: Payload = { id, text: req.text, images: req.images };
    writeTextAtomic(this.artifact(record), JSON.stringify(payload));
    const now = Date.now();
    this.patch(tabId, {
      id,
      preview:
        req.preview.length <= HELD_PROMPT_PREVIEW_MAX
          ? req.preview
          : `${req.preview.slice(0, HELD_PROMPT_PREVIEW_MAX - 1)}…`,
      imageCount: req.images.length,
      documentCount: req.documents.length,
      createdAtMs: now,
      sendAtMs: Number.isFinite(req.resetAtMs) ? Math.max(req.resetAtMs, now) + HELD_PROMPT_MARGIN_MS : null,
      sentAtMs: null,
      attempts: 0,
      error: null,
    });
    this.sync();
  }

  /** Drops the held prompt and returns it for the draft; null when nothing was held. */
  cancel(tabId: string): HeldPromptPayload | null {
    const record = this.record(tabId);
    if (record?.heldPrompt == null) return null;
    if (record.heldPrompt.sentAtMs !== null) throw new Error("the held prompt was already sent; wait for its turn to end");
    const payload = this.readPayload(record);
    this.clear(record);
    this.sync();
    return payload === null ? null : { text: payload.text, images: payload.images };
  }

  /** Sends the held prompt as soon as the session can take it. */
  sendNow(tabId: string): void {
    const record = this.record(tabId);
    if (record?.heldPrompt == null || record.heldPrompt.sentAtMs !== null) return;
    this.resumeAt.delete(tabId);
    this.patch(tabId, { ...record.heldPrompt, sendAtMs: Date.now(), error: null });
    this.sync();
  }

  /**
   * The spawn's initialCommands entry for a held prompt that is due: the
   * resumed process sends it after the bridges arm, before any user input.
   */
  initialCommand(record: OwnedSessionRecord, modelHeld: boolean): RpcFrame | null {
    const held = record.heldPrompt;
    if (held === null || held.sentAtMs !== null || held.sendAtMs === null || held.sendAtMs > Date.now() || modelHeld)
      return null;
    const payload = this.readPayload(record);
    if (payload === null) return null;
    this.state(record.tabId).inFlight = held.id;
    return this.command(payload);
  }

  private command(payload: Payload): RpcFrame {
    return {
      type: "prompt",
      id: heldPromptCommandId(payload.id),
      message: payload.text,
      ...(payload.images.length > 0 ? { images: payload.images } : {}),
    };
  }

  /** Fires every due prompt the session can take now, then re-arms for the next deadline. */
  sync(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    let next: number | null = null;
    // A copy: clearing a record rewrites the registry's array mid-loop.
    for (const record of [...this.deps.sessions()]) {
      const held = record.heldPrompt;
      if (held === null || record.mode !== "rpc-ui") continue;
      if (held.sentAtMs !== null) {
        // Admitted by a process that is gone (an app crash mid-turn): omp
        // holds the prompt in the transcript, so it is never sent twice.
        if (!this.deps.isLive(record.tabId)) this.clear(record);
        continue;
      }
      if (held.sendAtMs === null) continue;
      if (held.sendAtMs > now) {
        next = next === null ? held.sendAtMs : Math.min(next, held.sendAtMs);
        continue;
      }
      if (!this.fire(record, held, now)) next = next === null ? now + MAX_WAIT_MS : Math.min(next, now + MAX_WAIT_MS);
    }
    if (next !== null) this.timer = setTimeout(() => this.sync(), Math.max(0, Math.min(next - now, MAX_WAIT_MS)));
  }

  /** One due prompt. False when the session cannot take it yet and the sync should retry. */
  private fire(record: OwnedSessionRecord, held: HeldPrompt, now: number): boolean {
    const tabId = record.tabId;
    const state = this.state(tabId);
    // In flight on a live or starting process: its ack decides. A spawn that
    // died before it went live leaves the latch behind, dropped here.
    if (state.inFlight === held.id && (this.deps.isLive(tabId) || this.deps.busy(tabId))) return true;
    state.inFlight = null;
    if (this.deps.isLive(tabId)) {
      if (!state.ready || !this.deps.canSendNow(tabId)) return false;
      const payload = this.readPayload(record);
      if (payload === null) {
        this.patch(tabId, { ...held, sendAtMs: null, error: "the held prompt's saved text is missing" });
        return true;
      }
      state.inFlight = held.id;
      this.deps.send(tabId, this.command(payload));
      return true;
    }
    if (this.deps.busy(tabId)) return false;
    const last = this.resumeAt.get(tabId) ?? 0;
    if (now - last < RESUME_THROTTLE_MS) return false;
    this.resumeAt.set(tabId, now);
    void this.deps.resume(tabId).catch((err: unknown) => {
      console.warn(`[held-prompt] ${tabId}: resume for a held prompt failed:`, err);
    });
    return false;
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    const control = normalizeControlFrame(frame);
    const state = this.state(tabId);
    if (control?.kind === "response" && typeof control.id === "string") {
      if (control.id.startsWith(HELD_PROMPT_COMMAND_PREFIX)) this.onAck(tabId, control.id, control.success === true, control.error);
      return;
    }
    if (
      control?.kind === "ext_request" &&
      control.method === "setStatus" &&
      control.frame.statusKey === LIMITS_STATUS_KEY
    ) {
      const limits = parseLimits(typeof control.frame.statusText === "string" ? control.frame.statusText : undefined);
      if (limits === null) return;
      state.limits = limits;
      this.armFromLimits(tabId);
      return;
    }
    if (control?.kind === "ready") {
      state.ready = true;
      // A prompt that fell due while the process booted goes out now.
      this.sync();
      return;
    }
    if (frame.type === "agent_start") {
      state.failedOnLimit = false;
      return;
    }
    if (frame.type === "message_end") {
      const message = isObject(frame.message) ? frame.message : null;
      if (message?.role === "assistant") state.failedOnLimit = isUsageLimitError(message.stopReason, message.errorId);
      return;
    }
    if (frame.type === "agent_end" && frame.isTerminal !== false) this.onTurnEnd(tabId, state);
  }

  private onAck(tabId: string, commandId: string, ok: boolean, error: unknown): void {
    const record = this.record(tabId);
    const held = record?.heldPrompt ?? null;
    if (record === undefined || held === null || heldPromptCommandId(held.id) !== commandId) return;
    this.state(tabId).inFlight = null;
    if (ok) {
      this.patch(tabId, { ...held, sendAtMs: null, sentAtMs: Date.now() });
      return;
    }
    const reason = typeof error === "string" && error !== "" ? error : "omp rejected the prompt";
    this.patch(tabId, { ...held, sendAtMs: null, error: reason });
  }

  /** The admitted prompt's turn ended: consumed, or re-armed when it failed on the limit again. */
  private onTurnEnd(tabId: string, state: TabState): void {
    const record = this.record(tabId);
    const held = record?.heldPrompt ?? null;
    if (record === undefined || held === null || held.sentAtMs === null) {
      // A turn that just ended leaves the session idle: a due prompt that
      // waited for it can go out now.
      this.sync();
      return;
    }
    if (!state.failedOnLimit) {
      this.clear(record);
      this.sync();
      return;
    }
    this.patch(tabId, { ...held, sendAtMs: null, sentAtMs: null, attempts: held.attempts + 1, error: null });
    // The turn's end re-probes usage only past the bridge's cooldown; pull
    // a fresh snapshot so the next reset is known now.
    this.deps.refreshLimits(tabId);
    this.armFromLimits(tabId);
  }

  /** A held prompt waiting for a reported reset takes the session's current one. */
  private armFromLimits(tabId: string): void {
    const record = this.record(tabId);
    const held = record?.heldPrompt ?? null;
    const state = this.tabs.get(tabId);
    if (held === null || held.sendAtMs !== null || held.sentAtMs !== null || held.error !== null || state === undefined)
      return;
    const reset = usageResetMs(state.limits, true, Date.now());
    if (reset === null) return;
    this.patch(tabId, { ...held, sendAtMs: reset + HELD_PROMPT_MARGIN_MS });
    this.sync();
  }

  onExit(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (state !== undefined) {
      // A command in flight on the dead process is re-sent by the next
      // spawn's initialCommands while the record still holds it unsent.
      state.inFlight = null;
      state.failedOnLimit = false;
      state.limits = null;
      state.ready = false;
    }
    // An admitted prompt whose process died mid-turn is in omp's transcript.
    const record = this.record(tabId);
    if (record?.heldPrompt != null && record.heldPrompt.sentAtMs !== null) this.clear(record);
  }

  dispose(tabId: string): void {
    this.tabs.delete(tabId);
    this.resumeAt.delete(tabId);
  }

  disposeAll(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.tabs.clear();
  }
}
