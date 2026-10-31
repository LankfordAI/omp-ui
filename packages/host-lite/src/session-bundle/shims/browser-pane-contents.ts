/**
 * Shim for `packages/desktop/src/main/browser-pane-contents.ts` — the ONE
 * module in the session cluster's transitive graph with a runtime Electron
 * import (`BrowserWindow`, `session`, `webContents`). The bundle maps that
 * specifier here (see scripts/bundle-session.mjs); no desktop file is edited.
 *
 * Every consumer reaches this module through an injected seam or a guarded
 * dynamic import in `browser-pane-host.ts`:
 * - `makeElectronPaneFactory` is only called by the host's `factory()` when no
 *   `createPane` dep was injected — lite must inject one, or never call any
 *   browser-pane channel (they are absent from lite's ChannelTable).
 * - `clearBrowserPanePartition` is only called by the host's default
 *   `clearPartition` — lite overrides that seam in entry.ts.
 *
 * So these exports exist to make the bundle resolve and to fail loudly if a
 * windowless host ever lets a pane path through: creating a WebContents with
 * no Chromium is physically impossible, hence the throw.
 */
import type {
  CreatePane,
  PaneContents,
} from "../../../../desktop/src/main/browser-pane-contents";

const NO_WINDOW = "browser panes need a windowed host: this lite instance runs headless";

/** Inert pane factory: resolves nothing, refuses on first pane creation.
 *  (Zero-parameter by design — a shorter signature is assignable to the
 *  desktop's `CreatePane`/factory types, and lint bans unused underscore args.) */
export function makeElectronPaneFactory(): CreatePane {
  return async (): Promise<PaneContents> => {
    throw new Error(NO_WINDOW);
  };
}

/** No Electron session partitions exist headless: there is nothing to clear. */
export async function clearBrowserPanePartition(): Promise<void> {
  // Intentionally inert: the data partition this would wipe was never created
  // by a headless host, and SessionManager's browserPaneClearData answers
  // per-pane without one. Resolving keeps that answer "cleared nothing".
}
