import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact, yamlQuote } from "./lineage-artifact";
import { isSafeAgentName, isSafeSelector, type SubagentModelMap } from "./subagent-model";

/**
 * The session-scope half of subagent model selection (ADR-0031): a `--config`
 * YAML overlay carrying `task.agentModelOverrides`, written into the session's
 * own lineage dir and passed at spawn — the same mechanism as the advisor and
 * default-model overlays.
 *
 * Unlike the advisor overlay, this one is LIVE: omp's subagent preflight
 * re-reads the `--config` layer before every spawn (verified against
 * v18.2.4), so `session:setSubagentModels` rewrites this file in place and
 * the next subagent picks the change up with no respawn.
 *
 * omp's layer order makes the overlay the last word: session choice wins over
 * the project and global `task.agentModelOverrides` records, deep-merged per
 * agent name, so the file only ever carries the session's own entries.
 */

/** The overlay lives beside the transcript so it dies with the lineage. */
const OVERLAY_NAME = "omp-ui-subagents.yml";

export function subagentModelOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/**
 * Writes the overlay pinning this session's subagent models, and returns the
 * path to pass as `--config` — or null when `entries` is empty and omp's own
 * layers should decide untouched.
 *
 * A rejected name or selector removes the artifact and returns null rather
 * than emitting a file omp's strict loader would refuse (lineage-artifact.ts
 * header); `""` is never written because it resolves to "no pattern", not to
 * an absent key.
 */
export function writeSubagentModelOverlay(
  lineageDir: string,
  entries: SubagentModelMap,
): string | null {
  const file = subagentModelOverlayPath(lineageDir);
  const names = Object.keys(entries).sort();
  if (names.some((name) => !isSafeAgentName(name) || !isSafeSelector(entries[name]!))) {
    removeLineageArtifact(file);
    return null;
  }
  if (names.length === 0) {
    removeLineageArtifact(file);
    return null;
  }
  const lines = names.map(
    (name) => `    ${yamlQuote(name)}: ${yamlQuote(entries[name]!)}`,
  );
  return writeLineageArtifact(
    lineageDir,
    file,
    `task:\n  agentModelOverrides:\n${lines.join("\n")}\n`,
  );
}
