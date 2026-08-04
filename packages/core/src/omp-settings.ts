import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getOmpAgentDir } from "./omp-config";
import { OMP_MODEL_ROLES_KEY, OMP_SETTING_KEYS } from "./omp-settings-keys";
import type {
  OmpSettingEntry,
  OmpSettingLayer,
  OmpSettingsSnapshot,
  OmpSettingType,
  OmpSettingValue,
} from "./types";

/**
 * omp's own settings, as the settings surface's omp page reads and writes them.
 *
 * omp is the only authority on its config: every value, type, description, and
 * validation rule comes out of the `omp config` CLI rather than from parsing
 * YAML here. That keeps this module correct across omp releases (a renamed or
 * dropped setting simply stops appearing) and routes writes through omp's own
 * validator instead of a hand-rolled one. `omp-config.ts` stays a read-only
 * text scraper for the advisor overlay and title/branch model resolution — a
 * different problem with different callers.
 *
 * Layer attribution needs three reads of the same key, because `config list`
 * only ever prints the *effective* value for its cwd and HOME:
 *
 * - in the project cwd → what a session spawned there would see;
 * - in a neutral cwd (no `.omp/`) → the same minus any project layer, i.e. the
 *   global value;
 * - in a neutral cwd under an empty HOME → omp's compiled-in default.
 *
 * Where those three differ places the value on a layer. Every invocation goes
 * through {@link OmpConfigRunner} so tests never spawn a process.
 */

// The allowlist lives in the zero-import omp-settings-keys.ts because the
// renderer bundles it (see that file); re-exported so main-side callers can
// keep importing everything omp-settings from one place.
export {
  OMP_MODEL_ROLE_IDS,
  OMP_MODEL_ROLES_KEY,
  OMP_SETTING_GROUPS,
  OMP_SETTING_KEYS,
} from "./omp-settings-keys";

/** Every key this module will read or write, in the order entries are emitted. */
const ALLOWED_KEYS: readonly string[] = [...OMP_SETTING_KEYS, OMP_MODEL_ROLES_KEY];

/** One omp invocation: resolves stdout, rejects Error(trimmed stderr) on failure. */
export type OmpConfigRunner = (
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<string>;

export const execOmpConfigRunner: (ompPath: string) => OmpConfigRunner =
  (ompPath) => (args, opts) =>
    new Promise((resolve, reject) => {
      execFile(
        ompPath,
        [...args],
        // `config list --json` is ~80 KB today; the raised maxBuffer keeps a
        // future omp with more settings from being silently truncated.
        { cwd: opts.cwd, env: opts.env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // omp's stderr carries the actionable message ("Unknown setting: x",
          // "Invalid value: ... Valid values: ..."), and it is what the
          // settings page shows the user verbatim.
          if (err) reject(new Error(stderr.trim() || err.message));
          else resolve(stdout);
        },
      );
    });

/** One entry of `omp config list --json`. Every field is unvalidated JSON. */
interface RawSetting {
  value?: unknown;
  type?: unknown;
  description?: unknown;
  redacted?: unknown;
}

/** A parsed `--json` map, before any per-key shape check. */
type RawSettings = Record<string, unknown>;

const SETTING_TYPES: Record<OmpSettingType, true> = {
  boolean: true,
  number: true,
  string: true,
  enum: true,
  array: true,
  record: true,
};

/** The type placeholders `omp config list` prints in parens for non-enum settings. */
const TYPE_PLACEHOLDERS: Record<string, true> = {
  boolean: true,
  number: true,
  array: true,
  record: true,
  string: true,
};

/** `advisor.syncBacklog = off (off|1|3|5)` — the key, then the parenthesised tail. */
const LIST_LINE_RE = /^\s*(\S+) = .*\(([^)]*)\)\s*$/;

/**
 * Enum members per key, scraped from the human `omp config list`. The `--json`
 * form carries only value/type/description — it does not list enum members — so
 * this text read is the only source for them. Every requested key is present in
 * the result; null means "not an enum, or omp printed nothing usable", which
 * the page renders as a plain text input.
 */
export function parseEnumOptions(
  text: string,
  keys: readonly string[],
): Record<string, string[] | null> {
  const wanted = new Set(keys);
  const options: Record<string, string[] | null> = {};
  for (const key of keys) options[key] = null;
  for (const line of text.split("\n")) {
    const match = LIST_LINE_RE.exec(line);
    if (match === null) continue;
    const [, key, group] = match;
    if (!wanted.has(key) || TYPE_PLACEHOLDERS[group] === true) continue;
    options[key] = group.split("|");
  }
  return options;
}

function parseListJson(text: string): RawSettings | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as RawSettings;
}

/** The entry omp published for `key`, or null when it published nothing usable. */
function rawSetting(map: RawSettings, key: string): RawSetting | null {
  const entry = map[key];
  return typeof entry === "object" && entry !== null ? (entry as RawSetting) : null;
}

/**
 * Which layer supplies the effective value. Structural equality via JSON so
 * arrays and records (`advisor.subagents`, `modelRoles`) compare by content
 * rather than by identity.
 */
function resolveLayer(effective: unknown, global: unknown, pristine: unknown): OmpSettingLayer {
  if (JSON.stringify(effective) !== JSON.stringify(global)) return "project";
  if (JSON.stringify(global) !== JSON.stringify(pristine)) return "global";
  return "default";
}

/**
 * Deletes temp dirs without ever throwing. Cleanup runs in a `finally`, where a
 * throw would escape the enclosing catch and break this module's contract:
 * readOmpSettings never throws, and writeOmpSetting only ever surfaces omp's
 * own message. A leaked temp dir beats masking either.
 */
function removeTempDirs(...dirs: (string | null)[]): void {
  for (const dir of dirs) {
    if (dir === null) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* empty */
    }
  }
}

/**
 * The allowlisted omp settings as they apply to `projectCwd`, each value
 * attributed to the layer that supplies it.
 *
 * Never throws: the settings surface must open even with omp absent, broken, or
 * printing something unparseable — the page then shows `error` instead of
 * values it cannot vouch for. `agentDir` comes from {@link getOmpAgentDir}
 * rather than from `omp config path`, which merely prints the same thing.
 */
export async function readOmpSettings(
  { ompPath, projectCwd }: { ompPath: string | null; projectCwd: string | null },
  // ompPath is null-guarded below before `run` is ever reached, so the runner
  // built from the empty fallback path can never be invoked.
  run: OmpConfigRunner = execOmpConfigRunner(ompPath ?? ""),
): Promise<OmpSettingsSnapshot> {
  if (ompPath === null) {
    return { entries: [], agentDir: null, projectConfigPath: null, error: "omp binary not found" };
  }
  const configFile = projectCwd === null ? null : path.join(projectCwd, ".omp", "config.yml");
  const projectConfigPath = configFile !== null && fs.existsSync(configFile) ? configFile : null;
  /** A read that produced no trustworthy values still reports where it looked. */
  const failed = (error: string): OmpSettingsSnapshot => ({
    entries: [],
    agentDir: getOmpAgentDir(),
    projectConfigPath,
    error,
  });

  let neutralCwd: string | null = null;
  let pristineHome: string | null = null;
  try {
    // A cwd with no `.omp/` strips the project layer; an empty HOME strips the
    // user's global config, leaving omp's compiled-in defaults.
    neutralCwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cfg-"));
    pristineHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cfg-"));
    const listJson = ["config", "list", "--json"];
    const [effectiveRead, globalRead, pristineRead, humanRead] = await Promise.allSettled([
      // Skipped without a project: the global read is then the effective one.
      projectCwd === null
        ? Promise.resolve(null)
        : run(listJson, { cwd: projectCwd, env: process.env }),
      run(listJson, { cwd: neutralCwd, env: process.env }),
      run(listJson, { cwd: neutralCwd, env: { ...process.env, HOME: pristineHome } }),
      run(["config", "list"], { cwd: neutralCwd, env: process.env }),
    ]);

    // The three value reads are all-or-nothing: without all of them neither a
    // value nor a layer badge is trustworthy, so the page shows the error
    // instead. humanRead only supplies enum members, so its failure merely
    // flattens those to text inputs — type still comes from globalRead, and
    // nothing is mislabelled.
    if (effectiveRead.status === "rejected") return failed(errorMessage(effectiveRead.reason));
    if (globalRead.status === "rejected") return failed(errorMessage(globalRead.reason));
    if (pristineRead.status === "rejected") return failed(errorMessage(pristineRead.reason));

    const globalMap = parseListJson(globalRead.value);
    const pristineMap = parseListJson(pristineRead.value);
    const effectiveMap =
      effectiveRead.value === null ? globalMap : parseListJson(effectiveRead.value);
    if (globalMap === null || pristineMap === null || effectiveMap === null) {
      return failed("could not parse omp config output");
    }

    const options = parseEnumOptions(
      humanRead.status === "fulfilled" ? humanRead.value : "",
      ALLOWED_KEYS,
    );

    const entries: OmpSettingEntry[] = [];
    for (const key of ALLOWED_KEYS) {
      const schema = rawSetting(globalMap, key);
      // A future omp may drop a key: the page must not offer one omp would
      // reject. Redacted entries are credentials and never render here.
      if (schema === null || schema.redacted === true) continue;
      const effective = rawSetting(effectiveMap, key)?.value;
      entries.push({
        key,
        // omp may grow a type we do not model; text input is the safe fallback.
        type: isSettingType(schema.type) ? schema.type : "string",
        description: typeof schema.description === "string" ? schema.description : "",
        // omp's own schema is the authority on the shape behind each key.
        value: effective as OmpSettingValue | undefined,
        options: options[key] ?? null,
        layer: resolveLayer(effective, schema.value, rawSetting(pristineMap, key)?.value),
      });
    }
    return { entries, agentDir: getOmpAgentDir(), projectConfigPath, error: null };
  } catch (err) {
    return failed(errorMessage(err));
  } finally {
    removeTempDirs(neutralCwd, pristineHome);
  }
}

function isSettingType(value: unknown): value is OmpSettingType {
  return typeof value === "string" && SETTING_TYPES[value as OmpSettingType] === true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Writes one allowlisted setting to omp's GLOBAL layer via `omp config set`,
 * letting omp validate it. The runner's rejection propagates unchanged — its
 * message is already omp's own trimmed stderr.
 *
 * `modelRoles` is REPLACE-not-merge (verified: setting `{"advisor":"NEW/adv"}`
 * over a config holding default/advisor/tiny left only advisor), so callers
 * must send the full merged record, never just the role they edited.
 */
export async function writeOmpSetting(
  { ompPath, key, value }: { ompPath: string | null; key: string; value: OmpSettingValue },
  // Both guards below reject before `run` is reached, so the runner built from
  // the empty fallback path can never be invoked.
  run: OmpConfigRunner = execOmpConfigRunner(ompPath ?? ""),
): Promise<void> {
  if (ompPath === null) throw new Error("omp binary not found");
  // The allowlist is a security boundary, not UI curation: nothing outside it
  // may reach `omp config set`, so this rejects before anything is spawned and
  // before any temp dir exists.
  if (!ALLOWED_KEYS.includes(key)) {
    throw new Error(`refusing to write unlisted omp setting: ${key}`);
  }
  // omp takes scalars verbatim and structured values as JSON text.
  const serialized =
    typeof value === "string"
      ? value
      : typeof value === "boolean" || typeof value === "number"
        ? String(value)
        : JSON.stringify(value);
  // `config set` always targets the global layer regardless of cwd (verified,
  // even under `modelRoleStorage: project`); the neutral cwd only keeps the
  // call independent of whatever project layer happens to be around.
  const neutralCwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cfg-"));
  try {
    await run(["config", "set", key, serialized, "--json"], {
      cwd: neutralCwd,
      env: process.env,
    });
  } finally {
    removeTempDirs(neutralCwd);
  }
}
