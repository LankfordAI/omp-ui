// The loop-end wire contract (issue #1192). omp's RPC stream ends every model
// loop with an `agent_end`; from 18.17 the frame carries `isTerminal`, and a
// loop that stops while the run goes on — a continuation, queued input, or
// outside work will resume it — is flagged `isTerminal: false`. Only the run's
// one terminal `agent_end` ends the run (upstream `session/loop-end-wire.ts`,
// docs/rpc.md "Yield vs settled"). Frames from older runtimes omit the field;
// an absent flag is terminal, never a pause.
//
// Pure — zero runtime imports, `unknown` frame params exactly like
// stream-activity — so both the renderer and main-process observers read the
// wire the same way through one definition.
export function isNonTerminalAgentEnd(frame: unknown): boolean {
  if (frame === null || typeof frame !== "object") return false;
  const record = frame as Record<string, unknown>;
  return record.type === "agent_end" && record.isTerminal === false;
}

/**
 * True on a non-terminal `agent_end` whose only possible resume is outside
 * work: a background-job result, a running child agent's message, or a queued
 * peer message (issue #1204's waiting state). Queued user input can also
 * resume a paused run, but that end reports false: the session is parked on
 * the person, not on work.
 */
export function agentEndAwaitsAsyncWork(frame: unknown): boolean {
  if (!isNonTerminalAgentEnd(frame)) return false;
  return (frame as Record<string, unknown>).awaitingAsyncWork === true;
}
