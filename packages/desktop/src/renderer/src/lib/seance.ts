import { compareVersions } from "@omp-ui/core/semver";

/** omp gained `/seance` and the bundled `seance` task agent in 18.11.3 (upstream #15036). */
export const SEANCE_MIN_OMP = "18.11.3";

/** Unknown version hides the feature: an older harness has no `seance` agent. */
export function supportsSeance(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, SEANCE_MIN_OMP) >= 0;
}
