import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact } from "./lineage-artifact";

/**
 * omp-ui's worktree model runs concurrent sessions against one shared
 * checkout, the exact hazard omp's `bash.gitGuard` exists for (issue #832).
 * omp's compiled-in default is off, so a worktree session whose user never
 * configured the key boots with the guard pinned on through a `--config`
 * overlay (the ADR-0038 pattern).
 *
 * A null pin means "the user spoke, or this is no worktree session": the
 * artifact is removed and omp resolves its own layers, so the settings-page
 * row is never silently overridden. Like every other overlay this binds at
 * process start; converting to or from a worktree respawns, so the next
 * launch restates it from the record.
 */

const OVERLAY_NAME = "omp-ui-git-guard.yml";

export function gitGuardOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/** Writes the guard pin, or removes a stale artifact and returns null. */
export function writeGitGuardOverlay(
  lineageDir: string,
  pin: boolean | null,
): string | null {
  const file = gitGuardOverlayPath(lineageDir);
  if (pin !== true) {
    removeLineageArtifact(file);
    return null;
  }
  return writeLineageArtifact(lineageDir, file, "bash:\n  gitGuard: true\n");
}
