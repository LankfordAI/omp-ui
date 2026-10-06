import * as path from "node:path";
import { writeLineageArtifact } from "./lineage-artifact";

const OVERLAY_NAME = "omp-ui-vault.yml";

export function vaultOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/** omp-ui owns vault calls through host tools, so omp's built-in tools stay disabled. */
export function writeVaultOverlay(lineageDir: string): string {
  return writeLineageArtifact(lineageDir, vaultOverlayPath(lineageDir), "vault:\n  enabled: false\n");
}
