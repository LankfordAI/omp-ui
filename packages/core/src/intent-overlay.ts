import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact } from "./lineage-artifact";

/**
 * Native tool cards headline with the intent a tool call carries on
 * `tool_execution_start` (issue #1231). omp 19 resolved `tools.intentTracing`
 * on only in its interactive TUI (`intentTracingActive` falls back to
 * `isInteractiveHost` when no layer or `PI_INTENT_TRACING` names the key); an
 * rpc-ui session gets calls without the field, and every card degrades to an
 * argument summary. A native session whose user never set the key boots with
 * it pinned on through a `--config` overlay (the ADR-0038 pattern), like the
 * out:// pin before it (#969).
 *
 * omp's layer order does the respecting for us: an explicit
 * `tools.intentTracing` in any settings layer is checked by the caller and
 * skips the pin, and a non-fallback env value outranks every layer including
 * this overlay — so an exported `PI_INTENT_TRACING` always wins. The caller
 * still skips the write when the env is set, so no stale artifact claims a
 * preference the process ignores.
 *
 * A null pin means "the user spoke": the artifact is removed and omp resolves
 * its own layers. Terminal tabs never get the overlay — omp's TUI already
 * defaults it on — and no version gate is needed: every supported omp knows
 * `tools.intentTracing` with a compiled-in default of on, so pinning true is
 * the status quo there and the v19 restore below it. Like every overlay this
 * binds at process start and is restated on every launch.
 */

const OVERLAY_NAME = "omp-ui-intent.yml";

export function intentTracingOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/** Writes the intent pin, or removes a stale artifact and returns null. */
export function writeIntentTracingOverlay(lineageDir: string, pin: boolean | null): string | null {
  const file = intentTracingOverlayPath(lineageDir);
  if (pin !== true) {
    removeLineageArtifact(file);
    return null;
  }
  return writeLineageArtifact(lineageDir, file, "tools:\n  intentTracing: true\n");
}
