import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  CAPABILITIES_STATUS_KEY,
  ROUTINE_DEFAULT_ALLOW_VAULT_TOOLS,
  RpcClient,
  capabilitiesMessage,
  normalizeControlFrame,
  parseCapabilitySnapshot,
  resolveMcpServers,
  writeCapabilitiesExtension,
  type CapabilitySnapshot,
  type CapabilityTool,
  type McpServersResult,
  type RoutineCatalogSnapshot,
  type RoutineCatalogTool,
  type RpcFrame,
} from "@omp-ui/core";

/** Cached probe lifetime per (projectCwd, mcpConfigFingerprint) (§3). */
export const ROUTINE_CATALOG_CACHE_TTL_MS = 60_000;
/** Hard bound on one-shot rpc-ui capability enumeration probes (§3). */
export const ROUTINE_CATALOG_PROBE_TIMEOUT_MS = 15_000;

interface StaticToolMeta {
  readonly key: string;
  readonly description: string;
}

/**
 * omp's static built-in tool roster matching `omp --help` (§3, #1252).
 * Combined with live `CapabilitySnapshot.tools` when available so newer omp
 * built-ins surface automatically while offline enumeration keeps full coverage.
 */
export const ROUTINE_BUILTIN_TOOLS: readonly StaticToolMeta[] = [
  { key: "read", description: "Read files, directories, and URLs" },
  { key: "grep", description: "Search file contents with regular expressions" },
  { key: "glob", description: "Match files and directories by glob pattern" },
  { key: "find", description: "Find implementing files by behavior description" },
  { key: "ls", description: "List directory entries" },
  { key: "write", description: "Create or overwrite files" },
  { key: "edit", description: "Patch existing files" },
  { key: "web_search", description: "Search the web" },
  { key: "bash", description: "Run shell commands (can invoke arbitrary CLIs)" },
  { key: "eval", description: "Evaluate Python or JavaScript code (can invoke tools and subprocesses)" },
  { key: "task", description: "Spawn subagents" },
  { key: "wait", description: "Wait on background jobs or subagents" },
  { key: "todo", description: "Track task checklists" },
  { key: "ask", description: "Ask the user an interactive question" },
  { key: "ast_edit", description: "Perform AST-aware code edits" },
  { key: "lsp", description: "Query language servers for diagnostics and references" },
  { key: "debug", description: "Debug a running process via DAP" },
  { key: "memory_edit", description: "Edit or delete long-term memories" },
  { key: "retain", description: "Store facts in long-term memory" },
  { key: "recall", description: "Search long-term memory" },
  { key: "reflect", description: "Synthesize answers from long-term memory" },
  { key: "learn", description: "Capture durable lessons and managed skills" },
  { key: "manage_skill", description: "Create, update, or delete managed skills" },
];

const VAULT_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "omp-ui_vault_search": "Search notes in the registered Obsidian vault",
  "omp-ui_vault_read": "Read a note from the registered Obsidian vault",
  "omp-ui_vault_list": "List notes in the Obsidian vault home folder",
  "omp-ui_vault_create": "Create a note in the Obsidian vault home folder",
  "omp-ui_vault_append": "Append markdown to a vault note",
  "omp-ui_vault_edit": "Replace the body of a vault note",
  "omp-ui_vault_link": "Append a wikilink to a vault note",
  "omp-ui_vault_rename": "Rename or move an omp-ui-created vault note",
  "omp-ui_vault_delete": "Delete an omp-ui-created vault note",
  "omp-ui_vault_refactor": "Consolidate several vault notes into one",
};

const BUILTIN_KEY_SET = new Set<string>(ROUTINE_BUILTIN_TOOLS.map((t) => t.key));
const VAULT_KEY_SET = new Set<string>(ROUTINE_DEFAULT_ALLOW_VAULT_TOOLS);

/**
 * Result of one bounded one-shot capabilities probe for a project cwd.
 * `expectedMcpServers` are the project's enabled configured servers: omp
 * connects them after its first snapshot, so the probe keeps reading until
 * each has reported tools or the bound expires. Injected in tests so unit
 * tests never spawn `omp`.
 */
export type RoutineCatalogProbeRunner = (
  projectCwd: string,
  timeoutMs: number,
  expectedMcpServers: readonly string[],
) => Promise<CapabilitySnapshot>;

export interface RoutineCatalogServiceDeps {
  /** Whether at least one Obsidian vault is registered on this host. */
  hasVaults: () => boolean;
  /** Live `CapabilitySnapshot` from any running native session in `projectCwd`, if available. */
  liveCapabilities: (projectCwd: string) => CapabilitySnapshot | null;
  /** Resolves configured MCP servers for `projectCwd` (defaults to `resolveMcpServers`). */
  resolveMcp?: (projectCwd: string) => Promise<McpServersResult>;
  /** Resolves the omp binary path for the default one-shot probe. */
  getOmpPath?: () => string | null;
  /** Optional sanitized env for the default one-shot probe. */
  probeEnv?: () => NodeJS.ProcessEnv;
  /** Injectable probe runner (defaults to spawning one-shot `omp --mode=rpc-ui --no-session`). */
  runProbe?: RoutineCatalogProbeRunner;
  now?: () => number;
}

export interface ListCatalogOptions {
  /** Previously reviewed keys (e.g. from saved routines) used as last-resort offline fallback. */
  fallbackReviewedKeys?: readonly string[];
  /** Bypass the 60 s TTL cache (still deduplicating concurrent probes). */
  forceRefresh?: boolean;
}

interface CacheEntry {
  fingerprint: string;
  capturedAtMs: number;
  tools: RoutineCatalogTool[];
  mcpServerNames: Set<string>;
}

/**
 * Extracts a best-effort MCP server label from a flat `mcp__<server>_<tool>` key
 * when `CapabilityTool.mcpServerName` is unavailable (e.g. reviewedCatalog fallback).
 */
export function inferMcpServerFromKey(key: string): string {
  if (!key.startsWith("mcp__")) return "mcp";
  const rest = key.slice("mcp__".length);
  const sep = rest.indexOf("_");
  return sep > 0 ? rest.slice(0, sep) : rest || "mcp";
}

function mcpConfigFingerprint(mcp: McpServersResult | null): string {
  if (mcp === null) return "none";
  const stable = mcp.servers
    .map((s) => `${s.name}|${s.state}|${s.effective ? 1 : 0}|${s.transport}|${s.endpoint}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function enabledConfiguredServerNames(mcp: McpServersResult | null): string[] {
  if (mcp === null) return [];
  const names = new Set<string>();
  for (const server of mcp.servers) {
    if (server.state === "enabled" && server.effective) names.add(server.name);
  }
  return Array.from(names).sort();
}

function isHostOnlyExcludedTool(name: string): boolean {
  if (VAULT_KEY_SET.has(name)) return false;
  // Outside-sender exclusions withhold fleet, device, theme, issue, and
  // non-vault host tools from routine runs (ADR-0100).
  return name.startsWith("omp-ui_");
}

function mapCapabilityTools(items: readonly CapabilityTool[]): {
  builtins: Map<string, RoutineCatalogTool>;
  mcpTools: Map<string, RoutineCatalogTool>;
  mcpServersSeen: Set<string>;
} {
  const builtins = new Map<string, RoutineCatalogTool>();
  const mcpTools = new Map<string, RoutineCatalogTool>();
  const mcpServersSeen = new Set<string>();

  for (const item of items) {
    if (typeof item.name !== "string" || item.name.trim() === "") continue;
    if (isHostOnlyExcludedTool(item.name) || VAULT_KEY_SET.has(item.name)) continue;

    if (item.source === "mcp" || item.mcpServerName !== null || item.name.startsWith("mcp__")) {
      const server = item.mcpServerName?.trim() || inferMcpServerFromKey(item.name);
      mcpServersSeen.add(server);
      mcpTools.set(item.name, {
        key: item.name,
        source: "mcp",
        group: `mcp:${server}`,
        groupLabel: server,
        description: item.description,
      });
    } else if (item.source === "builtin" || BUILTIN_KEY_SET.has(item.name)) {
      builtins.set(item.name, {
        key: item.name,
        source: "builtin",
        group: "builtin",
        groupLabel: "Built-in tools",
        description: item.description,
      });
    }
  }

  return { builtins, mcpTools, mcpServersSeen };
}

/** Every expected server owns at least one tool in the snapshot. */
function reportsServers(snapshot: CapabilitySnapshot, expected: readonly string[]): boolean {
  if (snapshot.tools.status !== "available") return true;
  const { mcpServersSeen } = mapCapabilityTools(snapshot.tools.items);
  return expected.every((server) => mcpServersSeen.has(server));
}

/**
 * Default one-shot probe: spawns `omp --mode=rpc-ui --no-session --cwd <projectCwd> -e <capabilities-ext>`,
 * arms the capabilities bridge, and reads snapshots until every expected MCP
 * server has reported (omp mounts MCP tools after its first snapshot), then
 * tears down. At the bound it answers the latest snapshot, whose missing
 * servers the caller marks stale; with no snapshot at all it fails.
 */
export function createDefaultCatalogProbeRunner(
  getOmpPath: () => string | null,
  providerEnv?: () => NodeJS.ProcessEnv,
): RoutineCatalogProbeRunner {
  return async (projectCwd: string, timeoutMs: number, expectedMcpServers: readonly string[]): Promise<CapabilitySnapshot> => {
    const ompPath = getOmpPath();
    if (!ompPath) throw new Error("omp binary is not available for tool catalog discovery");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-routine-cat-"));
    const { promise, resolve, reject } = Promise.withResolvers<CapabilitySnapshot>();
    let settled = false;
    let client: RpcClient | null = null;
    let latest: CapabilitySnapshot | null = null;
    const finish = (err: Error | null, snap?: CapabilitySnapshot): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.kill();
      if (err !== null) reject(err);
      else resolve(snap!);
    };
    const timer = setTimeout(() => {
      if (latest !== null) finish(null, latest);
      else finish(new Error(`tool catalog probe timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    try {
      client = new RpcClient({
        cwd: projectCwd,
        lineageDir: tmpDir,
        ompPath,
        extensions: [writeCapabilitiesExtension(tmpDir)],
        ...(providerEnv === undefined ? {} : { providerEnv: providerEnv() }),
        // RpcClient always names a session dir; the probe must not persist a transcript.
        spawnProcess: (bin, args, env) => {
          const proc = spawn(bin, [...args, "--no-session"], { cwd: projectCwd, env, stdio: "pipe", windowsHide: true });
          return {
            stdin: proc.stdin,
            stdout: proc.stdout,
            stderr: proc.stderr,
            kill: (signal) => void proc.kill(signal),
            onExit: (cb) => proc.on("exit", (code) => cb(code)),
            onSpawnError: (cb) => proc.on("error", cb),
          };
        },
        initialCommands: [{ type: "prompt", message: capabilitiesMessage() }],
        onFrame: (raw: RpcFrame) => {
          const control = normalizeControlFrame(raw);
          if (
            control?.kind === "ext_request" &&
            control.method === "setStatus" &&
            control.frame.statusKey === CAPABILITIES_STATUS_KEY
          ) {
            const parsed = parseCapabilitySnapshot(
              typeof control.frame.statusText === "string" ? control.frame.statusText : undefined,
            );
            if (parsed === null) return;
            latest = parsed;
            if (reportsServers(parsed, expectedMcpServers)) finish(null, parsed);
          }
        },
        onExit: (code) =>
          latest !== null
            ? finish(null, latest)
            : finish(new Error(`tool catalog probe exited before reporting capabilities (code ${code ?? "null"})`)),
        onError: (msg) => finish(new Error(`tool catalog probe failed: ${msg}`)),
      });
      return await promise;
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

/**
 * Discovers the live tool catalog for a routine's local destination project (§3, #1252):
 * 1. Static omp built-ins + active `omp-ui_vault_*` host tools (when vaults are registered).
 * 2. Live `CapabilitySnapshot.tools` from a running native session in `projectCwd`.
 * 3. Else a bounded cached one-shot `omp --mode=rpc-ui --no-session` capabilities probe
 *    (60 s TTL keyed by `projectCwd` + MCP config fingerprint, 15 s timeout).
 * 4. Offline fallback to last-known cached tools / routine `reviewedCatalog` with stale-server warnings.
 */
export class RoutineCatalogService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CapabilitySnapshot>>();
  private readonly now: () => number;
  private readonly resolveMcp: (projectCwd: string) => Promise<McpServersResult>;
  private readonly runProbe: RoutineCatalogProbeRunner;

  constructor(private readonly deps: RoutineCatalogServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.resolveMcp = deps.resolveMcp ?? ((cwd) => resolveMcpServers(cwd));
    this.runProbe =
      deps.runProbe ??
      createDefaultCatalogProbeRunner(deps.getOmpPath ?? (() => null), deps.probeEnv);
  }

  /** Clears cached probe results (e.g. on dispose or tests). */
  clearCache(): void {
    this.cache.clear();
  }

  async list(projectCwd: string, opts: ListCatalogOptions = {}): Promise<RoutineCatalogSnapshot> {
    const nowMs = this.now();
    const capturedAt = new Date(nowMs).toISOString();

    // An unreadable MCP config fingerprints as "none" and contributes no stale servers.
    const mcpResult = await this.resolveMcp(projectCwd).catch(() => null);
    const fingerprint = mcpConfigFingerprint(mcpResult);
    const configuredServers = enabledConfiguredServerNames(mcpResult);

    // Source 1: live session snapshot in this project
    const liveSnap = this.deps.liveCapabilities(projectCwd);
    if (liveSnap !== null && liveSnap.tools.status === "available") {
      return this.assembleFromSnapshot(projectCwd, fingerprint, configuredServers, liveSnap, opts.fallbackReviewedKeys, nowMs, capturedAt);
    }

    // Source 2: fresh TTL cache hit for (projectCwd, mcpConfigFingerprint)
    const cached = this.cache.get(projectCwd);
    if (
      !opts.forceRefresh &&
      cached !== undefined &&
      cached.fingerprint === fingerprint &&
      nowMs - cached.capturedAtMs < ROUTINE_CATALOG_CACHE_TTL_MS
    ) {
      const staleServers = configuredServers.filter((s) => !cached.mcpServerNames.has(s));
      const tools = this.mergeStaticAndMcp(cached.tools, opts.fallbackReviewedKeys, staleServers);
      return {
        tools,
        staleServers,
        enumerationError: null,
        capturedAt: new Date(cached.capturedAtMs).toISOString(),
      };
    }

    // Source 3: bounded one-shot probe (coalesced per projectCwd + fingerprint)
    const flightKey = `${projectCwd}\0${fingerprint}`;
    let probePromise = this.inFlight.get(flightKey);
    if (probePromise === undefined) {
      probePromise = this.runProbe(projectCwd, ROUTINE_CATALOG_PROBE_TIMEOUT_MS, configuredServers);
      this.inFlight.set(flightKey, probePromise);
      const cleanup = (): void => {
        if (this.inFlight.get(flightKey) === probePromise) {
          this.inFlight.delete(flightKey);
        }
      };
      probePromise.then(cleanup, cleanup);
    }

    try {
      const probed = await probePromise;
      if (probed.tools.status === "available") {
        return this.assembleFromSnapshot(projectCwd, fingerprint, configuredServers, probed, opts.fallbackReviewedKeys, this.now(), new Date(this.now()).toISOString());
      }
      return this.buildFallback(
        cached,
        configuredServers,
        opts.fallbackReviewedKeys,
        `tool catalog unavailable (${probed.tools.reason})`,
        capturedAt,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.buildFallback(
        cached,
        configuredServers,
        opts.fallbackReviewedKeys,
        message,
        capturedAt,
      );
    }
  }

  private assembleFromSnapshot(
    projectCwd: string,
    fingerprint: string,
    configuredServers: string[],
    snapshot: CapabilitySnapshot,
    fallbackReviewedKeys: readonly string[] | undefined,
    nowMs: number,
    capturedAt: string,
  ): RoutineCatalogSnapshot {
    const items = snapshot.tools.status === "available" ? snapshot.tools.items : [];
    const { builtins, mcpTools, mcpServersSeen } = mapCapabilityTools(items);

    const prior = this.cache.get(projectCwd);
    const staleServers: string[] = [];

    // If a configured enabled MCP server did not report any tools in the live
    // snapshot, mark it stale and carry forward last-known tools for that server.
    for (const server of configuredServers) {
      if (mcpServersSeen.has(server)) continue;
      staleServers.push(server);
      if (prior !== undefined) {
        for (const tool of prior.tools) {
          if (tool.source === "mcp" && tool.group === `mcp:${server}` && !mcpTools.has(tool.key)) {
            mcpTools.set(tool.key, tool);
          }
        }
      }
    }

    // Build combined tools: static built-ins (updated by live descriptions) + live built-ins + vault + mcp
    const builtinList = this.buildBuiltins(builtins);
    const mcpList = Array.from(mcpTools.values()).sort((a, b) => a.key.localeCompare(b.key));
    const discovered = [...builtinList, ...mcpList];

    // Cache the non-vault portion so vault toggles reflect immediately without invalidating MCP probes.
    this.cache.set(projectCwd, {
      fingerprint,
      capturedAtMs: nowMs,
      tools: discovered,
      mcpServerNames: new Set(mcpServersSeen),
    });

    const tools = this.mergeStaticAndMcp(discovered, fallbackReviewedKeys, staleServers);
    return {
      tools,
      staleServers,
      enumerationError: null,
      capturedAt,
    };
  }

  private buildFallback(
    cached: CacheEntry | undefined,
    configuredServers: string[],
    fallbackReviewedKeys: readonly string[] | undefined,
    enumerationError: string,
    capturedAt: string,
  ): RoutineCatalogSnapshot {
    const base = cached?.tools ?? this.buildBuiltins(new Map());
    const staleServers = [...configuredServers];
    // Also surface server names inferred from cached or reviewed MCP tools if none were configured locally.
    const tools = this.mergeStaticAndMcp(base, fallbackReviewedKeys, staleServers);
    if (staleServers.length === 0) {
      const inferred = new Set<string>();
      for (const tool of tools) {
        if (tool.source === "mcp") inferred.add(tool.groupLabel);
      }
      staleServers.push(...Array.from(inferred).sort());
    }
    return {
      tools,
      staleServers,
      enumerationError,
      capturedAt,
    };
  }

  private buildBuiltins(liveBuiltins: Map<string, RoutineCatalogTool>): RoutineCatalogTool[] {
    const byKey = new Map<string, RoutineCatalogTool>();
    for (const meta of ROUTINE_BUILTIN_TOOLS) {
      byKey.set(meta.key, {
        key: meta.key,
        source: "builtin",
        group: "builtin",
        groupLabel: "Built-in tools",
        description: meta.description,
      });
    }
    for (const [key, tool] of liveBuiltins) {
      byKey.set(key, tool);
    }
    return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  }

  private buildVaultTools(): RoutineCatalogTool[] {
    if (!this.deps.hasVaults()) return [];
    return ROUTINE_DEFAULT_ALLOW_VAULT_TOOLS.map((key) => ({
      key,
      source: "host-vault" as const,
      group: "vault",
      groupLabel: "Knowledge vault",
      description: VAULT_TOOL_DESCRIPTIONS[key] ?? "Obsidian vault tool",
    }));
  }

  private mergeStaticAndMcp(
    discovered: readonly RoutineCatalogTool[],
    fallbackReviewedKeys: readonly string[] | undefined,
    staleServers: readonly string[],
  ): RoutineCatalogTool[] {
    const byKey = new Map<string, RoutineCatalogTool>();
    for (const tool of discovered) {
      byKey.set(tool.key, tool);
    }
    for (const tool of this.buildVaultTools()) {
      byKey.set(tool.key, tool);
    }
    if (fallbackReviewedKeys !== undefined && staleServers.length > 0) {
      const staleSet = new Set(staleServers);
      for (const key of fallbackReviewedKeys) {
        if (byKey.has(key) || !key.startsWith("mcp__")) continue;
        const server = inferMcpServerFromKey(key);
        if (staleSet.has(server) || staleServers.length > 0) {
          byKey.set(key, {
            key,
            source: "mcp",
            group: `mcp:${server}`,
            groupLabel: server,
            description: "Last-known tool from reviewed policy (server offline)",
          });
        }
      }
    }

    const order: Record<RoutineCatalogTool["source"], number> = {
      builtin: 0,
      "host-vault": 1,
      mcp: 2,
    };
    return Array.from(byKey.values()).sort((a, b) => {
      const s = order[a.source] - order[b.source];
      if (s !== 0) return s;
      const g = a.group.localeCompare(b.group);
      if (g !== 0) return g;
      return a.key.localeCompare(b.key);
    });
  }
}
