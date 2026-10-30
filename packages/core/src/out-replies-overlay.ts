import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact } from "./lineage-artifact";

/**
 * omp resolves `out.enabled` (issue #969) to true only in its interactive TUI;
 * an rpc-ui session gets out:// refused by tool policy ("out:// is off in this
 * session"). A native session on omp >= 18.14 whose user never set the key
 * boots with it pinned on through a `--config` overlay (the ADR-0038
 * pattern), so the agent can reply mid-turn and the transcript renders it.
 *
 * A null pin means "the user spoke, or this omp predates out://": the
 * artifact is removed and omp resolves its own layers. Terminal tabs never
 * get the overlay — omp's TUI already defaults it on. Like every overlay this
 * binds at process start and is restated from the record on every launch.
 */

const OVERLAY_NAME = "omp-ui-out.yml";

export function outRepliesOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/** Writes the out:// pin, or removes a stale artifact and returns null. */
export function writeOutRepliesOverlay(lineageDir: string, pin: boolean | null): string | null {
  const file = outRepliesOverlayPath(lineageDir);
  if (pin !== true) {
    removeLineageArtifact(file);
    return null;
  }
  return writeLineageArtifact(lineageDir, file, "out:\n  enabled: true\n");
}
