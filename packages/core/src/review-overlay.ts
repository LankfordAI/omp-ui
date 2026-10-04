import * as path from "node:path";
import { writeLineageArtifact } from "./lineage-artifact";

/**
 * The session-scope overlay for `/code-review` (ADR-0047): the batch `task`
 * call and async job delivery must be on even when the user's global config
 * turned either off — the launch prompt asks the model for a batch call, and
 * a session that refuses async jobs would silently strand the roster.
 * omp's defaults are both true (`protocolDefault: ["rpc"]`, probed against
 * 18.6.0), so this overlay only ever restates the defaults for rpc-ui
 * sessions; it is idempotent and cheap.
 */

const OVERLAY_NAME = "omp-ui-review.yml";

export function reviewOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

export function writeReviewOverlay(lineageDir: string): string {
  return writeLineageArtifact(
    lineageDir,
    reviewOverlayPath(lineageDir),
    "async:\n  enabled: true\ntask:\n  batch: true\n",
  );
}
