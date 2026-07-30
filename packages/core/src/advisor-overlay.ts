import * as fs from "node:fs";
import * as path from "node:path";
import { formatAdvisorRole, type AdvisorRole } from "./omp-config";

/**
 * omp binds the advisor at process start and never re-reads it: editing a
 * config overlay under a live process changes nothing, and `/advisor off; on`
 * rebuilds the runtime from the already-resolved selection (verified against
 * v17.1.8). Nor is there a `set_advisor_model` rpc command or an
 * `--advisor-model` flag — `--advisor=<value>` silently discards the value.
 *
 * So the advisor is spelled the one way omp does honour: a `--config` YAML
 * overlay written into the session's own lineage dir and passed at spawn.
 * Changing it therefore requires a respawn, which the renderer does explicitly
 * rather than pretending the change took effect.
 *
 * The overlay carries the enable flag as well as the model, because omitting
 * `--advisor` does NOT turn the advisor off: the flag only ever sets
 * `advisor.enabled` to true, so a user whose omp config says
 * `advisor.enabled: true` (as omp's own setup writes) would find the composer's
 * "off" silently ignored. Only an overlay can say false.
 */

/** The overlay lives beside the transcript so it dies with the lineage. */
const OVERLAY_NAME = "omp-ui-advisor.yml";

export function advisorOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/**
 * Writes the overlay pinning this session's advisor, and returns the path to
 * pass as `--config` — or null when the session has nothing to say and omp's
 * own config should decide untouched.
 *
 * `role: null` means "whichever model omp resolves", so the overlay simply
 * omits `modelRoles.advisor` — writing `""` there would resolve to no model at
 * all, which is a different and much worse thing.
 */
export function writeAdvisorOverlay(
  lineageDir: string,
  role: AdvisorRole | null,
  /**
   * The session's advisor state. `null` defers to omp's config entirely (used
   * for a session that has never expressed a preference).
   */
  enabled: boolean | null = null,
): string | null {
  const file = advisorOverlayPath(lineageDir);
  const lines: string[] = [];
  if (enabled !== null) lines.push("advisor:", `  enabled: ${enabled ? "true" : "false"}`);
  // A model pin is pointless with the advisor off, and omp would resolve it
  // anyway — but it is harmless and keeps the file a faithful mirror of the
  // record, so a later "on" needs no second write.
  if (role !== null) lines.push("modelRoles:", `  advisor: ${quote(formatAdvisorRole(role))}`);
  if (lines.length === 0) {
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
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
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
