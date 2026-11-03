import { compareVersions } from "@omp-ui/core/semver";

/** omp's rpc-ui gained `btw.inject` in 18.16.0 (upstream can1357/oh-my-pi#17618). */
export const BTW_INJECT_MIN_OMP = "18.16.0";

/** Unknown version hides the feature: an older omp never drafts `<inject>`
 *  blocks and renders none, so the affordance needs 18.16. */
export function supportsBtwInject(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, BTW_INJECT_MIN_OMP) >= 0;
}
