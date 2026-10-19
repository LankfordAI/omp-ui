/**
 * The oldest omp harness any omp-ui feature depends on. A release that
 * starts depending on a newer harness bumps this alongside its per-feature
 * `*_MIN_OMP` constant. Below it, the launch check auto-upgrades.
 *
 * Lives in its own module so renderer surfaces can import the floor without
 * the barrel's Node-only update machinery; omp-update re-exports it, so
 * `@omp-ui/core` stays a valid path for main-process callers.
 */
export const MIN_SUPPORTED_OMP = "18.11.3";
