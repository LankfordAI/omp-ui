import { ipcMain, type BrowserWindow } from "electron";
import { dispatchNotify, dispatchRequest } from "@omp-ui/core";
import type { ConnectionContext } from "@omp-ui/server";
import { IPC_CONNECTION_ID, type HostApplication } from "@omp-ui/host";

/**
 * The desktop window's connection to the host over Electron IPC (issue #442):
 * the window is one client among the remote ones, bound to the same
 * per-connection table every transport dispatches into, and one event sink
 * among the remote ones. Nothing here knows what a channel means.
 */

/** Binds the host's table for `ctx` — what index.ts mints for the window — to ipcMain. Returns the unbind. */
export function bindBackendIpc(host: HostApplication, ctx: ConnectionContext): () => void {
  const table = host.handlers(ctx);
  const unbinds: Array<() => void> = [];
  for (const channel of Object.keys(table.request)) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => dispatchRequest(table, channel, args));
    unbinds.push(() => ipcMain.removeHandler(channel));
  }
  for (const channel of Object.keys(table.notify)) {
    const listener = (_event: unknown, ...args: unknown[]): void => {
      dispatchNotify(table, channel, args);
    };
    ipcMain.on(channel, listener);
    unbinds.push(() => ipcMain.removeListener(channel, listener));
  }
  unbinds.push(() => host.connectionClosed(ctx.id));
  return () => {
    for (const unbind of unbinds) unbind();
  };
}

/** The slice of the host the window sink needs; a test hands in a bare `addSink`. */
export interface WindowSinkHost {
  addSink: HostApplication["addSink"];
}

/**
 * Mirrors the host's events into the window's renderer: broadcasts, desktop-
 * role events, and what is addressed to the window's own connection id. The
 * guard lives here rather than in the host: on/after quit the webContents is
 * gone, and a crashed renderer is not "destroyed" — sending into it throws
 * "Render frame was disposed …" once per frame until the app is killed
 * (issue #183). Returns the unsubscribe.
 */
export function bindWindowSink(host: WindowSinkHost, win: BrowserWindow): () => void {
  let failureLastLog = 0;
  return host.addSink((scope, channel, args) => {
    const forWindow =
      scope.kind === "broadcast" ||
      (scope.kind === "role" && scope.role === "desktop") ||
      (scope.kind === "connection" && scope.id === IPC_CONNECTION_ID);
    if (!forWindow) return;
    if (win.isDestroyed()) return;
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) return;
    try {
      wc.send(channel, ...args);
    } catch (err) {
      // Rate-limited: a dead renderer must not spam the log.
      const now = Date.now();
      if (now - failureLastLog < 60_000) return;
      failureLastLog = now;
      console.warn(
        `[ipc-bridge] window sink send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
