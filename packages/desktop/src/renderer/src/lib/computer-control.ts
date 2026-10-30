import { compareVersions } from "@omp-ui/core/semver";

/** omp reads `tools.approval["computer.control"]` from 18.14.0 (issue #976). */
export const COMPUTER_CONTROL_POLICY_MIN_OMP = "18.14.0";

/** Unknown version hides the row: an older omp ignores the entry, so a saved
 *  `allow` would read as set while every control request still prompts. */
export function supportsComputerControlPolicy(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, COMPUTER_CONTROL_POLICY_MIN_OMP) >= 0;
}
