import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getOmpAgentDir } from "./omp-config";
import type {
  McpServerEntry,
  McpServerSource,
  McpServersResult,
  McpSetEnabledRequest,
} from "./types";

/**
 * Resolves the MCP servers omp would load for a project, and toggles them with
 * omp's own write algorithm. Two surfaces, one module:
 *
 * - {@link resolveMcpServers} walks the discovery providers omp consults
 *   (native `.omp/mcp.json` first, then translated tool configs — claude,
 *   gemini, opencode, cursor, windsurf, vscode — then the root `mcp.json`
 *   fallback) in omp's priority order. First definition by name wins; a
 *   same-named lower-priority entry still renders, marked `shadowedBy`, because
 *   a *disabled* winner still suppresses the loser (suppression, not dedup).
 *   omp's extension packages, claude marketplace plugins, and codex TOML are
 *   not read — servers sourced only there do not appear.
 *
 * - {@link setMcpServerEnabled} flips one server's enabled state. Global
 *   scope (`projectCwd: null`) is a port of omp's `setMcpServerEnabled`
 *   (src/mcp/config-writer.ts): writable sources (native, root mcp.json) get
 *   the `enabled` flag written back in place; tool-owned files are NEVER
 *   mutated — toggling those servers goes through the user-level
 *   `disabledServers`/`enabledServers` lists in the agent dir's `mcp.json`.
 *   Project scope deliberately diverges: a toggle writes ONLY inside the
 *   project (its own writable file, or a secret-free suppression entry in
 *   `.omp/mcp.json`), never user-level state — see
 *   {@link setProjectServerEnabled}.
 *
 * Redaction is a boundary rule, not a display choice: the DTO never carries
 * `env`, `headers`, `auth`, or `oauth` values, and http/sse endpoints are
 * stripped to origin + pathname. omp has no MCP RPC verbs, so this is a
 * config-effective view only — changes take effect on session (re)spawn.
 */

/** omp's own `$schema` default for mcp.json files (mcp/types.ts). */
const MCP_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/** The loosest shape we honour in any provider file; unrelated keys survive writes. */
type RawServer = Record<string, unknown>;

interface McpConfigFile {
  $schema?: string;
  mcpServers?: Record<string, RawServer>;
  disabledServers?: string[];
  enabledServers?: string[];
  [key: string]: unknown;
}

/* ------------------------------------------------------------- resolution */

type Scope = "project" | "user";

interface ProviderFile {
  provider: McpServerSource;
  scope: Scope;
  path: string;
  /** Only native and root mcp.json files may be written back in place. */
  writable: boolean;
  /**
   * The name→config maps this file contributes, in priority order. Almost
   * every file has exactly one (`mcpServers`); `~/.claude.json` carries the
   * global map plus a per-project one, and opencode nests under `mcp`.
   */
  maps: (root: RawServer, projectCwd: string | null) => unknown[];
}

function asRecord(value: unknown): RawServer | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawServer)
    : undefined;
}

/** `root.mcpServers` — the map shape every mcp.json-flavoured file shares. */
const mcpServersMap = (root: RawServer): unknown[] => [root.mcpServers];

/** The provider table, in omp's enumeration order (first definition wins). */
function providerFiles(projectCwd: string | null, env: NodeJS.ProcessEnv): ProviderFile[] {
  const home = env.HOME ?? os.homedir();
  const xdg = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const agentDir = getOmpAgentDir(env);

  const userNative = [
    { provider: "native", scope: "user", path: path.join(agentDir, "mcp.json"), writable: true, maps: mcpServersMap },
    { provider: "native", scope: "user", path: path.join(agentDir, ".mcp.json"), writable: true, maps: mcpServersMap },
  ] as const;
  // ~/.claude.json carries the global map plus a per-project one; global mode
  // contributes only the global map.
  const userClaudeJson: ProviderFile = {
    provider: "claude",
    scope: "user",
    path: path.join(home, ".claude.json"),
    writable: false,
    maps: (root: RawServer, cwd: string | null): unknown[] =>
      cwd === null
        ? [root.mcpServers]
        : [root.mcpServers, asRecord(asRecord(root.projects)?.[cwd])?.mcpServers],
  };

  if (projectCwd === null) {
    return [
      userNative[0],
      userNative[1],
      { provider: "claude", scope: "user", path: path.join(home, ".claude", "mcp.json"), writable: false, maps: mcpServersMap },
      userClaudeJson,
      { provider: "gemini", scope: "user", path: path.join(home, ".gemini", "settings.json"), writable: false, maps: mcpServersMap },
      { provider: "opencode", scope: "user", path: path.join(xdg, "opencode", "opencode.json"), writable: false, maps: (root) => [root.mcp] },
      { provider: "cursor", scope: "user", path: path.join(home, ".cursor", "mcp.json"), writable: false, maps: mcpServersMap },
      { provider: "windsurf", scope: "user", path: path.join(home, ".codeium", "windsurf", "mcp_config.json"), writable: false, maps: mcpServersMap },
    ];
  }

  return [
    // native — omp's own files; project enumerates before user (project wins).
    { provider: "native", scope: "project", path: path.join(projectCwd, ".omp", "mcp.json"), writable: true, maps: mcpServersMap },
    { provider: "native", scope: "project", path: path.join(projectCwd, ".omp", ".mcp.json"), writable: true, maps: mcpServersMap },
    userNative[0],
    userNative[1],
    // claude — translated providers enumerate user files before project files.
    { provider: "claude", scope: "user", path: path.join(home, ".claude", "mcp.json"), writable: false, maps: mcpServersMap },
    userClaudeJson,
    { provider: "claude", scope: "project", path: path.join(projectCwd, ".claude", "mcp.json"), writable: false, maps: mcpServersMap },
    { provider: "claude", scope: "project", path: path.join(projectCwd, ".claude", ".mcp.json"), writable: false, maps: mcpServersMap },
    // gemini — settings.json carries the mcpServers key.
    { provider: "gemini", scope: "user", path: path.join(home, ".gemini", "settings.json"), writable: false, maps: mcpServersMap },
    { provider: "gemini", scope: "project", path: path.join(projectCwd, ".gemini", "settings.json"), writable: false, maps: mcpServersMap },
    // opencode — the `mcp` key, in its own shape (mapped in normalizeServer).
    { provider: "opencode", scope: "user", path: path.join(xdg, "opencode", "opencode.json"), writable: false, maps: (root) => [root.mcp] },
    { provider: "opencode", scope: "project", path: path.join(projectCwd, "opencode.json"), writable: false, maps: (root) => [root.mcp] },
    // cursor / windsurf / vscode.
    { provider: "cursor", scope: "user", path: path.join(home, ".cursor", "mcp.json"), writable: false, maps: mcpServersMap },
    { provider: "cursor", scope: "project", path: path.join(projectCwd, ".cursor", "mcp.json"), writable: false, maps: mcpServersMap },
    { provider: "windsurf", scope: "user", path: path.join(home, ".codeium", "windsurf", "mcp_config.json"), writable: false, maps: mcpServersMap },
    { provider: "windsurf", scope: "project", path: path.join(projectCwd, ".windsurf", "mcp_config.json"), writable: false, maps: mcpServersMap },
    { provider: "vscode", scope: "project", path: path.join(projectCwd, ".vscode", "mcp.json"), writable: false, maps: mcpServersMap },
    // Root mcp.json fallback — lowest priority, but writable like native.
    { provider: "mcp-json", scope: "project", path: path.join(projectCwd, "mcp.json"), writable: true, maps: mcpServersMap },
    { provider: "mcp-json", scope: "project", path: path.join(projectCwd, ".mcp.json"), writable: true, maps: mcpServersMap },
  ];
}

/**
 * An http/sse endpoint safe to show: origin + pathname only. Userinfo, query
 * string, and hash all can carry tokens. An unparseable URL is cut at `?` and
 * stripped of any `user@` prefix rather than trusted.
 */
function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    const noQuery = raw.split(/[?#]/, 1)[0] ?? "";
    return noQuery.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, "$1");
  }
}

interface NormalizedServer {
  transport: McpServerEntry["transport"];
  endpoint: string;
  /** The raw `enabled` flag; undefined means the file said nothing (= on). */
  enabled: boolean | undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

/** The transport identity of one raw entry, before redaction. */
interface TransportFacts {
  transport: McpServerEntry["transport"];
  command: string | undefined;
  args: string[] | undefined;
  url: string | undefined;
}

/**
 * Extracts one file's server entry down to its transport identity. opencode's
 * `mcp` map has its own shape (`type: "local"|"remote"`, `command`
 * string|array, `environment`); everything else is mcp.json-shaped.
 * Transport inference mirrors omp's `convertToLegacyConfig`:
 * `type` field, else `command` → stdio, `url` → http, else stdio.
 */
function extractTransport(provider: McpServerSource, raw: RawServer): TransportFacts {
  const type = typeof raw.type === "string" ? raw.type : undefined;
  let command: string | undefined;
  let args: string[] | undefined;
  let url: string | undefined;
  let transport: McpServerEntry["transport"] | undefined;

  if (provider === "opencode") {
    if (type === "local") transport = "stdio";
    else if (type === "remote") transport = "http";
    // opencode lets `command` be the whole argv; a separate `args` appends.
    const rawCommand = raw.command;
    if (Array.isArray(rawCommand)) {
      const argv = stringArray(rawCommand) ?? [];
      command = argv[0];
      const merged = [...argv.slice(1), ...(stringArray(raw.args) ?? [])];
      args = merged.length > 0 ? merged : undefined;
    } else {
      command = typeof rawCommand === "string" ? rawCommand : undefined;
      args = stringArray(raw.args);
    }
    url = typeof raw.url === "string" ? raw.url : undefined;
  } else {
    if (type === "stdio" || type === "http" || type === "sse") transport = type;
    command = typeof raw.command === "string" ? raw.command : undefined;
    args = stringArray(raw.args);
    url = typeof raw.url === "string" ? raw.url : undefined;
  }

  transport = transport ?? (command !== undefined ? "stdio" : url !== undefined ? "http" : "stdio");
  return { transport, command, args, url };
}

/**
 * Folds one file's server entry down to the three redacted facts the DTO
 * carries (see {@link extractTransport} for the shape handling).
 */
function normalizeServer(provider: McpServerSource, raw: RawServer): NormalizedServer {
  const { transport, command, args, url } = extractTransport(provider, raw);
  const endpoint =
    transport === "stdio"
      ? [command ?? "", ...(args ?? [])].join(" ").trim()
      : redactUrl(url ?? "");
  return { transport, endpoint, enabled: raw.enabled === false ? false : undefined };
}

/** `<agentDir>/mcp.json`'s denylist/allowlist; a parse failure degrades to empty. */
async function readServerLists(
  userPath: string,
  errors: McpServersResult["errors"],
): Promise<{ denylist: Set<string>; allowlist: Set<string> }> {
  const empty = { denylist: new Set<string>(), allowlist: new Set<string>() };
  let text: string;
  try {
    text = await fs.promises.readFile(userPath, "utf8");
  } catch {
    return empty; // absent or unreadable — no overrides, and not an error row
  }
  try {
    const root = asRecord(JSON.parse(text)) ?? {};
    const list = (key: string): Set<string> => {
      const value = root[key];
      return new Set(Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
    };
    return { denylist: list("disabledServers"), allowlist: list("enabledServers") };
  } catch (err) {
    errors.push({ path: userPath, message: err instanceof Error ? err.message : String(err) });
    return empty;
  }
}

/**
 * Every MCP server omp resolves for `projectCwd`; `null` means global scope —
 * user-scope sources only, in provider-priority order.
 * The first occurrence of a name is the effective row; later same-name rows
 * follow immediately with `effective: false` and a `shadowedBy` pointer. One
 * malformed file lands in `errors` and never blocks the rest.
 */
export async function resolveMcpServers(
  projectCwd: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpServersResult> {
  const errors: McpServersResult["errors"] = [];
  const servers: McpServerEntry[] = [];
  /** name → the effective row that claimed it. */
  const claimed = new Map<string, McpServerEntry>();

  const agentDir = getOmpAgentDir(env);
  const { denylist, allowlist } = await readServerLists(path.join(agentDir, "mcp.json"), errors);

  for (const file of providerFiles(projectCwd, env)) {
    let text: string;
    try {
      text = await fs.promises.readFile(file.path, "utf8");
    } catch {
      continue; // absent/unreadable files simply contribute nothing
    }
    let root: RawServer;
    try {
      root = asRecord(JSON.parse(text)) ?? {};
    } catch (err) {
      errors.push({ path: file.path, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const map of file.maps(root, projectCwd)) {
      const record = asRecord(map);
      if (!record) continue;
      for (const [name, raw] of Object.entries(record)) {
        const server = asRecord(raw);
        if (!server) continue;
        const { transport, endpoint, enabled } = normalizeServer(file.provider, server);
        const winner = claimed.get(name);
        if (winner) {
          servers.push({
            name,
            transport,
            endpoint,
            source: file.provider,
            scope: file.scope,
            sourcePath: file.path,
            effective: false,
            shadowedBy: `${winner.source}:${winner.sourcePath}`,
            state: enabled === false ? "disabled" : "enabled",
            disabledBy: enabled === false ? "config" : undefined,
            writable: file.writable,
          });
          continue;
        }
        const entry: McpServerEntry = {
          name,
          transport,
          endpoint,
          source: file.provider,
          scope: file.scope,
          sourcePath: file.path,
          effective: true,
          state: "enabled",
          writable: file.writable,
        };
        if (denylist.has(name)) {
          entry.state = "disabled";
          entry.disabledBy = "denylist";
        } else if (enabled === false && !allowlist.has(name)) {
          entry.state = "disabled";
          entry.disabledBy = "config";
        } else if (enabled === false) {
          // Reaching here means the allowlist is the only reason this row is
          // ON. omp honours that list at the user level only, so disabling
          // this server for one project has to clear the global pin (#324).
          entry.enabledBy = "allowlist";
        }
        claimed.set(name, entry);
        servers.push(entry);
      }
    }
  }
  return { servers, errors };
}

/* ----------------------------------------------------------------- writer */

/** Missing file → empty config (omp's readMCPConfigFile); malformed JSON throws. */
async function readMcpConfigFile(filePath: string): Promise<McpConfigFile> {
  try {
    const text = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(text) as McpConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
    throw err;
  }
}

/**
 * Whole-file write, the way omp writes (and the way strict JSON round-trips
 * safely: no comments to lose, so a parse/spread/stringify preserves every
 * unrelated key). `$schema` comes first; tmp + rename keeps it atomic. No file
 * locking — omp-ui is single-instance and the only writer besides a hand-edit.
 */
async function writeMcpConfigFile(filePath: string, config: McpConfigFile): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const content = JSON.stringify({ $schema: config.$schema ?? MCP_CONFIG_SCHEMA_URL, ...config }, null, 2);
  try {
    await fs.promises.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function readStringList(config: McpConfigFile, key: "disabledServers" | "enabledServers"): string[] {
  const value = config[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Drops one name from the user-level `enabledServers`, leaving the deny list
 * and every unrelated key untouched; the key itself disappears once the list
 * empties, exactly as omp's own writer leaves it.
 *
 * This is the single user-level write the project toggle performs. It is
 * unavoidable: omp's `loadAllMCPConfigs` suppresses a server when
 * `denylisted || (enabled === false && !allowlisted)`, and it reads both
 * lists from the user file alone — a project file's own list keys are never
 * consulted. So while a name sits in `enabledServers`, no `enabled: false`
 * written anywhere inside a project can suppress it.
 */
async function clearUserAllowlistEntry(userPath: string, name: string): Promise<void> {
  const config = await readMcpConfigFile(userPath);
  const allow = readStringList(config, "enabledServers").filter((entry) => entry !== name);
  const updated: McpConfigFile = { ...config };
  if (allow.length > 0) updated.enabledServers = allow.sort();
  else delete updated.enabledServers;
  await writeMcpConfigFile(userPath, updated);
}

/**
 * Flips one server's enabled state and resolves with the refreshed server
 * list so the renderer updates in one round trip. A write or parse failure
 * rejects; nothing is half-reported.
 *
 * Global scope (`projectCwd: null`) is a faithful port of omp's
 * `setMcpServerEnabled` (src/mcp/config-writer.ts) — see
 * {@link setGlobalServerEnabled}. Project scope deliberately diverges: the
 * toggle writes only inside the project and NEVER touches user-level state —
 * see {@link setProjectServerEnabled}. `req.sourcePath` is honoured in global
 * scope only; the project writer resolves the winning definition itself.
 */
export async function setMcpServerEnabled(
  req: McpSetEnabledRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpServersResult> {
  if (req.projectCwd === null) {
    await setGlobalServerEnabled(req.name, req.enabled, req.sourcePath, env);
  } else {
    await setProjectServerEnabled(req.projectCwd, req.name, req.enabled, env);
  }
  return resolveMcpServers(req.projectCwd, env);
}

/**
 * Global-scope toggle — omp's own write algorithm:
 *
 * - The first candidate file (writable `sourcePath`, then user mcp.json) that
 *   actually defines `name` gets `{ ...entry, enabled }` written back; the
 *   search stops there.
 * - Enable: clears any user denylist entry; adds a user allowlist entry only
 *   when no file was updated (a tool-owned source's `enabled: false` needs
 *   the override); drops the allowlist entry when a writable file now says
 *   `enabled: true` (redundant override).
 * - Disable: clears any user allowlist entry; adds a user denylist entry when
 *   no file was updated.
 *
 * The user mcp.json is read exactly once and written at most once per
 * toggle: the previous shape re-read it before every list operation, so one
 * toggle could interleave up to 5 reads and 3 partial rewrites with omp's own
 * writer. The lists are computed in memory from that single snapshot; the one
 * final write carries the list state and (when the user file was itself the
 * updated candidate) the entry flip together.
 */
async function setGlobalServerEnabled(
  name: string,
  enabled: boolean,
  sourcePath: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const userPath = path.join(getOmpAgentDir(env), "mcp.json");
  // Read the user file once up front: it always supplies the deny/allow
  // lists, and it may be the winning candidate below.
  let userConfig = await readMcpConfigFile(userPath);
  const candidatePaths = [...new Set([sourcePath, userPath].filter((p) => p !== undefined))];
  let updatedInConfig = false;

  for (const filePath of candidatePaths) {
    const config = filePath === userPath ? userConfig : await readMcpConfigFile(filePath);
    const server = config.mcpServers?.[name];
    if (server === undefined) continue;
    const written: McpConfigFile = {
      ...config,
      mcpServers: { ...config.mcpServers, [name]: { ...server, enabled } },
    };
    await writeMcpConfigFile(filePath, written);
    if (filePath === userPath) userConfig = written; // keep the snapshot current
    updatedInConfig = true;
    break;
  }

  const deny = new Set(readStringList(userConfig, "disabledServers"));
  const allow = new Set(readStringList(userConfig, "enabledServers"));
  if (enabled) {
    deny.delete(name);
    if (!updatedInConfig && !allow.has(name)) allow.add(name);
    else if (updatedInConfig && allow.has(name)) allow.delete(name);
  } else {
    allow.delete(name);
    if (!updatedInConfig) deny.add(name);
  }

  const denyList = [...deny].sort();
  const allowList = [...allow].sort();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (
    !same(denyList, readStringList(userConfig, "disabledServers").sort()) ||
    !same(allowList, readStringList(userConfig, "enabledServers").sort())
  ) {
    const updated: McpConfigFile = { ...userConfig };
    if (denyList.length > 0) updated.disabledServers = denyList;
    else delete updated.disabledServers;
    if (allowList.length > 0) updated.enabledServers = allowList;
    else delete updated.enabledServers;
    await writeMcpConfigFile(userPath, updated);
  }
}

/** Every (file, raw) definition of `name`, in provider priority order. */
async function findDefinitions(
  name: string,
  files: ProviderFile[],
  projectCwd: string | null,
): Promise<Array<{ file: ProviderFile; raw: RawServer }>> {
  const defs: Array<{ file: ProviderFile; raw: RawServer }> = [];
  for (const file of files) {
    let text: string;
    try {
      text = await fs.promises.readFile(file.path, "utf8");
    } catch {
      continue; // absent/unreadable files simply contribute nothing
    }
    let root: RawServer;
    try {
      root = asRecord(JSON.parse(text)) ?? {};
    } catch {
      continue; // the resolution pass already reports malformed files
    }
    for (const map of file.maps(root, projectCwd)) {
      const raw = asRecord(asRecord(map)?.[name]);
      if (raw) defs.push({ file, raw });
    }
  }
  return defs;
}

/**
 * The mcp.json schema is closed (`additionalProperties: false`), so skeleton
 * detection is structural: `enabled === false` and no keys beyond the
 * transport identity. Known accepted edge: a user-authored project entry
 * that is structurally identical to a skeleton and shadows a same-named
 * source gets deleted on enable — the effect ("server turns on using its
 * source definition") still matches the toggle's intent.
 */
const SKELETON_KEYS: Record<string, true> = { type: true, command: true, url: true, enabled: true };

function isDisableSkeleton(entry: RawServer): boolean {
  return entry.enabled === false && Object.keys(entry).every((key) => SKELETON_KEYS[key] === true);
}

/**
 * A secret-free suppression entry for the project override. It owns the name
 * (schema-valid, wins priority) and is suppressed by omp (never spawned), so
 * fidelity of args/env/headers is irrelevant — and none of them are copied:
 * `.omp/` may be committed to the repo, so `args`, `env`, `headers`, `auth`,
 * and `oauth` NEVER land here, and urls are redacted.
 */
function disableSkeleton(provider: McpServerSource, raw: RawServer): RawServer {
  const { transport, command, url } = extractTransport(provider, raw);
  if (transport === "stdio") {
    // A source with no command fails omp's validation and never runs anyway.
    return { command: command ?? "-", enabled: false };
  }
  return { type: transport, url: url === undefined ? "-" : redactUrl(url), enabled: false };
}

/**
 * Project-scope toggle — a deliberate divergence from omp's writer. The
 * invariant: a toggle decides THIS project and writes inside it (its
 * `.omp/mcp.json`, or a project-scope writable file that already defines the
 * server). It never writes a user-level *definition*, and never touches the
 * user denylist. The single exception is forced by omp's suppression rule
 * (see the disable bullet): clearing an `enabledServers` pin, because
 * nothing written inside a project can override it.
 *
 * A single priority walk mirrors resolution (which also avoids the latent
 * candidate-loop flaw of flipping a *shadowed* entry while a higher-priority
 * entry stays effective):
 *
 * - Winner in a project-scope writable file → flip `enabled` in place. On
 *   enable, a disable skeleton with a shadowed source behind it is DELETED
 *   instead — enabling a skeleton in place would run a broken argless copy,
 *   while deletion restores whatever the source says today (drift-safe).
 *   Skeleton removal keeps remaining `mcpServers` keys and every unrelated
 *   top-level key intact.
 * - Winner elsewhere, disabling → write a {@link disableSkeleton} into the
 *   project's `.omp/mcp.json` (a project entry with `enabled: false`
 *   suppresses the name for this project only; omp honours suppression, not
 *   drop).
 * - Disabling an allowlisted name → {@link clearUserAllowlistEntry} runs
 *   first. omp suppresses on `denylisted || (enabled === false &&
 *   !allowlisted)` and reads both lists from the user file only, so the
 *   project write alone is a silent no-op (#324); omp's own `/mcp disable`
 *   clears the pin for the same reason. When the pin was load-bearing (the
 *   winner's source says `enabled: false` — surfaced to the UI as
 *   `enabledBy: "allowlist"`), clearing it also drops the server in other
 *   projects that do not enable it themselves; omp offers no project-scoped
 *   override, so the alternative is a toggle that cannot work.
 * - Winner elsewhere, enabling → nothing project-local can beat the user
 *   denylist or a source's `enabled: false` without copying secrets into a
 *   possibly-committed project file, so those states reject with a pointer
 *   to the global manager; an already-enabled server is an idempotent no-op.
 */
async function setProjectServerEnabled(
  projectCwd: string,
  name: string,
  enabled: boolean,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const defs = await findDefinitions(name, providerFiles(projectCwd, env), projectCwd);
  const winner = defs[0];
  if (winner === undefined) {
    throw new Error(`Server "${name}" is not defined in any config source.`);
  }

  // Both directions consult the user lists; read them once. omp reads them
  // from this file alone, which is also the only place a pin can be cleared.
  const userPath = path.join(getOmpAgentDir(env), "mcp.json");
  const errors: McpServersResult["errors"] = [];
  const { denylist, allowlist } = await readServerLists(userPath, errors);

  // The pin outranks anything a project file can say, so a project-scope
  // disable clears it before the write below decides this project.
  if (!enabled && allowlist.has(name)) {
    await clearUserAllowlistEntry(userPath, name);
  }

  if (winner.file.scope === "project" && winner.file.writable) {
    const config = await readMcpConfigFile(winner.file.path);
    if (enabled && isDisableSkeleton(winner.raw) && defs.length > 1) {
      const { [name]: _removed, ...rest } = config.mcpServers ?? {};
      await writeMcpConfigFile(winner.file.path, { ...config, mcpServers: rest });
      return;
    }
    await writeMcpConfigFile(winner.file.path, {
      ...config,
      mcpServers: { ...config.mcpServers, [name]: { ...winner.raw, enabled } },
    });
    return;
  }

  if (!enabled) {
    const overridePath = path.join(projectCwd, ".omp", "mcp.json");
    const config = await readMcpConfigFile(overridePath);
    await writeMcpConfigFile(overridePath, {
      ...config,
      mcpServers: {
        ...config.mcpServers,
        [name]: disableSkeleton(winner.file.provider, winner.raw),
      },
    });
    return;
  }

  // Enabling a server defined outside the project: mirror resolution's state
  // derivation to reject the states no project-local write can change.
  if (denylist.has(name)) {
    throw new Error(
      `"${name}" is disabled by the user-level denylist — enable it globally from Settings → MCP servers.`,
    );
  }
  if (winner.raw.enabled === false && !allowlist.has(name)) {
    throw new Error(
      `"${name}" is disabled in its source config — enable it globally from Settings → MCP servers.`,
    );
  }
  // Already effectively enabled — idempotent no-op, no write.
}
