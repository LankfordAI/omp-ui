import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact } from "./lineage-artifact";

const ARTIFACT_NAME = "carryover-context.md";

/** The per-launch artifact path inside the lineage dir (ADR-0003). */
export function carryoverContextPath(lineageDir: string): string {
  return path.join(lineageDir, ARTIFACT_NAME);
}

/**
 * Write the carryover artifact for this launch, or remove the stale one so
 * the lineage dir always mirrors the last launch. A non-empty digest writes
 * and returns the path to hand omp as `--append-system-prompt`; anything
 * else (null, blank) removes the file and returns null. Never throws when
 * the file is already absent (removeLineageArtifact semantics).
 */
export function stageCarryoverContext(
  absLineageDir: string,
  digest: string | null,
): string | null {
  const file = carryoverContextPath(absLineageDir);
  if (digest === null || digest.trim() === "") {
    removeLineageArtifact(file);
    return null;
  }
  return writeLineageArtifact(absLineageDir, file, digest);
}
