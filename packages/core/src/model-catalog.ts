import * as os from "node:os";
import { execOmpConfigRunner, type OmpConfigRunner } from "./omp-settings";
import type { CatalogModelOption, ModelCatalogSnapshot } from "./types";

/**
 * Parse of `omp models --kind chat --json` → picker-ready chat models, in
 * catalog order. Unparseable shapes yield null; rows are dropped unless kind
 * is "chat" and both provider and id are non-empty strings; duplicate
 * `provider/id` pairs collapse to the first; a missing name falls back to id.
 * The row's `thinking` arrives as a bare efforts array and reshapes to
 * `{ efforts }` for ModelInfo compatibility — a non-array drops the key.
 */
export function parseChatModelCatalog(json: unknown): CatalogModelOption[] | null {
  const models = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const options: CatalogModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (row["kind"] !== "chat") continue;
    const provider = row["provider"];
    const id = row["id"];
    if (typeof provider !== "string" || provider === "") continue;
    if (typeof id !== "string" || id === "") continue;
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const option: CatalogModelOption = {
      provider,
      id,
      name: typeof row["name"] === "string" && row["name"] !== "" ? row["name"] : id,
    };
    // Every optional field rides only when well-typed; a garbage row field
    // must not hand ModelPalette a value it would render as NaN or undefined.
    if (typeof row["contextWindow"] === "number") option.contextWindow = row["contextWindow"];
    if (typeof row["maxTokens"] === "number") option.maxTokens = row["maxTokens"];
    if (typeof row["reasoning"] === "boolean") option.reasoning = row["reasoning"];
    if (Array.isArray(row["input"]) && row["input"].every((item) => typeof item === "string")) {
      option.input = row["input"] as string[];
    }
    const cost = row["cost"];
    if (typeof cost === "object" && cost !== null) {
      const c = cost as Record<string, unknown>;
      const picked: NonNullable<CatalogModelOption["cost"]> = {};
      for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        if (typeof c[field] === "number") picked[field] = c[field] as number;
      }
      if (Object.keys(picked).length > 0) option.cost = picked;
    }
    if (Array.isArray(row["thinking"]) && row["thinking"].every((item) => typeof item === "string")) {
      option.thinking = { efforts: row["thinking"] as string[] };
    }
    options.push(option);
  }
  return options;
}

/**
 * The installed omp's chat catalog. Runs under the LIVE process.env exactly
 * like readJudgeModels (the listing can be key-gated, and the user's global
 * config defines further models). Never throws; a failed or unparseable probe
 * yields `discovered: false` with a short reason.
 */
export async function readModelCatalog(
  { ompPath }: { ompPath: string | null },
  run: OmpConfigRunner = execOmpConfigRunner(ompPath ?? ""),
): Promise<ModelCatalogSnapshot> {
  if (ompPath === null) {
    return { models: [], discovered: false, error: "omp binary not found" };
  }
  try {
    const stdout = await run(["models", "--kind", "chat", "--json"], {
      cwd: os.tmpdir(),
      env: process.env,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { models: [], discovered: false, error: "omp did not return a model list" };
    }
    const models = parseChatModelCatalog(parsed);
    return models === null
      ? { models: [], discovered: false, error: "omp did not return a model list" }
      : { models, discovered: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { models: [], discovered: false, error: message.trim() || "omp model probe failed" };
  }
}
