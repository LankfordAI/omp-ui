/**
 * The trusted clock-stamper page entry (browser clock). Imports the stamp
 * library only — no app bootstrap, store, or backend bridge (no preload).
 * Main calls window.ompClockStamper.stamp with one JSON request.
 */
import type { BrowserClockStampRequest } from "@omp-ui/core/browser-pane";
import { base64ToBytes, bytesToBase64 } from "./lib/clipboard-image";
import { stampImage } from "./lib/clock-stamp";

async function stamp(req: BrowserClockStampRequest): Promise<string> {
  const out = await stampImage(base64ToBytes(req.data), req.mimeType, req.quality, req.text, {
    cssWidth: req.cssWidth,
  });
  return bytesToBase64(out);
}

declare global {
  interface Window {
    ompClockStamper?: { stamp: (req: BrowserClockStampRequest) => Promise<string> };
  }
}

window.ompClockStamper = { stamp };
