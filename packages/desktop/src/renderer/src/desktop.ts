import type { DesktopAdapter } from "@omp-ui/core/desktop-channels";

// The only module touching window.ompDesktop (mirror of backend.ts for window.ompBackend).
// null means no desktop client presents this UI: every client effect is hidden or replaced,
// never faked (#444 client effect, #442 criterion 11).
export const desktop: DesktopAdapter | null = window.ompDesktop ?? null;

/**
 * The one capability check for "am I inside the desktop client" (#442 §11). Window-chrome
 * insets and the desktop's own update card key off this, not the user agent: the adapter's
 * presence is what the preload promised, and a browser tab never has one.
 */
export const HAS_DESKTOP = desktop !== null;

/**
 * Client-local path effects for something owned by `instanceId`. A desktop client is always on
 * this host's machine (#449), so this host's own projects and tabs (null) qualify; a joined
 * instance's paths are instance-local and never do.
 */
export function pathEffects(instanceId: string | null): DesktopAdapter | null {
  return instanceId === null ? desktop : null;
}
