/**
 * Renderer-death recovery policy (issue #183). Pure — no Electron imports — so
 * the crash-loop cap is unit-testable without a BrowserWindow. The wiring in
 * index.ts records every render-process-gone and asks here whether to reload.
 */

export interface ProcessDeath {
  at: number;
  reason: string;
}

/** Max reloads inside the window before we stop resurrecting a crash loop. */
export const RECOVERY_WINDOW_MS = 600_000;
export const RECOVERY_MAX_RELOADS = 3;

export function shouldReloadRenderer(
  reason: string,
  history: readonly ProcessDeath[],
  now: number,
): boolean {
  if (reason === "clean-exit") return false;
  return history.filter((d) => now - d.at < RECOVERY_WINDOW_MS).length < RECOVERY_MAX_RELOADS;
}
