import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeLineageArtifact } from "./lineage-artifact";
import { readReviewRoster, type ReviewTargetKind } from "./review-config";

/**
 * The merged REVIEW.yml roster the code-review bridge launches (ADR-0047 as
 * amended): main parses with the same js-yaml validation Settings uses and
 * writes the enabled entries here on every rpc spawn, so the bridge never
 * parses YAML and launches exactly what Settings shows.
 */
const SNAPSHOT_NAME = "omp-ui-review-roster.json";
export const REVIEW_ROSTER_SNAPSHOT_VERSION = 1;

export interface ReviewRosterSnapshotEntry {
  readonly name: string;
  readonly model: string | null;
  readonly instructions: string | null;
  readonly targets: readonly ReviewTargetKind[] | null;
}

export interface ReviewRosterSnapshot {
  readonly version: typeof REVIEW_ROSTER_SNAPSHOT_VERSION;
  readonly instructions: string | null;
  readonly reviewers: readonly ReviewRosterSnapshotEntry[];
  readonly configWarnings: readonly string[];
}

export function reviewRosterSnapshotPath(lineageDir: string): string {
  return path.join(lineageDir, SNAPSHOT_NAME);
}

const textOrNull = (v: string | null): string | null => (v !== null && v.trim() !== "" ? v : null);

/** Rewrites the snapshot; on a read failure removes any stale copy, then rethrows. */
export async function writeReviewRosterSnapshot(
  lineageDir: string,
  scopeCwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<string> {
  const file = reviewRosterSnapshotPath(lineageDir);
  let roster;
  try {
    roster = await readReviewRoster(scopeCwd, env, home);
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  const snapshot: ReviewRosterSnapshot = {
    version: REVIEW_ROSTER_SNAPSHOT_VERSION,
    instructions: textOrNull(roster.instructions),
    reviewers: roster.reviewers.map((r) => ({
      name: r.name,
      model: textOrNull(r.model),
      instructions: textOrNull(r.instructions),
      targets: r.targets,
    })),
    configWarnings: roster.configWarnings,
  };
  return writeLineageArtifact(lineageDir, file, `${JSON.stringify(snapshot)}\n`);
}
