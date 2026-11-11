import * as path from "node:path";
import type { CouncilMember, CouncilRosterResult } from "./council-config";
import { writeLineageArtifact } from "./lineage-artifact";

/**
 * The resolved council captured for one process (ADR-0088): main resolves
 * app-state documents with the same validator Settings uses. The bridge
 * embeds this launch set; its persisted manifest is only a warm content-hash
 * input, never a runtime source of council state.
 */
const SNAPSHOT_NAME = "omp-ui-council-roster.json";
export const COUNCIL_ROSTER_SNAPSHOT_VERSION = 2;

export interface CouncilRosterSnapshotEntry {
  readonly name: string;
  readonly model: string;
  readonly instructions: string | null;
}

export interface CouncilRosterSnapshot {
  readonly version: typeof COUNCIL_ROSTER_SNAPSHOT_VERSION;
  readonly instructions: string | null;
  readonly members: readonly CouncilRosterSnapshotEntry[];
  /** The trial member the bridge launches in its own task call; null = none. */
  readonly trial: CouncilRosterSnapshotEntry | null;
  readonly configWarnings: readonly string[];
}

export type CouncilInitializationStage = "resolve" | "overlay" | "snapshot" | "extension";

export interface CouncilInitializationFailure {
  readonly stage: CouncilInitializationStage;
  readonly message: string;
}

export type CouncilBridgeState =
  | { readonly status: "ready"; readonly snapshot: CouncilRosterSnapshot }
  | { readonly status: "unavailable"; readonly failure: CouncilInitializationFailure };

export type SessionCouncilStatus =
  | { readonly status: "available"; readonly memberCount: number }
  | { readonly status: "empty"; readonly configWarnings: readonly string[] }
  | { readonly status: "unavailable"; readonly failure: CouncilInitializationFailure }
  | { readonly status: "disabled" | "starting" | "missing-session" | "not-live" | "terminal" };

export function councilRosterSnapshotPath(lineageDir: string): string {
  return path.join(lineageDir, SNAPSHOT_NAME);
}

const textOrNull = (v: string | null): string | null => (v !== null && v.trim() !== "" ? v : null);

const entryOf = (m: CouncilMember): CouncilRosterSnapshotEntry | null =>
  m.model === null ? null : { name: m.name, model: m.model, instructions: textOrNull(m.instructions) };

/** Builds the launch set once from an already-resolved roster. */
export function createCouncilRosterSnapshot(roster: CouncilRosterResult): CouncilRosterSnapshot {
  const members: CouncilRosterSnapshotEntry[] = [];
  for (const m of roster.members) {
    const entry = entryOf(m);
    if (entry !== null) members.push(entry);
  }
  return {
    version: COUNCIL_ROSTER_SNAPSHOT_VERSION,
    instructions: textOrNull(roster.instructions),
    members,
    trial: roster.trial === null ? null : entryOf(roster.trial),
    configWarnings: roster.configWarnings,
  };
}

/** Persists the same launch set embedded in the bridge, for warm content hashing. */
export function writeCouncilRosterSnapshot(lineageDir: string, snapshot: CouncilRosterSnapshot): string {
  return writeLineageArtifact(lineageDir, councilRosterSnapshotPath(lineageDir), `${JSON.stringify(snapshot)}\n`);
}
