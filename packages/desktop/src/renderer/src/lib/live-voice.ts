import { compareVersions } from "@omp-ui/core/semver";

/** omp's rpc-ui gained live voice in 18.5.1 (issue #778). */
export const NATIVE_LIVE_MIN_OMP = "18.5.1";

/** Unknown version hides the feature: an older runtime rejects the verbs. */
export function supportsNativeLive(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, NATIVE_LIVE_MIN_OMP) >= 0;
}
