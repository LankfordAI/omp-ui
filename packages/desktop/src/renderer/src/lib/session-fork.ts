import { compareVersions } from "@omp-ui/core/semver";

/** omp's rpc-ui gained the `fork` command in 18.4.11 (upstream #14077). */
export const NATIVE_FORK_MIN_OMP = "18.4.11";

/** Unknown version hides the action: an older runtime rejects the verb. */
export function supportsNativeFork(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, NATIVE_FORK_MIN_OMP) >= 0;
}
