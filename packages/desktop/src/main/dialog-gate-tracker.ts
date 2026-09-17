import {
  isBlockingDialogMethod,
  normalizeControlFrame,
  parsePlanReviewTitle,
  type RpcFrame,
} from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

/**
 * The open blocking-dialog frames per tab, in arrival order (issue #555).
 * The main-process record of "what question is this session blocked on",
 * mirrored from `PlanGateTracker`: the manager publishes it on the session
 * summary so every viewer reconciles against one owner instead of keeping a
 * renderer-local queue that drifts the moment a sibling answers.
 *
 * It replaces the per-tab dialog-id set the hibernation tracker used to
 * keep, rather than living beside it — one copy of the fact, the way
 * `extension-dialog.ts` documents after its two-copies-drifted lesson. No
 * self-broadcast: the manager's `publishAnswerEdge` already sees the
 * `pendingAnswer` flip and publishes the rebuild through the watcher hub's
 * throttle.
 */
export class DialogGateTracker implements FrameObserver {
  private readonly open = new Map<string, Map<string, RpcFrame>>();

  onFrame(tabId: string, frame: RpcFrame): void {
    const control = normalizeControlFrame(frame);
    if (control?.kind !== "ext_request" || typeof control.id !== "string") return;
    if (!isBlockingDialogMethod(control.method)) return;
    const title = typeof frame.title === "string" ? frame.title : undefined;
    // A plan proposal is a select frame: its gate owns it, never the dialog
    // queue — the exact guard the renderer applies at frame-reduction time,
    // so main and the transcript never disagree about who owns the frame.
    if (title !== undefined && parsePlanReviewTitle(title) !== null) return;
    let byId = this.open.get(tabId);
    if (byId === undefined) {
      byId = new Map();
      this.open.set(tabId, byId);
    }
    byId.set(control.id, frame);
  }

  onSend(tabId: string, cmd: RpcFrame): void {
    // Answers are commands (rpcSend), not frames: this is where a settled
    // dialog leaves the list. A double answer from a lagging client is a
    // no-op delete here; the next broadcast corrects that client's queue.
    const control = normalizeControlFrame(cmd);
    if (control?.kind === "ext_response" && typeof control.id === "string")
      this.open.get(tabId)?.delete(control.id);
  }

  onExit(tabId: string): void {
    this.open.delete(tabId);
  }

  dispose(tabId: string): void {
    this.open.delete(tabId);
  }

  /** True while the tab holds at least one unanswered blocking dialog. */
  hasOpen(tabId: string): boolean {
    return (this.open.get(tabId)?.size ?? 0) > 0;
  }

  /** The open dialog frames in arrival order; empty when none. */
  openFrames(tabId: string): RpcFrame[] {
    const byId = this.open.get(tabId);
    return byId === undefined ? [] : [...byId.values()];
  }
}
