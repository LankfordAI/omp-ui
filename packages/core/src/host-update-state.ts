import type { HostUpdateState } from "./types";

/**
 * The host-update state of a build with no host updater, or of one that has
 * nothing in flight: what every client sees before a check ever runs.
 */
export function idleHostUpdateState(currentVersion: string): HostUpdateState {
  return {
    currentVersion,
    latestVersion: null,
    stagedVersion: null,
    status: "idle",
    progress: null,
    graceDeadlineMs: null,
    deferrals: 0,
    deferralLimit: 0,
    affectedTabIds: [],
    lastAttempt: null,
    rollbackVersion: null,
    currentIsStaged: false,
    error: null,
  };
}
