import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact } from "./lineage-artifact";

/**
 * A private session (issue #852) is pinned write-quiet against the memory
 * system: recall reads, nothing writes. The two *passive* write channels in
 * omp are config-gated — `mnemopi.autoRetain` drives the periodic retain pass
 * and the retain-on-dispose/consolidation path, `autolearn.enabled` drives
 * coding-agent lesson capture — so a per-run `--config` overlay (the
 * ADR-0038 pattern, same as the git-guard pin) closes both without touching
 * the global config.
 *
 * The overlay deliberately never names `memory.backend` or
 * `mnemopi.autoRecall`: absence is what keeps recall alive. Unlike the
 * git-guard pin there is no "explicit user value wins" carve-out — the
 * overlay winning over a user-set `mnemopi.autoRetain: true` is exactly the
 * point of privacy. Binds at process start; every spawn and resume re-derives
 * it from the record.
 */

const OVERLAY_NAME = "omp-ui-private.yml";

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
    "autolearn:\n  enabled: false\nmnemopi:\n  autoRetain: false\n",
  );
}
