import { compareVersions } from "./semver";

/**
 * The omp version window in which a Seance consult is possible.
 *
 * omp gained `/seance` and the bundled `seance` task agent in 18.11.3 (upstream
 * #15036). omp 18.20.3 removed all of it again — the agent, the slash command,
 * and the task tool's `sourceSession` parameter (upstream CHANGELOG 18.20.3,
 * Breaking Changes) — and shipped no subagent replacement for consulting a
 * saved transcript. So the feature is alive only inside `[min, max)`.
 */
export const SEANCE_MIN_OMP = "18.11.3";

/** The first omp WITHOUT seance: the version at which every gate closes. */
export const SEANCE_MAX_OMP = "18.20.3";

/** Unknown version hides the feature: an older harness has no `seance` agent. */
export function supportsSeance(ompVersion: string | null): boolean {
  return (
    ompVersion !== null &&
    compareVersions(ompVersion, SEANCE_MIN_OMP) >= 0 &&
    compareVersions(ompVersion, SEANCE_MAX_OMP) < 0
  );
}

/**
 * True when this omp is one that REMOVED seance (≥ 18.20.3), as opposed to one
 * that merely predates it. Surfaces hide entirely here — an update can never
 * bring the route back, so a disabled affordance pointing at a version floor
 * would only mislead. Below the floor the surfaces stay mounted and disabled.
 */
export function seanceRemovedFromOmp(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, SEANCE_MAX_OMP) >= 0;
}
