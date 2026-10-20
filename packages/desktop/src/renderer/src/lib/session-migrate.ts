import { compareVersions } from "@omp-ui/core/semver";

/** omp gained `session pack` / `session unpack` / `session moved` and
 * `auth export` / `auth import` in 18.10.0 (issue #888) — one release, so one
 * gate covers both the session-migration and carry-sign-ins flows. */
export const SESSION_MIGRATE_MIN_OMP = "18.10.0";

/** Unknown version hides the action: an older binary rejects the command.
 * A joined instance's remote omp version is unknowable from here; a stale
 * remote fails per call with omp's own message (ADR-0028's skew rule). */
export function supportsSessionMigrate(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, SESSION_MIGRATE_MIN_OMP) >= 0;
}
