import * as os from "node:os";
import { execOmpConfigRunner, type OmpConfigRunner } from "./omp-settings";
import type { JudgeModelOption, JudgeModelSnapshot } from "./types";

/**
 * Parse of `omp models --kind judge --json` → judge-role options, in catalog
 * order. Unparseable shapes yield null; rows are dropped unless kind is
 * "judge" and selector is a non-empty string; duplicate selectors collapse to
 * the first. Unlike the STT parser, `local` rows stay: omp itself calls the
 * judgment APIs, so anything it lists is usable. A selector is OPAQUE here and
 * everywhere downstream — never run it through parseModelRole; the trailing
 * `:word` of a judgment selector is part of the model id, not a thinking
 * level (the webSearchRoleSelection no-level-stripping precedent, issue #669).
 */
export function parseJudgeModelCatalog(json: unknown): JudgeModelOption[] | null {
  const models = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const options: JudgeModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (row["kind"] !== "judge") continue;
    const selector = row["selector"];
    if (typeof selector !== "string" || selector === "") continue;
    if (seen.has(selector)) continue;
    seen.add(selector);
    const name = typeof row["name"] === "string" && row["name"] !== "" ? row["name"] : selector;
    options.push({ selector, name });
  }
  return options;
}

/**
 * The installed omp's judge catalog. Runs under the LIVE process.env exactly
 * like readSttModels (the listing can be key-gated, and the user's global
 * config defines further judge models). Never throws; a failed or unparseable
 * probe yields `discovered: false` with a short reason.
 */
export async function readJudgeModels(
  { ompPath }: { ompPath: string | null },
  run: OmpConfigRunner = execOmpConfigRunner(ompPath ?? ""),
): Promise<JudgeModelSnapshot> {
  if (ompPath === null) {
    return { models: [], discovered: false, error: "omp binary not found" };
  }
  try {
    const stdout = await run(["models", "--kind", "judge", "--json"], {
      cwd: os.tmpdir(),
      env: process.env,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { models: [], discovered: false, error: "omp did not return a model list" };
    }
    const models = parseJudgeModelCatalog(parsed);
    return models === null
      ? { models: [], discovered: false, error: "omp did not return a model list" }
      : { models, discovered: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { models: [], discovered: false, error: message.trim() || "omp model probe failed" };
  }
}
