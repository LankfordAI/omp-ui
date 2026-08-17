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
 * - {@link setMcpServerEnabled} is a port of omp's `setMcpServerEnabled`
 *   (src/mcp/config-writer.ts), cleanup invariants included: writable sources
 *   (native, root mcp.json) get the `enabled` flag written back in place;
 *   tool-owned files are NEVER mutated — toggling those servers goes through
 *   the user-level `disabledServers`/`enabledServers` lists in the agent dir's
 *   `mcp.json` instead.
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

/**
 * Folds one file's server entry down to the three redacted facts the DTO
 * carries. opencode's `mcp` map has its own shape (`type: "local"|"remote"`,
 * `command` string|array, `environment`); everything else is mcp.json-shaped.
 * Transport inference mirrors omp's `convertToLegacyConfig`:
 * `type` field, else `command` → stdio, `url` → http, else stdio.
 */
function normalizeServer(provider: McpServerSource, raw: RawServer): NormalizedServer {
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
 * Adds/removes `name` in one of the user-level override lists, mirroring omp:
 * the array is written sorted, and the key is deleted when it empties.
 */
async function setServerListed(
  userPath: string,
  key: "disabledServers" | "enabledServers",
  name: string,
  listed: boolean,
): Promise<void> {
  const config = await readMcpConfigFile(userPath);
  const current = new Set(readStringList(config, key));
  if (listed) current.add(name);
  else current.delete(name);
  const updated: McpConfigFile = {
    ...config,
    [key]: current.size > 0 ? Array.from(current).sort() : undefined,
  };
  if (!updated[key]) delete updated[key];
  await writeMcpConfigFile(userPath, updated);
}

/**
 * Flips one server's enabled state, wherever it lives — a faithful port of
 * omp's `setMcpServerEnabled` (src/mcp/config-writer.ts):
 *
 * - First candidate file (writable `sourcePath`, then project `mcp.json`
 *   when `projectCwd` is not null, then user mcp.json) that actually
 *   defines `name` gets `{ ...entry, enabled }` written back; the search
 *   stops there.
 * - Enable: clears any user denylist entry; adds a user allowlist entry only
 *   when no file was updated (a tool-owned source's `enabled: false` needs
 *   the override); drops the allowlist entry when a writable file now says
 *   `enabled: true` (redundant override).
 * - Disable: clears any user allowlist entry; adds a user denylist entry when
 *   no file was updated.
 *
 * Resolves with the refreshed server list so the renderer updates in one
 * round trip. A write or parse failure rejects; nothing is half-reported.
 */
export async function setMcpServerEnabled(
  req: McpSetEnabledRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpServersResult> {
  const userPath = path.join(getOmpAgentDir(env), "mcp.json");
  const projectPath =
    req.projectCwd === null ? undefined : path.join(req.projectCwd, ".omp", "mcp.json");
  const candidatePaths = [
    ...new Set([req.sourcePath, projectPath, userPath].filter((p) => p !== undefined)),
  ];
  let updatedInConfig = false;

  for (const filePath of candidatePaths) {
    const config = await readMcpConfigFile(filePath);
    const server = config.mcpServers?.[req.name];
    if (server === undefined) continue;
    await writeMcpConfigFile(filePath, {
      ...config,
      mcpServers: { ...config.mcpServers, [req.name]: { ...server, enabled: req.enabled } },
    });
    updatedInConfig = true;
    break;
  }

  if (req.enabled) {
    const denied = readStringList(await readMcpConfigFile(userPath), "disabledServers");
    if (denied.includes(req.name)) {
      await setServerListed(userPath, "disabledServers", req.name, false);
    }
    const forced = readStringList(await readMcpConfigFile(userPath), "enabledServers").includes(
      req.name,
    );
    if (!updatedInConfig && !forced) {
      await setServerListed(userPath, "enabledServers", req.name, true);
    } else if (updatedInConfig && forced) {
      await setServerListed(userPath, "enabledServers", req.name, false);
    }
  } else {
    const forced = readStringList(await readMcpConfigFile(userPath), "enabledServers");
    if (forced.includes(req.name)) {
      await setServerListed(userPath, "enabledServers", req.name, false);
    }
    if (!updatedInConfig) {
      await setServerListed(userPath, "disabledServers", req.name, true);
    }
  }

  return resolveMcpServers(req.projectCwd, env);
}
