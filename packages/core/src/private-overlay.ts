import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact } from "./lineage-artifact";

/**
 * A private session (issue #852) is pinned write-quiet against the memory
 * system: recall reads, nothing writes. The *passive* write channels in omp
 * are config-gated — `mnemopi.autoRetain` drives the periodic retain pass
 * and the retain-on-dispose/consolidation path, `autolearn.enabled` drives
 * coding-agent lesson capture, and `hindsight.autoRetain` (issue #1094)
 * gates Hindsight's `agent_end` transcript retention — so a per-run
 * `--config` overlay (the ADR-0038 pattern, same as the git-guard pin)
 * closes all three without touching the global config.
 *
 * The overlay deliberately never names `memory.backend`, either recall
 * switch (`mnemopi.autoRecall`, `hindsight.autoRecall`) or `hindsight.apiUrl`:
 * absence is what keeps recall alive. Unlike the git-guard pin there is no
 * "explicit user value wins" carve-out — the overlay winning over a user-set
 * `mnemopi.autoRetain: true` is exactly the point of privacy. Binds at
 * process start; every spawn and resume re-derives it from the record.
 *
 * The overlay alone does NOT close the Hindsight channel: upstream's
 * `hindsight.autoRetain` handle is environment-backed (`HINDSIGHT_AUTO_RETAIN`)
 * with no config fallback, and a set environment variable outranks every
 * settings layer including this overlay. So a private spawn additionally
 * pins the variable OFF in its own child environment (see
 * {@link privateChildEnv}) — child-scoped, never a mutation of omp-ui's own
 * process env, so ordinary sessions keep honoring the user's variable.
 */

const OVERLAY_NAME = "omp-ui-private.yml";

/** Upstream's environment-backed gate on Hindsight passive retention. */
export const HINDSIGHT_AUTO_RETAIN_ENV = "HINDSIGHT_AUTO_RETAIN";

export function privateOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/** Writes the quiet pin, or removes a stale artifact and returns null. */
export function writePrivateOverlay(lineageDir: string, pin: boolean): string | null {
  const file = privateOverlayPath(lineageDir);
  if (pin !== true) {
    removeLineageArtifact(file);
    return null;
  }
  return writeLineageArtifact(
    lineageDir,
    file,
    "autolearn:\n  enabled: false\nmnemopi:\n  autoRetain: false\nhindsight:\n  autoRetain: false\n",
  );
}

/**
 * The child-environment half of the quiet pin (issue #1094):
 * `HINDSIGHT_AUTO_RETAIN=false`, applied ONLY to the spawned omp's
 * environment at spawn time. Upstream reads that variable through the
 * setting handle's env layer, which outranks every config layer — so on a
 * machine where the user exported it true, the overlay alone would lose and
 * a private transcript would ride the `agent_end` retain path anyway. The
 * pin is per-child: omp-ui's own `process.env` is never touched, and an
 * ordinary session's spawn carries no such key, so the user's own value
 * keeps working everywhere else. Returns undefined for an ordinary record —
 * callers merge what they get over the base env, key-last.
 */
export function privateChildEnv(pin: boolean): NodeJS.ProcessEnv | undefined {
  return pin === true ? { [HINDSIGHT_AUTO_RETAIN_ENV]: "false" } : undefined;
}
