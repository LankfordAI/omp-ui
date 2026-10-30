import { randomUUID } from "node:crypto";
import {
  SCHEDULED_PROMPT_COMMAND_PREFIX,
  SCHEDULED_PROMPT_LATE_MS,
  SCHEDULED_PROMPT_NOTICES_MAX,
  countRunsBetween,
  nextRunAfter,
  normalizeControlFrame,
  planMessage,
  scheduledPromptCommandId,
  type OwnedSessionRecord,
  type RpcFrame,
  type ScheduledPrompt,
  type ScheduledPromptNotice,
  type ScheduledPromptRequest,
} from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

/** Longest single wait: the SnoozeClock rule — Node timers stop while the machine sleeps. */
const MAX_WAIT_MS = 60_000;
/** At most one resume attempt per tab in this window, like a staged fleet wake. */
const RESUME_THROTTLE_MS = 60_000;

type RecordPatch = Partial<Pick<OwnedSessionRecord, "scheduledPrompt" | "snoozed" | "snoozedUntilMs">>;

/** What the runner asks of the session manager and the registry. */
export interface ScheduledPromptRunnerDeps {
  sessions: () => readonly OwnedSessionRecord[];
  updateSession: (tabId: string, patch: RecordPatch) => unknown;
  broadcast: () => void;
  isLive: (tabId: string) => boolean;
  /** True while a spawn, hibernate, or other operation holds the tab. */
  busy: (tabId: string) => boolean;
  /** A turn is running, or the session waits on the user (plan review, dialog). */
  inRun: (tabId: string) => boolean;
  /** The live native process can take a command now (not model-held, no pending operation). */
  canSendNow: (tabId: string) => boolean;
  /** True while the live process carries omp-ui's plan bridge. */
  planBridgeLoaded: (tabId: string) => boolean;
  /** The normal prompt path (`rpcSend`). */
  send: (tabId: string, cmd: RpcFrame) => void;
  /** Resumes the session in Build; the due prompt rides `initialCommands`. */
  resume: (tabId: string) => Promise<unknown>;
}

/** The fire in flight on a tab's process: its command id and occurrence. */
interface InFlight {
  commandId: string;
  dueAtMs: number;
  scheduleId: string;
}

/**
 * Scheduled prompts (issue #987, ADR-0081): the owning host keeps at most one
 * schedule per native session on its record and fires it at each occurrence
 * through the normal prompt path, in Build mode.
 *
 * One timer covers the earliest `nextRunAtMs`, re-read at least once a minute
 * so a fire missed while the machine slept or the app was closed goes out
 * within a minute of resume — once, with a `late` notice counting the
 * occurrences it folded. A run still in progress at a fire time skips that
 * fire with a `skipped` notice instead of queuing a second prompt.
 *
 * `nextRunAtMs` advances the moment a fire goes out, so an occurrence is sent
 * at most once: a process that dies before omp admits it records a `failed`
 * notice and never re-sends. A one-shot is removed once omp admits it.
 */
export class ScheduledPromptRunner implements FrameObserver {
  private readonly inFlight = new Map<string, InFlight>();
  /** Tabs whose live process has sent `ready`. */
  private readonly ready = new Set<string>();
  private readonly resumeAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly deps: ScheduledPromptRunnerDeps) {}

  private record(tabId: string): OwnedSessionRecord | undefined {
    return this.deps.sessions().find((s) => s.tabId === tabId);
  }

  private patch(tabId: string, patch: RecordPatch): void {
    this.deps.updateSession(tabId, patch);
    this.deps.broadcast();
  }

  private withNotice(scheduled: ScheduledPrompt, notice: Omit<ScheduledPromptNotice, "atMs">): ScheduledPromptNotice[] {
    return [{ ...notice, atMs: Date.now() }, ...scheduled.notices].slice(0, SCHEDULED_PROMPT_NOTICES_MAX);
  }

  /** Attaches a schedule to `tabId`, replacing any it had. */
  set(tabId: string, req: ScheduledPromptRequest): void {
    const record = this.record(tabId);
    if (record === undefined) throw new Error(`unknown session tab ${tabId}`);
    if (record.mode !== "rpc-ui") throw new Error("only a native session can run a scheduled prompt");
    const now = Date.now();
    const nextRunAtMs = nextRunAfter(req.schedule, req.timeZone, now);
    if (nextRunAtMs === null) throw new Error("the schedule never fires after now");
    this.inFlight.delete(tabId);
    this.patch(tabId, {
      scheduledPrompt: {
        id: randomUUID(),
        text: req.text,
        schedule: req.schedule,
        timeZone: req.timeZone,
        createdAtMs: now,
        nextRunAtMs,
        lastRunAtMs: null,
        notices: [],
      },
    });
    this.sync();
  }

  clear(tabId: string): void {
    const record = this.record(tabId);
    if (record?.scheduledPrompt == null) return;
    this.inFlight.delete(tabId);
    this.patch(tabId, { scheduledPrompt: null });
    this.sync();
  }

  /**
   * Fires the prompt as soon as the session can take it. A recurring
   * schedule's extra run leaves its next occurrence where it was.
   */
  runNow(tabId: string): void {
    const record = this.record(tabId);
    const scheduled = record?.scheduledPrompt ?? null;
    if (record === undefined || scheduled === null) return;
    if (this.deps.isLive(tabId) && this.deps.inRun(tabId)) throw new Error("the session is in a run; wait for it to end");
    const now = Date.now();
    this.resumeAt.delete(tabId);
    if (this.deps.isLive(tabId)) {
      if (!this.ready.has(tabId) || !this.deps.canSendNow(tabId)) throw new Error("the session cannot take a prompt yet");
      this.dispatch(record, scheduled, now, scheduled.nextRunAtMs ?? now, false);
      return;
    }
    // Make it due now; the occurrence it displaced is re-armed after the fire.
    this.patch(tabId, { scheduledPrompt: { ...scheduled, nextRunAtMs: now } });
    this.sync();
  }

  /**
   * The spawn's `initialCommands` for a prompt that is due: the resumed
   * process sends them after the bridges arm, before any user input. A
   * spawn that boots in plan mode (a user resume) leaves it first.
   */
  initialCommands(record: OwnedSessionRecord, modelHeld: boolean, bootsInPlan: boolean): RpcFrame[] {
    const scheduled = record.scheduledPrompt;
    const now = Date.now();
    if (scheduled === null || scheduled.nextRunAtMs === null || scheduled.nextRunAtMs > now || modelHeld) return [];
    const prompt = this.advance(record, scheduled, now, scheduled.nextRunAtMs, true);
    return bootsInPlan ? [this.buildCommand(), prompt] : [prompt];
  }

  private buildCommand(): RpcFrame {
    return { type: "prompt", id: `omp-ui-scheduled-build-${randomUUID()}`, message: planMessage(false, "html") };
  }

  /** Fires every due schedule the session can take now, then re-arms for the next occurrence. */
  sync(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    let next: number | null = null;
    const wake = (at: number): void => {
      next = next === null ? at : Math.min(next, at);
    };
    // A copy: a fire rewrites the registry's array mid-loop.
    for (const record of [...this.deps.sessions()]) {
      const scheduled = record.scheduledPrompt;
      if (scheduled === null || scheduled.nextRunAtMs === null || record.mode !== "rpc-ui") continue;
      if (scheduled.nextRunAtMs > now) {
        wake(scheduled.nextRunAtMs);
        continue;
      }
      if (!this.fire(record, scheduled, now)) wake(now + MAX_WAIT_MS);
      else {
        const after = this.record(record.tabId)?.scheduledPrompt?.nextRunAtMs ?? null;
        if (after !== null) wake(after);
      }
    }
    if (next !== null) this.timer = setTimeout(() => this.sync(), Math.max(0, Math.min(next - now, MAX_WAIT_MS)));
  }

  /** One due schedule. False when the session cannot take it yet and the sync should retry. */
  private fire(record: OwnedSessionRecord, scheduled: ScheduledPrompt, now: number): boolean {
    const tabId = record.tabId;
    const due = scheduled.nextRunAtMs!;
    if (this.deps.isLive(tabId)) {
      if (this.deps.inRun(tabId)) {
        // Never a second prompt behind a run in progress: skip this fire.
        const nextRunAtMs = nextRunAfter(scheduled.schedule, scheduled.timeZone, now);
        this.patch(tabId, {
          scheduledPrompt: {
            ...scheduled,
            nextRunAtMs: scheduled.schedule.kind === "once" ? null : nextRunAtMs,
            notices: this.withNotice(scheduled, {
              kind: "skipped",
              dueAtMs: due,
              missed: countRunsBetween(scheduled.schedule, scheduled.timeZone, due, now),
              error: null,
            }),
          },
        });
        return true;
      }
      if (!this.ready.has(tabId) || !this.deps.canSendNow(tabId)) return false;
      this.dispatch(record, scheduled, now, due, true);
      return true;
    }
    if (this.deps.busy(tabId)) return false;
    const last = this.resumeAt.get(tabId) ?? 0;
    if (now - last < RESUME_THROTTLE_MS) return false;
    this.resumeAt.set(tabId, now);
    void this.deps.resume(tabId).catch((err: unknown) => {
      console.warn(`[scheduled-prompt] ${tabId}: resume for a scheduled prompt failed:`, err);
      const current = this.record(tabId)?.scheduledPrompt ?? null;
      if (current === null || current.id !== scheduled.id) return;
      this.patch(tabId, {
        scheduledPrompt: {
          ...current,
          notices: this.withNotice(current, {
            kind: "failed",
            dueAtMs: due,
            missed: 0,
            error: err instanceof Error ? err.message : String(err),
          }),
        },
      });
    });
    return false;
  }

  /** Sends a fire on a live process: Build first, then the prompt. */
  private dispatch(record: OwnedSessionRecord, scheduled: ScheduledPrompt, now: number, due: number, onSchedule: boolean): void {
    const tabId = record.tabId;
    if (record.agentMode === "plan" && this.deps.planBridgeLoaded(tabId)) this.deps.send(tabId, this.buildCommand());
    this.deps.send(tabId, this.advance(record, scheduled, now, due, onSchedule));
  }

  /**
   * Builds a fire's command and advances the record past it before it goes
   * out, so the occurrence is never sent twice. A late fire folds every
   * occurrence it missed into one `late` notice. A snoozed session leaves
   * Snoozed as its run starts.
   */
  private advance(record: OwnedSessionRecord, scheduled: ScheduledPrompt, now: number, due: number, onSchedule: boolean): RpcFrame {
    const late = onSchedule && now - due > SCHEDULED_PROMPT_LATE_MS;
    const nextRunAtMs = !onSchedule
      ? scheduled.nextRunAtMs
      : scheduled.schedule.kind === "once"
        ? null
        : nextRunAfter(scheduled.schedule, scheduled.timeZone, now);
    const commandId = scheduledPromptCommandId(scheduled.id, due);
    this.inFlight.set(record.tabId, { commandId, dueAtMs: due, scheduleId: scheduled.id });
    this.deps.updateSession(record.tabId, {
      scheduledPrompt: {
        ...scheduled,
        nextRunAtMs,
        notices: late
          ? this.withNotice(scheduled, {
              kind: "late",
              dueAtMs: due,
              missed: countRunsBetween(scheduled.schedule, scheduled.timeZone, due, now),
              error: null,
            })
          : scheduled.notices,
      },
      ...(record.snoozed ? { snoozed: false, snoozedUntilMs: null } : {}),
    });
    this.deps.broadcast();
    return { type: "prompt", id: commandId, message: scheduled.text };
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    const control = normalizeControlFrame(frame);
    if (control?.kind === "ready") {
      this.ready.add(tabId);
      // A fire that fell due while the process booted goes out now.
      this.sync();
      return;
    }
    if (control?.kind === "response" && typeof control.id === "string") {
      if (control.id.startsWith(SCHEDULED_PROMPT_COMMAND_PREFIX)) this.onAck(tabId, control.id, control.success === true, control.error);
      return;
    }
    // A run that just ended leaves the session idle: a due fire that waited can go out.
    if (frame.type === "agent_end" && frame.isTerminal !== false) this.sync();
  }

  private onAck(tabId: string, commandId: string, ok: boolean, error: unknown): void {
    const flight = this.inFlight.get(tabId);
    if (flight === undefined || flight.commandId !== commandId) return;
    this.inFlight.delete(tabId);
    const scheduled = this.record(tabId)?.scheduledPrompt ?? null;
    if (scheduled === null || scheduled.id !== flight.scheduleId) return;
    if (ok) {
      // A one-shot that ran is done; a recurring one keeps its next run.
      this.patch(
        tabId,
        scheduled.schedule.kind === "once" && scheduled.nextRunAtMs === null
          ? { scheduledPrompt: null }
          : { scheduledPrompt: { ...scheduled, lastRunAtMs: Date.now() } },
      );
      return;
    }
    const reason = typeof error === "string" && error !== "" ? error : "omp rejected the prompt";
    this.patch(tabId, {
      scheduledPrompt: {
        ...scheduled,
        notices: this.withNotice(scheduled, { kind: "failed", dueAtMs: flight.dueAtMs, missed: 0, error: reason }),
      },
    });
  }

  onExit(tabId: string): void {
    this.ready.delete(tabId);
    const flight = this.inFlight.get(tabId);
    if (flight === undefined) return;
    this.inFlight.delete(tabId);
    // Never re-sent: omp may already hold the prompt.
    const scheduled = this.record(tabId)?.scheduledPrompt ?? null;
    if (scheduled === null || scheduled.id !== flight.scheduleId) return;
    this.patch(tabId, {
      scheduledPrompt: {
        ...scheduled,
        notices: this.withNotice(scheduled, {
          kind: "failed",
          dueAtMs: flight.dueAtMs,
          missed: 0,
          error: "the session exited before omp admitted the prompt",
        }),
      },
    });
  }

  dispose(tabId: string): void {
    this.inFlight.delete(tabId);
    this.ready.delete(tabId);
    this.resumeAt.delete(tabId);
  }

  disposeAll(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.inFlight.clear();
    this.ready.clear();
  }
}
