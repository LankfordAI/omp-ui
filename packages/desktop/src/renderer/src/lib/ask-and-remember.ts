import { compareVersions } from "@omp-ui/core/semver";

/** omp gained the Ask and remember tier (`always-ask-cached`) and
 *  `/forget-approvals` in 18.12.3 (issue #950). */
export const ASK_AND_REMEMBER_MIN_OMP = "18.12.3";

/** omp's builtin that forgets every remembered file and folder approval. */
export const FORGET_APPROVALS_COMMAND = "forget-approvals";

/** Unknown version withholds the tier: an older omp resolves the unknown
 *  value to yolo, which would silently drop every approval. */
export function supportsAskAndRemember(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, ASK_AND_REMEMBER_MIN_OMP) >= 0;
}
