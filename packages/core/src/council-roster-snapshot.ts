import * as path from "node:path";
import type { CouncilRosterResult } from "./council-config";
import { writeLineageArtifact } from "./lineage-artifact";

/**
 * The resolved council the bridge launches (ADR-0088): main resolves the
 * app-state documents with the same validator Settings uses and writes the
 * launch set here on every rpc spawn, so the bridge never touches state and
 * launches exactly what Settings shows.
 */
const SNAPSHOT_NAME = "omp-ui-council-roster.json";
export const COUNCIL_ROSTER_SNAPSHOT_VERSION = 1;

export interface CouncilRosterSnapshotEntry {
  readonly name: string;
  readonly model: string;
  readonly instructions: string | null;
}

export interface CouncilRosterSnapshot {
  readonly version: typeof COUNCIL_ROSTER_SNAPSHOT_VERSION;
  readonly instructions: string | null;
  readonly members: readonly CouncilRosterSnapshotEntry[];
  readonly configWarnings: readonly string[];
}

export function councilRosterSnapshotPath(lineageDir: string): string {
  return path.join(lineageDir, SNAPSHOT_NAME);
}

const textOrNull = (v: string | null): string | null => (v !== null && v.trim() !== "" ? v : null);

/** Writes the launch set of an already-resolved roster (members all carry a model). */
export function writeCouncilRosterSnapshot(lineageDir: string, roster: CouncilRosterResult): string {
  const members: CouncilRosterSnapshotEntry[] = [];
  for (const m of roster.members) {
    if (m.model === null) continue;
    members.push({ name: m.name, model: m.model, instructions: textOrNull(m.instructions) });
  }
  const snapshot: CouncilRosterSnapshot = {
    version: COUNCIL_ROSTER_SNAPSHOT_VERSION,
    instructions: textOrNull(roster.instructions),
    members,
    configWarnings: roster.configWarnings,
  };
  return writeLineageArtifact(lineageDir, councilRosterSnapshotPath(lineageDir), `${JSON.stringify(snapshot)}\n`);
}
