import * as path from "node:path";
import { writeLineageArtifact, yamlQuote } from "./lineage-artifact";
import { formatModelRole, type ModelRole } from "./omp-config";

/**
 * omp resolves `modelRoles.default` from its settings layers, and there is no
 * `set_model`-at-boot guarantee before the first turn — so the only reliable
 * way to make a session boot with the model the user most recently chose is
 * the same mechanism the advisor uses: a `--config` YAML overlay written into
 * the session's own lineage dir and passed at spawn.
 *
 * The overlay is written on every spawn and rewritten in place on every
 * in-session model change: subagent `"*"` entries resolve through
 * `modelRoles.default` (not the parent's live model), `set_model` never
 * persists the role, and omp re-reads every `--config` overlay before each
 * subagent spawn — so the file must follow the session's current model
 * (#881). When nothing is pinned the content is an empty mapping, so the path
 * the live process was given never disappears under it. A `--model` boot
 * (spawn gate, #774 recovery pick) puts the role in omp's overrides layer,
 * which shadows this file for that process's lifetime.
 */

/** The overlay lives beside the transcript so it dies with the lineage. */
const OVERLAY_NAME = "omp-ui-model.yml";

export function modelOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/**
 * Writes the overlay pinning this session's default model, and returns the
 * path to pass as `--config`.
 *
 * `role: null` means "whichever model omp resolves", so the model block is
 * simply not written — there is no "default model" literal to pin. With
 * nothing to write the file holds `{}`, never absent: omp reloads every
 * `--config` path strictly before each subagent spawn and throws on a missing
 * one (#881).
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
): string {
  const modelBlock =
    role === null
      ? ""
      : `modelRoles:\n  default: ${yamlQuote(formatModelRole(role))}\n`;
  const autoBlock = autoThinking ? 'defaultThinkingLevel: "auto"\n' : "";
  return writeLineageArtifact(
    lineageDir,
    modelOverlayPath(lineageDir),
    modelBlock + autoBlock || "{}\n",
  );
}

