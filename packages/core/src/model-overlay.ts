import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact, yamlQuote } from "./lineage-artifact";
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
 * `role: null` means "whichever model omp resolves", so the model block is
 * simply not written — there is no "default model" literal to pin.
 *
 * `autoThinking` selects omp's automatic per-prompt thinking classifier via
 * the settings key `defaultThinkingLevel: "auto"` — omp's `model:level`
 * suffix grammar does NOT include `auto`, so the role's selector string must
 * never carry one (callers strip it). With `role: null`, the overlay carries
 * the settings key alone: the user picked auto without pinning a model.
 */
export function writeDefaultModelOverlay(
  lineageDir: string,
  role: ModelRole | null,
  autoThinking = false,
): string | null {
  const file = modelOverlayPath(lineageDir);
  if (role === null && !autoThinking) {
    removeLineageArtifact(file);
    return null;
  }
  const modelBlock =
    role === null
      ? ""
      : `modelRoles:\n  default: ${yamlQuote(formatModelRole(role))}\n`;
  const autoBlock = autoThinking ? 'defaultThinkingLevel: "auto"\n' : "";
  return writeLineageArtifact(lineageDir, file, modelBlock + autoBlock);
}

