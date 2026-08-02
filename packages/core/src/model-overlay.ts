import * as fs from "node:fs";
import * as path from "node:path";
import { formatModelRole, type ModelRole } from "./omp-config";

/**
 * omp resolves `modelRoles.default` once, at process start, and there is no
 * `set_model`-at-boot guarantee before the first turn — so the only reliable
 * way to make a new session boot with the model the user most recently chose
 * is the same mechanism the advisor uses: a `--config` YAML overlay written
 * into the session's own lineage dir and passed at spawn.
 *
 * Unlike the advisor, the main model is changeable in-process, so this is a
 * spawn-time preference only, never a relaunch: a *new* session inherits the
 * remembered model; a resumed one already carries its own model in the
 * transcript and gets no overlay.
 */

/** The overlay lives beside the transcript so it dies with the lineage. */
const OVERLAY_NAME = "omp-ui-model.yml";

export function modelOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/**
 * Writes the overlay pinning this session's spawn-time default model, and
 * returns the path to pass as `--config` — or null when there is nothing to
 * pin and omp's own `modelRoles.default` should decide untouched.
 *
 * `role: null` means "whichever model omp resolves", so the overlay is simply
 * not written — there is no "default model" literal to pin.
 */
export function writeDefaultModelOverlay(
  lineageDir: string,
  role: ModelRole | null,
): string | null {
  if (role === null) {
    try {
      fs.rmSync(modelOverlayPath(lineageDir));
    } catch {
      // Never written, or already gone — either way there is no overlay.
    }
    return null;
  }
  const file = modelOverlayPath(lineageDir);
  // `--config` is a strict loader in omp: a malformed or missing overlay is a
  // hard startup error, so the write must land before spawn, not lazily.
  fs.mkdirSync(lineageDir, { recursive: true });
  fs.writeFileSync(
    file,
    `modelRoles:\n  default: ${quote(formatModelRole(role))}\n`,
    "utf8",
  );
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
