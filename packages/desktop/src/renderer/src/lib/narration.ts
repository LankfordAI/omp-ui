import { compareVersions } from "@omp-ui/core/semver";

/** omp 18.12 tags between-tool narration on thinking blocks (issue #884). */
export const NARRATION_MIN_OMP = "18.12.0";

/** Unknown version falls back to the thinking pane: an older harness never sets the flag. */
export function supportsNarration(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, NARRATION_MIN_OMP) >= 0;
}
