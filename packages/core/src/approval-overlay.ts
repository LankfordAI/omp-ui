import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact } from "./lineage-artifact";
import type { ApprovalMode } from "./types";

/**
 * omp binds `tools.approvalMode` at process start (the same one-way
 * `settings.override` rail as the advisor role — verified against v18.4.2):
 * there is no rpc setter and `get_state` reports nothing. So a session-pinned
 * approval mode is spelled the one way omp honours — a `--config` YAML overlay
 * written into the session's own lineage dir and passed at spawn (ADR-0038).
 * Changing it therefore requires a respawn, which the renderer does explicitly.
 *
 * A null mode removes the artifact entirely: the honest "inherit" state lets
 * omp resolve its own global/project config, so a hand-edited omp config is
 * never silently overridden by a session that never expressed a preference.
 */

/** The overlay lives beside the transcript so it dies with the lineage. */
const OVERLAY_NAME = "omp-ui-approval.yml";

export function approvalOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/**
 * Writes the overlay pinning this session's approval mode, and returns the
 * path to pass as `--config` — or null when the session has nothing to say
 * and omp's own config should decide untouched. The enum values need no
 * quoting; the `--config` loader is strict, so only a well-formed file is
 * ever written — and a stale artifact from a previous mode is removed when
 * the mode is null, never passed.
 */
export function writeApprovalOverlay(
  lineageDir: string,
  mode: ApprovalMode | null,
): string | null {
  const file = approvalOverlayPath(lineageDir);
  if (mode === null) {
    removeLineageArtifact(file);
    return null;
  }
  return writeLineageArtifact(lineageDir, file, `tools:\n  approvalMode: ${mode}\n`);
}
