import type { BackendState, ChannelTable, RequestHandlers } from "@omp-ui/core";

/**
 * The two contracts the other #1010 slices implement against `@omp-ui/host-lite`.
 * This file is THE seam: extend it, never break it. Runtime implementations are
 * injected through `startLiteInstance` options so this package compiles and its
 * handshake tests run before slices S2 (sessions) and S3 (keyed cipher) land.
 */

/**
 * Sealed-secret codec for the member's stored credentials (S3). A sealed value
 * is always ONE line including its own version tag, so it survives any file or
 * JSON round trip unchanged; rotation must keep decrypting old tags.
 */
export interface LiteKeyCipher {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

/**
 * The sessions half of the member backend (S2): everything about owned
 * sessions, live processes, and the full broadcast state. The host-lite core
 * owns `state:get` / `state:changed` fan-out around it: whatever `state()`
 * returns gets the registry's own project grouping and `modelFavorites`
 * merged over it, exactly as MainBackend builds its BackendState — so S2 may
 * fill `projects` from live summaries without owning registry membership.
 *
 * Handlers whose channel the host-lite core already owns (`state:get`,
 * `instance:identity`, `remote:*`) are silently shadowed by the core's own
 * handlers; never rely on overriding them here.
 */
export interface LiteSessions {
  /** Session/request channels the member exposes on top of the core table. */
  readonly handlers: Partial<RequestHandlers>;
  /**
   * Notify channels (pty/shell/rpc/tabViewed rails). Optional additive field
   * for S2 (#1010 session-bundle slice): lite-backend.ts merges it into the
   * table's notify half; a session slice without one ships request channels
   * only, and the transport ignores every notify channel.
   */
  readonly notify?: Partial<ChannelTable["notify"]>;
  /** Current full backend state for this member (before the registry merge). */
  state(): BackendState | Promise<BackendState>;
  /**
   * Fires every host event the joined owners must see — at minimum
   * `state:changed` whenever the state above changes. Returns the unsubscriber.
   */
  on(cb: (channel: string, args: unknown[]) => void): () => void;
  /** Stops processes and watchers; idempotent. */
  dispose(): Promise<void>;
}
