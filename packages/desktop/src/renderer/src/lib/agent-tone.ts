import type { Tone } from "./tone";

/** Agent roster/subagent-view status → tone. Copper pulses while work
 *  happens; the signal accent stays reserved for genuine liveness/success
 *  (ADR-0004). */
export const AGENT_TONE: Record<string, Tone> = {
  running: "copper",
  active: "copper",
  pending: "neutral",
  queued: "neutral",
  completed: "signal",
  done: "signal",
  failed: "rose",
  error: "rose",
  cancelled: "rose",
  // Parked is omp's released-but-readable state (#684): the row stays alive
  // in the pane with a revive affordance, so it reads neutral, not rose.
  parked: "neutral",
  // Hard-aborted (killed through the control bridge): readable, not live.
  aborted: "rose",
  settled: "neutral",
};
