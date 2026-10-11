import * as path from "node:path";
import { writeLineageArtifact } from "./lineage-artifact";

/**
 * omp 18.8.7 added worktree.onStart/worktree.onExit: omp itself can mint and
 * clean up a session worktree. omp-ui owns worktree lifecycle (convert-to-
 * worktree, releaseWorktree, the omp-ui/[base]/hex branch scheme), so a user's
 * global omp config that enables these keys would nest an omp-ui-invisible
 * worktree inside the omp-ui checkout — and onExit: remove could delete it
 * under a live session. Both keys are pinned off on every spawn through this
 * overlay, whose --config layer outranks global/project config (ADR-0038
 * pattern); there is no settings row because no "on" state is honest here.
 */

/** The overlay lives beside the transcript so it dies with the lineage. */
const OVERLAY_NAME = "omp-ui-worktree.yml";

export function worktreeOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/** omp-ui is the only worktree authority, so both keys stay at their safe values. */
export function writeWorktreeOverlay(lineageDir: string): string {
  return writeLineageArtifact(
    lineageDir,
    worktreeOverlayPath(lineageDir),
    "worktree:\n  onStart: off\n  onExit: keep\n",
  );
}
