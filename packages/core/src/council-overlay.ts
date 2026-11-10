import * as path from "node:path";
import { writeLineageArtifact, yamlQuote } from "./lineage-artifact";
import { isSafeSelector } from "./subagent-model";

/**
 * The session-scope `--config` overlay for `/council` (ADR-0088), verified
 * against omp 18.16.0.
 *
 * - `async.enabled` and `task.batch` restate omp's rpc defaults: the launch
 *   prompt asks the model for one batch `task` call, and a session that
 *   refused async jobs would silently strand the council.
 * - `task.perCallModel` defaults to `off`, which rejects any task item that
 *   names a model — so a member pinned to a model could never launch. The
 *   overlay turns it `"on"` (quoted, so no YAML 1.1 loader reads a boolean).
 * - omp grants a per-call model only when a chat role in an operator layer
 *   names it, and `--config` is such a layer: one custom role
 *   `omp-ui-council-N` per launched member grants exactly the members'
 *   models, plus `omp-ui-council-trial` for the trial member. Objects
 *   deep-merge across config layers, so the user's own
 *   `modelRoles` survive beside these.
 * - It never writes `task.agentModelOverrides`: the members run as the
 *   dedicated council agent, which no override names, so omp's per-call
 *   override conflict cannot fire, and the subagent overlay (ADR-0031)
 *   stays untouched.
 */

const OVERLAY_NAME = "omp-ui-council.yml";

export function councilOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/**
 * Writes the overlay for `models` (member selectors in launch order) plus the
 * optional `trialModel`, and returns the path to pass as `--config`: one
 * numbered role per council member plus `omp-ui-council-trial` for the trial
 * member. Always writes: with no members the `modelRoles` block is simply
 * omitted. A selector failing `isSafeSelector` throws, because `--config` is a
 * strict loader and one malformed line takes the session down.
 */
export function writeCouncilOverlay(lineageDir: string, models: readonly string[], trialModel: string | null): string {
  const unsafe = [...models, ...(trialModel === null ? [] : [trialModel])].find((model) => !isSafeSelector(model));
  if (unsafe !== undefined) {
    throw new Error(`council overlay: unsafe model selector ${JSON.stringify(unsafe)}`);
  }
  let content = 'async:\n  enabled: true\ntask:\n  batch: true\n  perCallModel: "on"\n';
  if (models.length > 0) {
    content += "modelRoles:\n";
    models.forEach((model, i) => {
      content += `  ${yamlQuote(`omp-ui-council-${i + 1}`)}: ${yamlQuote(model)}\n`;
    });
    // The trial member never launches without a council member, so its grant rides only here.
    if (trialModel !== null) content += `  ${yamlQuote("omp-ui-council-trial")}: ${yamlQuote(trialModel)}\n`;
  }
  return writeLineageArtifact(lineageDir, councilOverlayPath(lineageDir), content);
}
