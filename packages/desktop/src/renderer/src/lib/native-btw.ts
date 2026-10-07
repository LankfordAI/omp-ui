import { compareVersions } from "@omp-ui/core/semver";

/** omp's rpc-ui gained btw/btw_cancel/get_btw_history in 18.6.3 (upstream #14110). */
export const NATIVE_BTW_MIN_OMP = "18.6.3";

/** Unknown version hides the feature: an older runtime rejects the verbs. */
export function supportsNativeBtw(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, NATIVE_BTW_MIN_OMP) >= 0;
}
