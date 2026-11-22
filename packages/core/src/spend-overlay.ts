import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact } from "./lineage-artifact";

/**
 * Per-lineage spend cap overlay (`omp-ui-spend.yml`, ADR-0100) passed via
 * `--config`. Omits zero/non-positive slots and removes the file entirely
 * when both `warnUsd` and `maxUsd` are `<= 0`.
 */

const OVERLAY_NAME = "omp-ui-spend.yml";

export function spendOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

export function writeSpendOverlay(
  lineageDir: string,
  warnUsd: number,
  maxUsd: number,
): string | null {
  const file = spendOverlayPath(lineageDir);
  const lines: string[] = [];
  if (Number.isFinite(warnUsd) && warnUsd > 0) {
    lines.push(`  warnCost: ${warnUsd}`);
  }
  if (Number.isFinite(maxUsd) && maxUsd > 0) {
    lines.push(`  maxCost: ${maxUsd}`);
  }
  if (lines.length === 0) {
    removeLineageArtifact(file);
    return null;
  }
  return writeLineageArtifact(lineageDir, file, `session:\n${lines.join("\n")}\n`);
}
