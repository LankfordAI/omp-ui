import { openExternal } from "./system-open";

/** The renderer's window.open routes here (setWindowOpenHandler, issue #101).
 * Mirror of the renderer's isSafeHref policy: untrusted transcript text must
 * never reach the system handler with a non-web scheme or smuggled control
 * chars (bareUrlAt's whitespace terminator does not stop NUL/ESC). */
const EXTERNAL_SCHEME = /^(?:https?:|mailto:)/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

export function openExternalSafe(url: string): void {
  if (!EXTERNAL_SCHEME.test(url) || CONTROL_CHAR.test(url)) return;
  // A launch failure reaches main.log through index.ts's unhandledRejection handler.
  void openExternal(url);
}
