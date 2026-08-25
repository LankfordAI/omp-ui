import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact, yamlQuote } from "./lineage-artifact";

const OVERLAY_NAME = "omp-ui-compaction.yml";

export function compactionMethodOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

export function writeCompactionMethodOverlay(
  lineageDir: string,
  preferred: string | null,
  configuredOrder: readonly string[],
): string | null {
  const file = compactionMethodOverlayPath(lineageDir);
  if (preferred === null) {
    removeLineageArtifact(file);
    return null;
  }
  const order = [preferred, ...configuredOrder.filter((id) => id !== preferred)];
  return writeLineageArtifact(
    lineageDir,
    file,
    `compaction:\n  methodOrder:\n${order.map((id) => `    - ${yamlQuote(id)}\n`).join("")}`,
  );
}

