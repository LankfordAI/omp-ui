import * as os from "node:os";
import { execOmpConfigRunner, type OmpConfigRunner } from "./omp-settings";
import type { SttModelOption, SttModelSnapshot } from "./types";

/**
 * Providers omp-ui can call directly for transcription, selector prefix → route.
 * omp-ui posts a multipart WAV to `${base}/audio/transcriptions` (the
 * OpenAI-compatible route, which OpenRouter also serves — issue #647).
 */
export const STT_ROUTES: Readonly<Record<string, { base: string; env: string }>> = {
  openrouter: { base: "https://openrouter.ai/api/v1", env: "OPENROUTER_API_KEY" },
  openai: { base: "https://api.openai.com/v1", env: "OPENAI_API_KEY" },
};

/**
 * "openrouter/openai/whisper-large-v3" → { provider: "openrouter", model:
 * "openai/whisper-large-v3" }. A selector with a slash-bearing model slug keeps
 * everything after the first segment as the model — that slug is exactly what
 * the provider's transcriptions endpoint names. null when the provider prefix
 * routes nowhere omp-ui can post (including omp's "local" sherpa-onnx group,
 * which runs in-process inside omp with no endpoint — ADR-0034).
 */
export function parseSttSelector(
  selector: string,
): { provider: string; model: string } | null {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) return null;
  const provider = selector.slice(0, slash);
  const route = STT_ROUTES[provider];
  if (route === undefined) return null;
  return { provider, model: selector.slice(slash + 1) };
}

/**
 * Discovery order for `sttModel === null`; the first callable row wins, then
 * any callable row in catalog order.
 */
export const STT_PREFERENCE = [
  "openrouter/openai/whisper-large-v3-turbo",
  "openrouter/openai/whisper-large-v3",
  "openrouter/openai/gpt-4o-transcribe",
] as const;

/** The selector a null `sttModel` resolves to; null when nothing is callable. */
export function resolveSttSelector(models: readonly SttModelOption[]): string | null {
  for (const selector of STT_PREFERENCE) {
    const row = models.find((m) => m.selector === selector && m.callable);
    if (row !== undefined) return row.selector;
  }
  return models.find((m) => m.callable)?.selector ?? null;
}

/**
 * Parse of `omp models --kind stt --json` → dictation options. Unparseable
 * shapes yield null; well-formed rows missing their selector are dropped.
 * omp's "local" rows are dropped: sherpa-onnx runs them in-process inside omp
 * with no endpoint omp-ui could post to (ADR-0034).
 */
export function parseSttModelCatalog(
  json: unknown,
  hasCredential: (env: string) => boolean,
): SttModelOption[] | null {
  const models = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const options: SttModelOption[] = [];
  for (const raw of models) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (row["kind"] !== "stt") continue;
    const provider = row["provider"];
    const selector = row["selector"];
    if (typeof provider !== "string" || typeof selector !== "string" || selector === "") continue;
    // local/* = omp's in-process sherpa-onnx models — no HTTP endpoint exists
    // for omp-ui to reach (ADR-0034; see also ADR-0007 on omp TUI paths).
    if (provider === "local") continue;
    const route = STT_ROUTES[provider];
    const name = typeof row["name"] === "string" && row["name"] !== "" ? row["name"] : selector;
    options.push({
      selector,
      provider,
      name,
      callable: route !== undefined && hasCredential(route.env),
    });
  }
  return options;
}

/**
 * The installed omp's STT catalog, every row marked callable per the
 * credentials this process holds. Deliberate difference from the web-search
 * probe: this one runs under the LIVE `process.env`, not a pristine one — the
 * catalog is key-gated (verified on v18.2.11: `openai` rows appear only with
 * OPENAI_API_KEY), and the key omp-ui will actually call with is the one
 * `ProviderKeys.applyToProcessEnv` installed. Never throws; a failed or
 * unparseable probe yields `discovered: false` with a short reason.
 */
export async function readSttModels(
  { ompPath }: { ompPath: string | null },
  run: OmpConfigRunner = execOmpConfigRunner(ompPath ?? ""),
): Promise<SttModelSnapshot> {
  if (ompPath === null) {
    return { models: [], discovered: false, error: "omp binary not found" };
  }
  try {
    const stdout = await run(["models", "--kind", "stt", "--json"], {
      cwd: os.tmpdir(),
      env: process.env,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { models: [], discovered: false, error: "omp did not return a model list" };
    }
    const models = parseSttModelCatalog(parsed, (env) => {
      const value = process.env[env];
      return typeof value === "string" && value !== "";
    });
    return models === null
      ? { models: [], discovered: false, error: "omp did not return a model list" }
      : { models, discovered: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { models: [], discovered: false, error: message.trim() || "omp model probe failed" };
  }
}
