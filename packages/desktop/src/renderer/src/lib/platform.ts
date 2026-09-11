/**
 * Synchronous platform signal for window-chrome layout. Electron still reports
 * "MacIntel"/"Win32" here; the deprecated field is the only sync source in the
 * renderer (extracted from hotkeys.ts).
 */
const platform = typeof navigator === "undefined" ? "" : navigator.platform;
export const IS_MAC = /^mac/i.test(platform);
export const IS_WINDOWS = /^win/i.test(platform);

/**
 * True inside the Electron shell, whose frameless window composites native
 * window controls over the document (main/index.ts: titleBarStyle "hidden" plus
 * titleBarOverlay). The remote web client (issue #37) ships this same bundle to
 * an ordinary browser tab, where `app-region` is inert and reserving room for
 * controls that do not exist is dead space. Electron appends `Electron/<ver>`
 * to the UA and nothing in this repo calls `setUserAgent`; if that ever changes,
 * this is the one line to revisit.
 */
export const IS_ELECTRON = /\bElectron\//.test(
  typeof navigator === "undefined" ? "" : navigator.userAgent,
);
