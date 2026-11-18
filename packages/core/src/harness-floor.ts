/**
 * The oldest omp harness this release supports. The floor covers every
 * per-feature `*_MIN_OMP` gate and may rise to retire old-harness behavior.
 * Below it, the launch check auto-upgrades.
 *
 * Lives in its own module so renderer surfaces can import the floor without
 * the barrel's Node-only update machinery; omp-update re-exports it, so
 * `@omp-ui/core` stays a valid path for main-process callers.
 */
export const MIN_SUPPORTED_OMP = "18.22.0";
