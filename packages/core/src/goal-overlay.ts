import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact, yamlQuote } from "./lineage-artifact";

/**
 * omp drives goal continuation itself, but only in the modes listed under
 * `goal.continuationModes` (default `["interactive"]`), and rpc-ui is mode
 * `"rpc"`. So a session whose user kept the interactive default would never
 * auto-continue under omp-ui. ADR-0046: omp-ui follows the user's interactive
 * choice into rpc through a per-spawn `--config` overlay written beside the
 * transcript, and writes nothing when the user removed `"interactive"`.
 */

/** The overlay lives beside the transcript so it dies with the lineage. */
const OVERLAY_NAME = "omp-ui-goal.yml";

export function goalOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/**
 * Follows the user's interactive choice into rpc (ADR-0046): adds "rpc" only when
 * the effective value already contains "interactive" and lacks "rpc". Null = no overlay.
 */
export function rpcGoalContinuationModes(configured: readonly string[]): string[] | null {
  if (!configured.includes("interactive") || configured.includes("rpc")) return null;
  return [...configured, "rpc"];
}

/** Writes `goal.continuationModes`, or removes a stale overlay and returns null. */
export function writeGoalContinuationOverlay(
  lineageDir: string,
  modes: readonly string[] | null,
): string | null {
  const file = goalOverlayPath(lineageDir);
  if (modes === null) {
    removeLineageArtifact(file);
    return null;
  }
  return writeLineageArtifact(
    lineageDir,
    file,
    `goal:\n  continuationModes:\n${modes.map((m) => `    - ${yamlQuote(m)}\n`).join("")}`,
  );
}
