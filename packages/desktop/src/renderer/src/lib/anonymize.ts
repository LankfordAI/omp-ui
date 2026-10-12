import { compareVersions } from "@omp-ui/core/semver";

/** omp gained the `anonymize` command in 18.8.8 (issue #834). */
export const ANONYMIZE_MIN_OMP = "18.8.8";

/** Unknown version hides the action: an older binary rejects the command. */
export function supportsAnonymize(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, ANONYMIZE_MIN_OMP) >= 0;
}
