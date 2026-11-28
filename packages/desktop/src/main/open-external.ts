import { BACKDROP_SCENE_FRAME_NAME } from "@omp-ui/core/theme-backdrop";
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

export type SubframeNavDecision = "allow" | "deny-silent" | "deny-open-external";

/**
 * Policy for Electron `will-frame-navigate` events.
 *
 * Backdrop scene iframes (`omp-backdrop-scene`) may only load `about:srcdoc`
 * and any other navigation (or a missing/destroyed frame) is denied silently
 * so an untrusted backdrop can never trigger `openExternalSafe`. Other
 * subframes (plan review frames, `frameName === ""`) keep external link
 * routing to the system browser.
 */
export function decideSubframeNavigation(details: {
  isMainFrame: boolean;
  url: string;
  frameName: string | null | undefined;
}): SubframeNavDecision {
  if (details.isMainFrame) return "allow";
  if (details.frameName === null || details.frameName === undefined) return "deny-silent";
  if (details.frameName === BACKDROP_SCENE_FRAME_NAME) {
    return details.url === "about:srcdoc" ? "allow" : "deny-silent";
  }
  if (details.url.startsWith("about:")) return "allow";
  return "deny-open-external";
}
