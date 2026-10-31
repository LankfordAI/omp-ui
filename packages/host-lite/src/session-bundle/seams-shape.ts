/**
 * LOCAL SEAM COPY — integration marker.
 *
 * The owning slice of issue #1010 declares the host-lite seams in
 * `packages/host-lite/src/seams.ts`, which may not exist on this branch yet.
 * This file is a type-only copy of the shapes `session-bundle` codes against;
 * when `src/seams.ts` lands, its declarations replace these and this file is
 * deleted in the integration commit. Everything here is erased at build time —
 * the esbuild bundle never imports it.
 */
import type { BackendState } from "@omp-ui/core";
import type { ChannelTable } from "@omp-ui/core";
import type { SessionManager } from "../../../desktop/src/main/session-manager";

/**
 * A partial {@link ChannelTable}: only the session channels a windowless host
 * can serve. The transports (`dispatchRequest`/`dispatchNotify`) reject an
 * absent request channel and ignore an absent notify channel, so omission is
 * the "absent not denied" posture (#449) — no denial handler needed.
 */
export type LiteChannelTable = {
  readonly request: Partial<ChannelTable["request"]>;
  readonly notify: Partial<ChannelTable["notify"]>;
};

/** One rebroadcast frame; mirrors `RemoteHost`'s sink signature (`addSink`). */
export type LiteEvent = (channel: string, args: unknown[]) => void;

/**
 * The windowless session cluster: the real `SessionManager`, the lite-servable
 * channel subset, the BackendState projection, and the event fan-out the
 * remote server rides. Shaped so `src/index.ts` can wrap it directly as a
 * `RemoteHost`: `handlers(): ChannelTable` (cast the partial table — absent
 * channels are the point) plus `addSink = bundle.on`.
 */
export interface LiteSessions {
  /** The subset of RequestHandlers/notify handlers lite registers. */
  readonly handlers: LiteChannelTable;
  /** The real desktop SessionManager behind the table (index slice may need its getters). */
  readonly sessions: SessionManager;
  /** The projects/modelFavorites-bearing BackendState core builds (issue #1010 slice). */
  state(): Promise<BackendState>;
  /** One broadcast event sink (state changes, session streams). Returns its unsubscribe. */
  on(cb: LiteEvent): () => void;
  /** Kill every live session process (SessionManager.killAll) and drop sinks. */
  dispose(): void;
}
