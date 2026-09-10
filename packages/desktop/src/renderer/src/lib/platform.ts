/**
 * Synchronous platform signal for window-chrome layout. Electron still reports
 * "MacIntel"/"Win32" here; the deprecated field is the only sync source in the
 * renderer (extracted from hotkeys.ts).
 */
const platform = typeof navigator === "undefined" ? "" : navigator.platform;
export const IS_MAC = /^mac/i.test(platform);
export const IS_WINDOWS = /^win/i.test(platform);
