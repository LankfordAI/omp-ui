import * as fs from "node:fs";
import * as path from "node:path";
import { formatAdvisorRole, type AdvisorRole } from "./omp-config";

/**
 * omp binds the `advisor` role at process start and never re-reads it: editing
 * a config overlay under a live process changes nothing, and `/advisor off; on`
 * rebuilds the runtime from the already-resolved selection (verified against
 * v17.1.8). Nor is there a `set_advisor_model` rpc command or an
 * `--advisor-model` flag — `--advisor=<value>` silently discards the value.
 *
 * So a per-session advisor model is spelled the one way omp does honour: a
 * `--config` YAML overlay written into the session's own lineage dir and passed
 * at spawn. Choosing a different model therefore requires a respawn, which the
 * renderer does explicitly rather than pretending the change took effect.
 */

/** The overlay lives beside the transcript so it dies with the lineage. */
const OVERLAY_NAME = "omp-ui-advisor.yml";

export function advisorOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/**
 * Writes (or removes) the overlay pinning `modelRoles.advisor`, and returns the
 * path to pass as `--config`, or null when there is nothing to override.
 *
 * A null `role` means "use whatever omp's own config resolves", which is the
 * absence of an overlay — not an empty one, because an overlay setting the role
 * to `""` would resolve to no model at all.
 */
export function writeAdvisorOverlay(lineageDir: string, role: AdvisorRole | null): string | null {
  const file = advisorOverlayPath(lineageDir);
  if (role === null) {
    try {
      fs.rmSync(file);
    } catch {
      // Never written, or already gone — either way there is no overlay.
    }
    return null;
  }
  // `--config` is a strict loader in omp: a malformed or missing overlay is a
  // hard startup error, so the write must land before spawn, not lazily.
  fs.mkdirSync(lineageDir, { recursive: true });
  fs.writeFileSync(file, `modelRoles:\n  advisor: ${quote(formatAdvisorRole(role))}\n`, "utf8");
  return file;
}

/**
 * Model ids are `provider/model[:level]` — no YAML metacharacters in practice,
 * but the value is user-selected, so it is quoted rather than trusted. Double
 * quotes with backslash escaping is the one YAML string form that can carry
 * anything.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
