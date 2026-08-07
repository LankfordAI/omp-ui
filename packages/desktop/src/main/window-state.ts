import { readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Tier-3 update restore (issue #99): an AppImage update relaunches the app,
// so the window's geometry must outlive the process. Electron 43.2 has
// BrowserWindow.getNormalBounds() and screen.getDisplayMatching() but not the
// newer built-in windowStatePersistence, hence this explicit, self-contained
// module. State is tiny and the final `before-quit` write must finish before
// exit, so every save is a synchronous, atomic tmp+rename — never a promise.

export interface WindowState {
  schemaVersion: 1;
  bounds: { x: number; y: number; width: number; height: number };
  maximized: boolean;
}

type Rect = { x: number; y: number; width: number; height: number };

export function windowStatePath(userData: string): string {
  return join(userData, "window-state.json");
}

export function loadWindowState(file: string): WindowState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Missing, unreadable, or corrupt file: fall back to defaults.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const state = parsed as Record<string, unknown>;
  // Unknown schemaVersion means a future, incompatible layout — discard.
  if (state.schemaVersion !== 1) return null;
  const bounds = state.bounds;
  if (typeof bounds !== "object" || bounds === null) return null;
  const b = bounds as Record<string, unknown>;
  // JSON.parse can yield Infinity from `1e999`; every value must be finite.
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof b[key] !== "number" || !Number.isFinite(b[key])) return null;
  }
  // Smaller than 100x100 is a stale/broken file.
  if ((b.width as number) < 100 || (b.height as number) < 100) return null;
  if (typeof state.maximized !== "boolean") return null;
  return state as unknown as WindowState;
}

export function saveWindowState(file: string, state: WindowState): boolean {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup only; the caller never observes an exception.
    }
    return false;
  }
}

export function fitWindowBounds(
  bounds: Rect,
  workArea: Rect,
): Rect | null {
  const boundsValues = [bounds.x, bounds.y, bounds.width, bounds.height];
  const workValues = [workArea.x, workArea.y, workArea.width, workArea.height];
  const anyNonFinite = [...boundsValues, ...workValues].some(
    (v) => typeof v !== "number" || !Number.isFinite(v),
  );
  if (anyNonFinite) return null;
  // A degenerate display can't host the minimum window — discard saved bounds
  // rather than invent one (invalid monitor removed).
  if (workArea.width < 100 || workArea.height < 100) return null;
  const width = Math.max(100, Math.min(bounds.width, workArea.width));
  const height = Math.max(100, Math.min(bounds.height, workArea.height));
  // Clamp so at least 100x100 px stays inside the work area.
  const x = Math.min(
    Math.max(bounds.x, workArea.x),
    workArea.x + workArea.width - 100,
  );
  const y = Math.min(
    Math.max(bounds.y, workArea.y),
    workArea.y + workArea.height - 100,
  );
  return { x, y, width, height };
}