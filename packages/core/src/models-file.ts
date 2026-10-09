import * as fs from "node:fs";
import * as path from "node:path";
import { getOmpAgentDir, scalar } from "./omp-config";

/**
 * Reads the model providers omp would actually use out of its `models.yml`,
 * so the fresh-spawn gate and the provider checklist stop false-negatives on
 * configurations that live entirely in that file (issue #814) — a LiteLLM
 * gateway with an inline `apiKey`, a local vLLM/Ollama endpoint with only a
 * `baseUrl`, or an `apiKeyEnv` naming an exported variable.
 *
 * Like `omp-config.ts`, the parser is deliberately not a YAML implementation:
 * it recognises exactly the three-level `providers: <id>: <key>: value` shape
 * and degrades to "not configured" on anything else rather than throwing — a
 * misread costs a neutral gate answer, a thrown error would break spawn.
 * Nothing beyond provider ids ever leaves this module: `apiKey` values are
 * consumed only as a present/absent boolean, and `baseUrl` values not at all.
 */

/** Providers in omp's models.yml that are configured well enough to spawn with:
 *  a non-empty inline apiKey, an apiKeyEnv naming a variable set in env, or a
 *  non-empty baseUrl with no key (local vLLM/Ollama-style endpoints). Ids only —
 *  never credential material, never the baseUrl. */
export function readModelsFileModelProviders(
  env: NodeJS.ProcessEnv = process.env,
  agentDir: string = getOmpAgentDir(env),
): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(agentDir, "models.yml"), "utf8");
  } catch {
    return [];
  }
  return parseModelsFileProviders(text, env);
}

/** Pure half: ids in file order, deduped, given the file text. Exported for tests. */
export function parseModelsFileProviders(
  text: string,
  env: NodeJS.ProcessEnv,
): string[] {
  // id → usable-so-far, in first-appearance order.
  const providers = new Map<string, boolean>();

  const lines = text.split(/\r?\n/);
  // Indent of the open `providers:` line; null outside its block.
  let blockIndent: number | null = null;
  // Indent of the current provider id (d1) and of its keys (d2); null until
  // the first child of each level is seen, and outside a provider subtree.
  let providerIndent: number | null = null;
  let keyIndent: number | null = null;
  let currentId: string | null = null;
  // The d2 keys decide usability when the provider closes. Presence and
  // resolution are tracked apart: a listed-but-unset apiKeyEnv marks the
  // provider as key-managed, so it never falls back to the keyless-baseUrl
  // rule (the gateway is not a local endpoint with a missing env var).
  let sawApiKey = false;
  let sawApiKeyEnv = false;
  let sawApiKeyEnvSet = false;
  let sawBaseUrl = false;
  const flush = (): void => {
    if (currentId !== null) {
      const previous = providers.get(currentId) ?? false;
      providers.set(
        currentId,
        previous ||
          sawApiKey ||
          sawApiKeyEnvSet ||
          (sawBaseUrl && !sawApiKey && !sawApiKeyEnv),
      );
    }
    currentId = null;
    keyIndent = null;
    sawApiKey = false;
    sawApiKeyEnv = false;
    sawApiKeyEnvSet = false;
    sawBaseUrl = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    // Blank and comment-only lines never open, close, or re-shape a block.
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent === null) {
      if (indent !== 0) continue;
      const body = line.trimStart();
      if (!body.startsWith("providers:")) continue;
      // `providers: {}` flow style / a scalar value is not a mapping block.
      if (scalar(body.slice("providers:".length)) !== "") continue;
      blockIndent = indent;
      providerIndent = null;
      continue;
    }
    // A dedent to the block's own level or beyond ends it; the line then gets
    // one more look as a top-level key (a later `providers:` reopens below).
    if (indent <= blockIndent) {
      flush();
      providerIndent = null;
      blockIndent = null;
      const body = line.trimStart();
      if (indent === 0 && body.startsWith("providers:")) {
        if (scalar(body.slice("providers:".length)) === "") {
          blockIndent = indent;
          providerIndent = null;
        }
      }
      continue;
    }
    const body = line.trimStart();
    const colon = body.indexOf(":");
    if (colon < 0) continue;
    if (providerIndent === null || indent <= providerIndent) {
      // A provider id (first child, or a dedent back to the id level: a
      // sibling id closes the previous provider's subtree).
      flush();
      providerIndent = indent;
      currentId = scalar(body.slice(0, colon));
      if (currentId === "") currentId = null;
      continue;
    }
    // Inside a provider: only keys at the established child indent d2 decide
    // usability. Anything deeper (`models:` items, `modelOverrides.*`,
    // `discovery:`, `compat:`) is never a credential signal — an `apiKey`
    // under an override must not count twice or land on the wrong provider.
    if (currentId === null) continue;
    if (keyIndent === null || indent === keyIndent) {
      if (keyIndent === null) keyIndent = indent;
      const key = body.slice(0, colon).trim();
      const value = scalar(body.slice(colon + 1));
      if (key === "apiKey" && value !== "") {
        sawApiKey = true;
      } else if (key === "apiKeyEnv" && value !== "") {
        sawApiKeyEnv = true;
        if ((env[value] ?? "").length > 0) sawApiKeyEnvSet = true;
      } else if (key === "baseUrl" && value !== "") {
        sawBaseUrl = true;
      }
    }
  }
  flush();

  const ids: string[] = [];
  for (const [id, usable] of providers) if (usable) ids.push(id);
  return ids;
}
