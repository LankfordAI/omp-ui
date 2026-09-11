import type { RpcFrame } from "@omp-ui/core";
import type { LiveEntry } from "./live-entry";

/**
 * A per-concern observer over one tab's rpc traffic (issue #297). The manager
 * dispatches in array order before any renderer fan-out, and each observer
 * owns its per-tab state end to end: `onExit` when the live process dies,
 * `dispose` when the tab leaves the manager entirely (delete, quit).
 */
export interface FrameObserver {
  /** One rpc frame arrived. Runs before the renderer fan-out. */
  onFrame(tabId: string, frame: RpcFrame, entry: LiveEntry): void;
  /** A renderer command is about to be forwarded to the child. */
  onSend?(tabId: string, cmd: RpcFrame): void;
  /** The tab's live process exited; a successor may follow under the same tab. */
  onExit(tabId: string): void;
  /** The tab left the manager entirely (delete, quit). */
  dispose(tabId: string): void;
}
