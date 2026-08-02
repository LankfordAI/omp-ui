import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProfile } from "./paths";

/**
 * Reads the two facts omp-ui needs out of omp's own config: whether the advisor
 * is on by default, and which model the `advisor` role is bound to.
 *
 * omp has no runtime surface for either (v17.1.8): `get_state` reports no
 * advisor field, and `/advisor` accepts only on/off/status/dump/configure — no
 * `model` subcommand. So the default has to be read off disk, and a per-session
 * override has to be injected at spawn as a `--config` overlay.
 *
 * The parser is deliberately not a YAML implementation. It reads exactly two
 * shapes out of `config.yml` — `advisor.enabled` and `modelRoles.advisor` —
 * both of which omp writes as a plain nested scalar. Anything it cannot
 * recognise degrades to "unset" rather than throwing: a missing default only
 * costs a neutral toggle, while a thrown error would break tab boot.
 */

/** A `modelRoles.<role>` value: the model plus omp's `:<level>` suffix if present. */
export interface ModelRole {
  /** `provider/model` with any `:<level>` suffix stripped. */
  model: string;
  /** omp's thinking-level suffix (`high`, `low`, …), when the value carried one. */
  level?: string;
}

export interface OmpAdvisorDefaults {
  /** `advisor.enabled` — omp's own schema default is false. */
  enabled: boolean;
  /**
   * `modelRoles.advisor`. Null when unset: omp then resolves the `slow`
   * priority chain in code, and there is no literal for omp-ui to display.
   */
  role: ModelRole | null;
}

/**
 * omp's agent config directory (`~/.omp/agent`, or the active profile's).
 * Mirrors pi-utils `getAgentDir()`; `PI_CODING_AGENT_DIR` applies only to the
 * default profile, exactly as in {@link getSessionsRoot}.
 */
export function getOmpAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const profile = resolveProfile(env);
  const configName = env.PI_CONFIG_DIR || ".omp";
  const configRoot = profile
    ? path.join(os.homedir(), configName, "profiles", profile)
    : path.join(os.homedir(), configName);
  if (!profile && env.PI_CODING_AGENT_DIR) return path.resolve(env.PI_CODING_AGENT_DIR);
  return path.join(configRoot, "agent");
}

/** omp reads `config.yml` first, then `config.yaml` — same order here. */
const CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

/**
 * Splits omp's role selector into model and thinking level. The model id itself
 * may contain colons (OpenRouter's `model:exacto`), and omp's own resolver
 * strips suffixes from the right — so only a final segment that looks like a
 * bare level word is treated as one.
 */
const LEVEL_RE = /^[a-z]+$/;

export function parseModelRole(value: string): ModelRole | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const colon = trimmed.lastIndexOf(":");
  // A colon at the very start or end names no model — take the whole string.
  if (colon > 0 && colon < trimmed.length - 1) {
    const tail = trimmed.slice(colon + 1);
    // `anthropic/claude:high` splits; `openai/gpt:exacto-2` does not (digits).
    if (LEVEL_RE.test(tail)) return { model: trimmed.slice(0, colon), level: tail };
  }
  return { model: trimmed };
}

/** Re-joins a role back into omp's `model[:level]` selector form. */
export function formatModelRole(role: ModelRole): string {
  return role.level === undefined ? role.model : `${role.model}:${role.level}`;
}

/** Strips `#` comments outside quotes and the trailing newline. */
function scalar(raw: string): string {
  let out = "";
  let quote: string | undefined;
  for (const char of raw) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      out += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "#") break;
    out += char;
  }
  const trimmed = out.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Pulls `<parent>:` → `  <key>: <value>` out of a YAML mapping. Only two-level
 * nesting is recognised, which is all omp writes for these keys, and indentation
 * is compared against the parent's so a same-named key under a different parent
 * cannot be mistaken for a hit.
 */
function nestedScalar(text: string, parent: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let parentIndent: number | null = null;
  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (parentIndent !== null) {
      // Dedent to the parent's level or beyond ends the block.
      if (indent <= parentIndent) {
        parentIndent = null;
      } else {
        const body = line.trimStart();
        if (body.startsWith(`${key}:`)) return scalar(body.slice(key.length + 1));
        continue;
      }
    }
    const body = line.trimStart();
    if (indent === 0 && body.startsWith(`${parent}:`)) {
      // `advisor: {enabled: true}` flow style is not emitted by omp; an inline
      // value here means the key is a scalar, not a mapping, so skip it.
      if (scalar(body.slice(parent.length + 1)) !== "") continue;
      parentIndent = indent;
    }
  }
  return undefined;
}

/** The config layers omp merges, lowest priority first; missing files drop out. */
function configLayers(projectCwd: string, env: NodeJS.ProcessEnv): string[] {
  const agentDir = getOmpAgentDir(env);
  const texts: string[] = [];
  for (const name of CONFIG_FILENAMES) {
    const text = readConfigText(path.join(agentDir, name));
    if (text !== null) {
      texts.push(text);
      break; // config.yml wins over config.yaml, as in omp.
    }
  }
  const project = readConfigText(path.join(projectCwd, ".omp", "config.yml"));
  if (project !== null) texts.push(project);
  return texts;
}

function readConfigText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * omp's effective advisor defaults for `projectCwd`: the global agent config,
 * overlaid by the project's `.omp/config.yml` (which wins, matching omp's own
 * layer order).
 */
export function readOmpAdvisorDefaults(
  projectCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): OmpAdvisorDefaults {
  const merged: OmpAdvisorDefaults = { enabled: false, role: null };
  for (const text of configLayers(projectCwd, env)) {
    const enabled = nestedScalar(text, "advisor", "enabled");
    if (enabled === "true") merged.enabled = true;
    else if (enabled === "false") merged.enabled = false;
    const role = nestedScalar(text, "modelRoles", "advisor");
    if (role !== undefined) merged.role = parseModelRole(role);
  }
  return merged;
}

/**
 * The first of `roles` that `projectCwd`'s effective config actually binds —
 * omp's own role-chain semantics, where an earlier role wins and an unset one
 * falls through. Null when the config names none of them, which the caller
 * spells as "let omp resolve its own".
 */
export function readOmpModelRole(
  projectCwd: string,
  roles: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ModelRole | null {
  const layers = configLayers(projectCwd, env);
  for (const role of roles) {
    // Later layers win, so the project's value overrides the global one.
    let resolved: ModelRole | null = null;
    for (const text of layers) {
      const value = nestedScalar(text, "modelRoles", role);
      if (value !== undefined) resolved = parseModelRole(value);
    }
    if (resolved !== null) return resolved;
  }
  return null;
}
