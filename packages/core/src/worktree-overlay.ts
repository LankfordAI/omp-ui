import * as path from "node:path";
import { writeLineageArtifact, yamlQuote } from "./lineage-artifact";

/**
 * omp 18.8.7 added worktree.onStart/worktree.onExit: omp itself can mint and
 * clean up a session worktree. omp-ui owns worktree lifecycle (convert-to-
 * worktree, releaseWorktree, the omp-ui/[base]/hex branch scheme), so a user's
 * global omp config that enables these keys would nest an omp-ui-invisible
 * worktree inside the omp-ui checkout — and onExit: remove could delete it
 * under a live session. Both keys are pinned off on every spawn through this
 * overlay, whose --config layer outranks global/project config (ADR-0038
 * pattern); there is no settings row because no "on" state is honest here.
 *
 * omp 18.17 added a second bypass with the same shape: ovnfs turns itself on
 * whenever its binary is discoverable (`ovnfs.path`, else `ovnfs` on PATH) —
 * agents get a system-prompt directive to open daemon checkouts instead of
 * git worktrees, and allowed isolated tasks run inside daemon mounts. ADR-0089
 * pins that off in the same overlay: every omp-ui-owned session points
 * `ovnfs.path` at the lineage directory itself. A directory is not an
 * executable on any platform — POSIX `execve` answers EISDIR/EACCES even with
 * the x bit set, and Windows `CreateProcess` refuses to start one — and this
 * directory is one omp-ui always creates (the artifact writer makes it before
 * writing this very file) and always removes with the lineage, so there is
 * exactly one path that can never be ovnfs for as long as the session exists.
 * Blank is not an off switch — it falls back to PATH — so the pin must name a
 * non-executable path, not merely an absent one.
 */

/** The overlay lives beside the transcript so it dies with the lineage. */
const OVERLAY_NAME = "omp-ui-worktree.yml";

export function worktreeOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/** omp-ui is the only worktree authority, so all three pins stay at their safe values. */
export function writeWorktreeOverlay(lineageDir: string): string {
  return writeLineageArtifact(
    lineageDir,
    worktreeOverlayPath(lineageDir),
    `worktree:\n  onStart: off\n  onExit: keep\novnfs:\n  path: ${yamlQuote(path.resolve(lineageDir))}\n`,
  );
}
