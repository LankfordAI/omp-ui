import * as path from "node:path";
import { writeLineageArtifact } from "./lineage-artifact";

/** Plain generated titles for omp-ui; existing stored titles are never rewritten. */
export function writeTitleOverlay(lineageDir: string): string {
  return writeLineageArtifact(
    lineageDir,
    path.join(lineageDir, "omp-ui-title.yml"),
    "title:\n  icons: boring\n",
  );
}
