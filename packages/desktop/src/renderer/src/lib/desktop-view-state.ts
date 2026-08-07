/**
 * Version-gated desktop view restoration (issue #99 tier 3).
 *
 * On an AppImage update the app relaunches, and a relaunch that follows an
 * update must come back to the same desktop: window geometry (owned by the
 * main process), the open terminal and rpc-ui tabs, their order, and the
 * focused session. Desktop *view* state — which tabs are open, their order,
 * and per-project focus — is renderer-owned, deliberately out of `OmpBackend`:
 * the desktop renderer and each remote browser keep independent local storage,
 * so nothing belongs in the shared backend. Closest kin is `lib/themes.ts` /
 * `lib/text-scale.ts`, both localStorage helpers; this module borrows their
 * DEFENSIVE persistence style (try/catch everywhere, best-effort, never throw)
 * but, unlike `lib/themes.ts`, never touches the DOM at import time — it is a
 * pure library with no module-load side effects.
 *
 * Vocabulary: a TAB is the renderer's view onto a live session; we RESTORE
 * tabs on relaunch, never "resume" (resume belongs to sessions). A hidden tab
 * was closed by the user and must stay dormant across the relaunch.
 *
 * The version gate: persisted `appVersion` and the running
 * `AppUpdateState.currentVersion` must BOTH be non-null and DIFFER for a
 * restore. A same-version relaunch keeps the Welcome screen. This one rule
 * covers Restart now, Install when I quit, and a manually replaced AppImage —
 * there is no need to special-case any install path.
 */

/** Storage key for the whole desktop view snapshot. */
export const DESKTOP_VIEW_STORAGE_KEY = "omp-ui.desktopView.v1";

/**
 * The v1 on-disk shape (version 1 of the schema). `tabIds` preserves
 * first-occurrence renderer order; `focusedTabByProject` maps each project's
 * working directory to the tab the user last had focused there.
 */
export interface DesktopViewStateV1 {
  schemaVersion: 1;
  /** App version that produced this snapshot; the gate compares against it. */
  appVersion: string | null;
  /** Open (non-hidden) tab ids in renderer order. */
  tabIds: string[];
  /** The tab focused at snapshot time, when one exists. */
  activeTabId: string | null;
  /** Per-project focused tab, keyed by project working directory. */
  focusedTabByProject: Record<string, string>;
}

/** Minimal Storage-like surface the module reads and writes through. */
export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Parse + validate a serialized snapshot. Returns `null` for missing input,
 * unparseable JSON, or any shape violation, so a hand-edited or stale blob
 * degrades to "nothing to restore" rather than an exception. `tabIds` is
 * deduplicated preserving first-occurrence order; map entries whose value is
 * not a string are dropped, never rejected. Always returns a freshly built
 * object of exactly `DesktopViewStateV1`'s shape.
 */
export function parseDesktopView(raw: string | null): DesktopViewStateV1 | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (value.appVersion !== null && typeof value.appVersion !== "string") return null;

  const rawTabIds = value.tabIds;
  if (!Array.isArray(rawTabIds)) return null;
  const tabIds: string[] = [];
  const seen = new Set<string>();
  for (const id of rawTabIds) {
    if (typeof id !== "string") return null;
    if (seen.has(id)) continue;
    seen.add(id);
    tabIds.push(id);
  }

  const rawActive = value.activeTabId;
  if (rawActive !== null && typeof rawActive !== "string") return null;

  const rawFocus = value.focusedTabByProject;
  if (!isPlainObject(rawFocus)) return null;
  const focusedTabByProject: Record<string, string> = {};
  for (const [project, tabId] of Object.entries(rawFocus)) {
    if (typeof tabId === "string") focusedTabByProject[project] = tabId;
  }

  return {
    schemaVersion: 1,
    appVersion: value.appVersion as string | null,
    tabIds,
    activeTabId: rawActive,
    focusedTabByProject,
  };
}

/**
 * Read + parse the persisted snapshot. A read failure (or parse rejection)
 * yields `null` — never throws.
 */
export function loadDesktopView(storage: ViewStorage): DesktopViewStateV1 | null {
  try {
    return parseDesktopView(storage.getItem(DESKTOP_VIEW_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Persist a snapshot under `DESKTOP_VIEW_STORAGE_KEY`. Best-effort: a write
 * failure returns `false` (caller keeps the in-memory view) and never throws.
 */
export function saveDesktopView(storage: ViewStorage, state: DesktopViewStateV1): boolean {
  try {
    storage.setItem(DESKTOP_VIEW_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * The SINGLE version gate. Restore iff both the persisted `appVersion` and the
 * running `currentVersion` are present AND differ. A same-version relaunch
 * (no update applied) stays on the Welcome screen; any genuine update — which
 * always bumps the running version — differs and restores.
 */
export function shouldRestoreDesktopView(
  saved: DesktopViewStateV1 | null,
  currentVersion: string | null,
): boolean {
  return (
    saved !== null &&
    saved.appVersion !== null &&
    currentVersion !== null &&
    saved.appVersion !== currentVersion
  );
}

/**
 * The shape a caller records its live view in before snapshotting.
 * `tabs` lists every tab (visible or hidden); `hidden` tabs are omitted from
 * the snapshot because the user closed them and they must stay dormant.
 */
export interface ProjectedView {
  tabs: Array<{ tabId: string; hidden: boolean }>;
  activeTabId: string | null;
  focusedTabByProject: Record<string, string>;
}

/**
 * Build a snapshot from the live projected view. `tabIds` keeps visible tabs
 * in renderer order, deduplicated to first occurrence; `activeTabId` and
 * `focusedTabByProject` are copied as-is.
 */
export function projectDesktopView(
  view: ProjectedView,
  appVersion: string | null,
): DesktopViewStateV1 {
  const tabIds: string[] = [];
  const seen = new Set<string>();
  for (const tab of view.tabs) {
    if (tab.hidden) continue;
    if (seen.has(tab.tabId)) continue;
    seen.add(tab.tabId);
    tabIds.push(tab.tabId);
  }
  return {
    schemaVersion: 1,
    appVersion,
    tabIds,
    activeTabId: view.activeTabId,
    focusedTabByProject: { ...view.focusedTabByProject },
  };
}

/**
 * A `ViewStorage` adapter for `window.localStorage`, or `null` when storage
 * is unavailable — no `window`, a missing `localStorage`, or any access
 * throwing (private mode). The whole body is wrapped so persistence is a
 * strict no-op in non-browser contexts (the store test harness stubs `window`
 * without `localStorage`).
 */
export function desktopViewStorage(): ViewStorage | null {
  try {
    if (typeof window === "undefined") return null;
    const store = window.localStorage;
    if (!store) return null;
    return {
      getItem: (key: string) => store.getItem(key),
      setItem: (key: string, value: string) => store.setItem(key, value),
      removeItem: store.removeItem ? (key: string) => store.removeItem(key) : undefined,
    };
  } catch {
    return null;
  }
}