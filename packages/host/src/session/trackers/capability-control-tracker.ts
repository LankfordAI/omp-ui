import {
  capabilityToolMutationMessage,
  normalizeControlFrame,
  type CapabilitySnapshot,
  type CapabilityToolMutationRequest,
  type Registry,
  type RpcFrame,
  type SetSessionToolEnabledResult,
  type FrameObserver,
} from "@omp-ui/core";
import type { LiveEntry } from "../live-entry";

/**
 * One in-flight tool enable/disable for one tab. The manager guarantees at most
 * one per tab: the request is refused as `busy` before it is registered.
 */
interface PendingMutation {
  /** The exact payload sent to the bridge; its id is the correlation key. */
  readonly request: CapabilityToolMutationRequest;
  /**
   * The live session this request was addressed to. Identity — the object, not
   * its tabId — so a dead predecessor's publish can never settle a successor.
   */
  readonly entry: LiveEntry;
  readonly resolve: (result: SetSessionToolEnabledResult) => void;
  /** The hidden prompt's rpc id, captured from `onSend`; null until it leaves. */
  commandId: string | null;
  /** The deadline timer, owned by the record and cleared on any settle. */
  timer: NodeJS.Timeout | undefined;
}

export interface CapabilityControlTrackerDeps {
  registry: Registry;
  getLive: (tabId: string) => LiveEntry | undefined;
}

/**
 * The session-local tool toggle's wait (issue #379): one deliberate
 * enable/disable of one registered tool in one pinned live session, settled by
 * the capabilities bridge's own published snapshot — never by our optimism.
 *
 * This is deliberately not an rpc layer: there is no retry, no queue, and no
 * generic request table. The bridge's snapshot is the authoritative record, so
 * the only evidence accepted is a correlated completion on a snapshot from the
 * very live session that was asked, plus the Tools roster agreeing with it.
 */
export class CapabilityControlTracker implements FrameObserver<LiveEntry> {
  private readonly pending = new Map<string, PendingMutation>();

  constructor(private readonly deps: CapabilityControlTrackerDeps) {}

  /** True while a tab has a mutation awaiting its correlated completion. */
  isPending(tabId: string): boolean {
    return this.pending.has(tabId);
  }

  /**
   * Registers the wait BEFORE the caller sends the frame, so a completion that
   * lands in the same tick can already settle it. The deadline is the request's
   * own `expiresAt` — the runtime refuses the mutation after that instant, so a
   * second local clock would only let the two disagree.
   */
  track(
    tabId: string,
    request: CapabilityToolMutationRequest,
    entry: LiveEntry,
    resolve: (result: SetSessionToolEnabledResult) => void,
  ): void {
    // Unreachable through the manager (it refuses a second mutation as busy);
    // settling rather than dropping keeps a caller's promise never left hanging.
    if (this.pending.has(tabId)) this.settle(tabId, { status: "busy" });
    const record: PendingMutation = { request, entry, resolve, commandId: null, timer: undefined };
    const delay = Math.max(0, request.expiresAt - Date.now());
    const timer = setTimeout(() => {
      record.timer = undefined;
      if (this.pending.get(tabId) !== record) return;
      // No correlated completion in time: the change may have landed, and that
      // is exactly why this is not reported as success. Late snapshots still
      // reach the renderers through the normal roster fan-out.
      this.settle(tabId, { status: "unconfirmed" });
    }, delay);
    // Unref'd: a pending toggle must never hold the main process open on quit.
    if (typeof timer.unref === "function") timer.unref();
    record.timer = timer;
    this.pending.set(tabId, record);
  }

  /**
   * A parsed capability snapshot arrived for `tabId` from `entry`. Called by the
   * manager only after the parse succeeded and the live-entry identity check
   * passed, so a malformed or predecessor roster never reaches here.
   */
  observe(tabId: string, snapshot: CapabilitySnapshot, entry: LiveEntry): void {
    const record = this.pending.get(tabId);
    if (record === undefined) return;
    if (record.entry !== entry) return;
    const mutation = snapshot.toolMutation;
    if (mutation === null) return;
    const { request } = record;
    if (mutation.id !== request.id) return;
    if (mutation.name !== request.name || mutation.enabled !== request.enabled) return;
    if (snapshot.processKey !== request.processKey || snapshot.sessionId !== request.sessionId) {
      return;
    }
    if (mutation.status !== "applied") {
      this.settle(tabId, { status: mutation.status });
      return;
    }
    // The bridge's word alone is not success: `applied` additionally requires
    // the published Tools roster to carry the requested row with the requested
    // membership. An ack that the roster contradicts keeps waiting, so the
    // outcome lands as `unconfirmed` rather than a lie.
    if (!confirmsMembership(snapshot, request)) return;
    this.settle(tabId, { status: "applied", snapshot });
  }

  onFrame(tabId: string, frame: RpcFrame, entry: LiveEntry): void {
    const record = this.pending.get(tabId);
    if (record === undefined || record.entry !== entry) return;
    if (record.commandId === null) return;
    const control = normalizeControlFrame(frame);
    // A prompt the runtime refuses outright never runs its handler, so no
    // completion will ever be published for it: fail now, not at the deadline.
    // A successful response proves nothing — it is an echo of the queue, not of
    // the mutation — and must never settle.
    if (control === null || control.kind !== "response") return;
    if (control.id !== record.commandId) return;
    if (control.success === false) this.settle(tabId, { status: "apply-failed" });
  }

  onSend(tabId: string, cmd: RpcFrame): void {
    const record = this.pending.get(tabId);
    if (record === undefined || record.commandId !== null) return;
    // Remember our own hidden prompt's rpc id: the only way to tell its
    // response frame apart from the user's prompt traffic.
    if (cmd.type !== "prompt" || typeof cmd.id !== "string") return;
    if (cmd.message !== capabilityToolMutationMessage(record.request)) return;
    record.commandId = cmd.id;
  }

  onExit(tabId: string): void {
    const record = this.pending.get(tabId);
    if (record === undefined) return;
    // The process the request targeted is gone and is never retried or
    // redirected. A registry record left behind means a successor took the tab
    // (restart, relaunch) — that reads as `stale`; with no record at all the
    // session simply stopped being live.
    const owned = this.deps.registry.sessions.some((session) => session.tabId === tabId);
    this.settle(tabId, { status: owned ? "stale" : "not-live" });
  }

  dispose(tabId: string): void {
    this.onExit(tabId);
  }

  /** For killAll: no wait may outlive the app. */
  disposeAll(): void {
    for (const tabId of [...this.pending.keys()]) {
      const record = this.pending.get(tabId);
      if (record === undefined) continue;
      this.clearTimer(record);
      this.pending.delete(tabId);
      record.resolve({ status: "not-live" });
    }
  }

  private settle(tabId: string, result: SetSessionToolEnabledResult): void {
    const record = this.pending.get(tabId);
    if (record === undefined) return;
    this.pending.delete(tabId);
    this.clearTimer(record);
    record.resolve(result);
  }

  private clearTimer(record: PendingMutation): void {
    if (record.timer === undefined) return;
    clearTimeout(record.timer);
    record.timer = undefined;
  }
}

/** True when the published Tools roster shows the requested row as requested. */
function confirmsMembership(
  snapshot: CapabilitySnapshot,
  request: CapabilityToolMutationRequest,
): boolean {
  if (snapshot.tools.status !== "available") return false;
  return snapshot.tools.items.some(
    (tool) => tool.name === request.name && tool.enabled === request.enabled,
  );
}
