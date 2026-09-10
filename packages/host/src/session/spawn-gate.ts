import { formatModelRole, parseModelRole, type ModelRole } from "@omp-ui/core";

/**
 * Model pins forced on every spawn by this app instance (docs/development.md).
 *
 * A verification run boots the app with `npm run dev` and drives it over CDP, and
 * every live session that run spawns would otherwise land on a frontier model:
 * a fresh session on `project.defaultModel ?? project.lastModel`, a resumed one on
 * the model its transcript already carries. Global omp `modelRoles` would cheapen
 * the user's own work too, and a project pin (#257) is never consulted on resume.
 * So the gate is per-instance, read once from the environment, and applied at the
 * single spawn choke point in `SessionManager`.
 *
 * Both pins are opt-in: with neither set, every argv and overlay this process
 * produces is byte-identical to an ungated launch.
 */
export interface SpawnGate {
  /** omp `model[:level]` selector for the session's main model; null = not gated. */
  model: ModelRole | null;
  /** omp selector for `modelRoles.advisor`; null = not gated. */
  advisorModel: ModelRole | null;
}

export const NO_GATE: SpawnGate = { model: null, advisorModel: null };

/**
 * Reads the gate from the environment. `parseModelRole` returns null for a blank
 * value, so an unset, empty, or whitespace-only seam simply means "not gated".
 */
export function parseSpawnGate(env: NodeJS.ProcessEnv = process.env): SpawnGate {
  return {
    model: parseModelRole(env.OMP_UI_TEST_MODEL ?? ""),
    advisorModel: parseModelRole(env.OMP_UI_TEST_ADVISOR ?? ""),
  };
}

/** The selector omp's `--model` flag wants, or null when the gate is off. */
export function gateSelector(gate: SpawnGate): string | null {
  return gate.model === null ? null : formatModelRole(gate.model);
}
