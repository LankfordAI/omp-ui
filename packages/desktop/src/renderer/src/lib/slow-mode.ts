import { compareVersions } from "@omp-ui/core/semver";

/** omp's rpc-ui gained slow-mode state and set_slow_mode in 18.6.3 (upstream #14153). */
export const SLOW_MODE_MIN_OMP = "18.6.3";

/** Unknown version hides the feature: an older runtime rejects the verbs. */
export function supportsSlowMode(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, SLOW_MODE_MIN_OMP) >= 0;
}

/** The full UI gate (issue #777): the version guard for a runtime that
 *  would emit the fields but reject the verb, AND the capability flag the
 *  runtime reports — old omp never emits it, so it is the authority. */
export function showsSlowMode(ompVersion: string | null, supported: boolean): boolean {
  return supported && supportsSlowMode(ompVersion);
}
