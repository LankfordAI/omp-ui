import * as fs from "node:fs";
import * as path from "node:path";
import {
  ROUTINE_DEFAULT_MAX_COST_USD,
  ROUTINE_DEFAULT_WARN_COST_USD,
  Registry,
  parseRoutineSpendDefaults,
} from "@omp-ui/core";
import { connectInstanceClient, type InstanceClient } from "@omp-ui/server";
import { pathToFileURL } from "node:url";
import { ensureLiteHome, resolveLiteHome } from "./config";
import { acquireDataDirLock, DataDirLockedError } from "./data-dir-lock";
import {
  LocalControlHttpError,
  LocalControlUnavailableError,
  disableLocalRoutines,
  enableLocalRoutines,
  fetchLocalRoutinesStatus,
  setLocalRoutineSpend,
  type LocalControlSpendPatch,
} from "./local-control";
import { bootProductionLite } from "./production-boot";
import { seedMemberDefaults } from "./serve";
/**
 * The `omp-ui-lite` command (issue #1010): `serve` runs the headless fleet member
 * in the foreground (never daemonizes); `status` probes the local listener.
 * Every effect is injectable so both commands run under vitest; the bin entry
 * wires the real ones.
 */

export interface LiteCliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: NodeJS.ProcessEnv;
}

export interface LiteCliDeps {
  io: LiteCliIo;
  /** Boot the member; resolves when the listener settled. Injected so `status` never imports serve's pipeline at run time. */
  serve: (opts: { dataDir: string }) => Promise<{ stop(): Promise<void> }>;
  /** Dial the loopback listener with the persisted token; injectable probe seam. */
  connect: typeof connectInstanceClient;
  /** Where SIGINT/SIGTERM arrive; default `process`. */
  signals?: NodeJS.EventEmitter;
  /** Where the data dir comes from; default env-derived like serve. */
  resolveDataDir?: (env: NodeJS.ProcessEnv) => string;
}

export const LITE_EXIT = { OK: 0, OPERATIONAL: 1, USAGE: 2 } as const;
export type LiteExitCode = (typeof LITE_EXIT)[keyof typeof LITE_EXIT];

/** The `status` probe budget; a hung listener is unreachable, not slow. */
const PROBE_TIMEOUT_MS = 2_000;

const ROUTINES_DISABLED_MESSAGE = "Routines is disabled in Settings → Routines";

const HELP = `Usage: omp-ui-lite <command>

Commands:
  serve                                      Run the headless fleet member in the foreground (never daemonizes).
  status                                     Print the local listener's bind/port/url and whether it answers state:get.
  routines [status]                          Print host-local Routines gate status, spend defaults, and run counts.
  routines enable [--warn <usd>] [--max <usd>]   Enable Routines on this host (optionally setting spend defaults).
  routines disable                           Disable Routines on this host without reaping live runs.
  routines spend [--warn <usd>] [--max <usd>]    Update host-wide default routine spend caps (requires Routines enabled).
  help                                       Show this help.

Environment:
  OMP_UI_LITE_HOME       Data dir override (default: <appData>/omp-ui-lite[-dev]).
  OMP_UI_LITE_ROUTINES   Boot override for routinesEnabled (1/true or 0/false).
`;

export async function runLiteCli(argv: readonly string[], deps: LiteCliDeps): Promise<LiteExitCode> {
  const command = argv[0] ?? "serve";
  if (command === "help" || command === "--help" || command === "-h") {
    deps.io.stdout(HELP);
    return LITE_EXIT.OK;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    deps.io.stdout(HELP);
    return LITE_EXIT.OK;
  }
  if (command === "serve") return runServe(deps);
  if (command === "status") return runStatus(deps);
  if (command === "routines") return runRoutines(argv.slice(1), deps);
  deps.io.stderr(`omp-ui-lite: unknown command "${command}"`);
  deps.io.stdout(HELP);
  return LITE_EXIT.USAGE;
}

async function runServe(deps: LiteCliDeps): Promise<LiteExitCode> {
  const dataDir = (deps.resolveDataDir ?? resolveLiteHome)(deps.io.env);
  ensureLiteHome(dataDir);
  const signals = deps.signals ?? process;
  // Arm before booting: a stop signal that lands mid-boot still drains.
  const { promise: signaled, resolve: signalReceived } = Promise.withResolvers<void>();
  signals.once("SIGINT", signalReceived);
  signals.once("SIGTERM", signalReceived);
  try {
    const instance = await deps.serve({ dataDir });
    // Foreground forever (issue #1010: never daemonizes): park until a stop
    // signal arrives, drain the member, and return — the bin entry exits. A
    // second signal finds no listener left and the default action kills us
    // mid-drain, which is the user's own escalation.
    await signaled;
    await instance.stop();
    return LITE_EXIT.OK;
  } catch (err) {
    signals.removeListener("SIGINT", signalReceived);
    signals.removeListener("SIGTERM", signalReceived);
    deps.io.stderr(`omp-ui-lite serve: ${err instanceof Error ? err.message : String(err)}`);
    return LITE_EXIT.OPERATIONAL;
  }
}

async function runStatus(deps: LiteCliDeps): Promise<LiteExitCode> {
  const dataDir = (deps.resolveDataDir ?? resolveLiteHome)(deps.io.env);
  // `status` reads the persisted settings, never loads processes: an absent
  // registry just means nothing was ever served from this data dir.
  const registry = Registry.load(`${dataDir}/registry.json`);
  const enabled = registry.getSetting("remoteEnabled");
  const bind = registry.getSetting("remoteBind");
  const port = registry.getSetting("remotePort");
  const token = registry.getSetting("remoteToken");
  // No trailing slash: connectInstanceClient appends the WS path to the origin verbatim.
  const url = `http://127.0.0.1:${port}`;
  if (!enabled) {
    deps.io.stdout(`remote access off (bind ${bind}, port ${port})`);
    return LITE_EXIT.OPERATIONAL;
  }
  deps.io.stdout(`remote access on — bind ${bind}, port ${port}, url ${url}`);
  if (token === "") {
    deps.io.stdout("unreachable: no token has been minted yet");
    return LITE_EXIT.OPERATIONAL;
  }
  const verdict = await probeLocal(url, token, deps.connect);
  if (verdict === null) {
    // The refresh pattern's proof of life: an authenticated state:get answers.
    deps.io.stdout("reachable — joined-owner handshake (state:get) answered");
    return LITE_EXIT.OK;
  }
  deps.io.stdout(`unreachable — ${verdict}`);
  return LITE_EXIT.OPERATIONAL;
}

interface ParsedSpendFlags {
  ok: true;
  patch: LocalControlSpendPatch;
}
interface SpendFlagsError {
  ok: false;
  message: string;
}

function parseSpendFlags(args: readonly string[]): ParsedSpendFlags | SpendFlagsError {
  const patch: LocalControlSpendPatch = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    let flag: "--warn" | "--max";
    let rawValue: string | undefined;
    if (arg === "--warn" || arg === "--max") {
      flag = arg;
      rawValue = args[++i];
    } else if (arg.startsWith("--warn=")) {
      flag = "--warn";
      rawValue = arg.slice("--warn=".length);
    } else if (arg.startsWith("--max=")) {
      flag = "--max";
      rawValue = arg.slice("--max=".length);
    } else {
      return { ok: false, message: `unknown option "${arg}"` };
    }
    if (rawValue === undefined || rawValue.trim() === "") {
      return { ok: false, message: `${flag} requires a numeric USD value` };
    }
    const num = Number(rawValue);
    if (!Number.isFinite(num)) {
      return { ok: false, message: `${flag} must be a finite number (got "${rawValue}")` };
    }
    try {
      // Validate single-field bounds against core's canonical range.
      parseRoutineSpendDefaults({
        warnUsd: flag === "--warn" ? num : 0,
        maxUsd: flag === "--max" ? num : 0,
      });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (flag === "--warn") patch.warnUsd = num;
    else patch.maxUsd = num;
  }
  return { ok: true, patch };
}

/** Side-effect-free read of persisted routine settings from registry.json (never creates files). */
function readOfflineRoutineSettings(dataDir: string): {
  enabled: boolean;
  warnUsd: number;
  maxUsd: number;
} {
  const defaults = {
    enabled: false,
    warnUsd: ROUTINE_DEFAULT_WARN_COST_USD,
    maxUsd: ROUTINE_DEFAULT_MAX_COST_USD,
  };
  const registryFile = path.join(dataDir, "registry.json");
  let raw: string;
  try {
    raw = fs.readFileSync(registryFile, "utf8");
  } catch {
    return defaults;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || !("settings" in parsed)) return defaults;
    const settings = parsed.settings;
    if (settings === null || typeof settings !== "object") return defaults;
    const rec = settings as Record<string, unknown>;
    return {
      enabled: typeof rec.routinesEnabled === "boolean" ? rec.routinesEnabled : defaults.enabled,
      warnUsd: typeof rec.routineWarnCostUsd === "number" && Number.isFinite(rec.routineWarnCostUsd)
        ? rec.routineWarnCostUsd
        : defaults.warnUsd,
      maxUsd: typeof rec.routineMaxCostUsd === "number" && Number.isFinite(rec.routineMaxCostUsd)
        ? rec.routineMaxCostUsd
        : defaults.maxUsd,
    };
  } catch {
    return defaults;
  }
}

async function runRoutines(args: readonly string[], deps: LiteCliDeps): Promise<LiteExitCode> {
  const sub = args[0] ?? "status";
  const rest = args.slice(1);
  const dataDir = (deps.resolveDataDir ?? resolveLiteHome)(deps.io.env);

  if (sub === "status") {
    if (rest.length > 0) {
      deps.io.stderr(`omp-ui-lite routines status: unexpected argument "${rest[0]}"`);
      return LITE_EXIT.USAGE;
    }
    try {
      const state = await fetchLocalRoutinesStatus(dataDir);
      const total = state.routines.length;
      const enabledCount = state.routines.filter((r) => r.enabled).length;
      const waitingApproval = state.runs.filter((r) => r.outcome === "waiting-approval").length;
      deps.io.stdout(
        `routines: ${state.enabled ? "enabled" : "disabled"} (spend warn=$${state.defaultWarnCostUsd} max=$${state.defaultMaxCostUsd})`,
      );
      deps.io.stdout(
        `configured: ${enabledCount}/${total} enabled; active run: ${state.activeRunTabId ?? "none"}; waiting approval: ${waitingApproval}`,
      );
      return LITE_EXIT.OK;
    } catch (err) {
      if (err instanceof LocalControlHttpError) {
        deps.io.stderr(`omp-ui-lite routines status: ${err.message}`);
        return LITE_EXIT.OPERATIONAL;
      }
      if (!(err instanceof LocalControlUnavailableError)) {
        deps.io.stderr(`omp-ui-lite routines status: ${err instanceof Error ? err.message : String(err)}`);
        return LITE_EXIT.OPERATIONAL;
      }
      const persisted = readOfflineRoutineSettings(dataDir);
      deps.io.stdout(
        `routines: ${persisted.enabled ? "enabled" : "disabled"} (spend warn=$${persisted.warnUsd} max=$${persisted.maxUsd}) — daemon offline`,
      );
      return LITE_EXIT.OK;
    }
  }

  if (sub === "enable") {
    const parsed = parseSpendFlags(rest);
    if (!parsed.ok) {
      deps.io.stderr(`omp-ui-lite routines enable: ${parsed.message}`);
      return LITE_EXIT.USAGE;
    }
    try {
      const state = await enableLocalRoutines(dataDir, parsed.patch);
      deps.io.stdout(
        `routines: enabled (spend warn=$${state.defaultWarnCostUsd} max=$${state.defaultMaxCostUsd})`,
      );
      return LITE_EXIT.OK;
    } catch (err) {
      if (err instanceof LocalControlHttpError) {
        deps.io.stderr(`omp-ui-lite routines enable: ${err.message}`);
        return LITE_EXIT.OPERATIONAL;
      }
      if (!(err instanceof LocalControlUnavailableError)) {
        deps.io.stderr(`omp-ui-lite routines enable: ${err instanceof Error ? err.message : String(err)}`);
        return LITE_EXIT.OPERATIONAL;
      }
    }
    // Offline path: acquire exclusive lock before touching registry.json.
    let lock;
    try {
      lock = acquireDataDirLock(dataDir);
    } catch (err) {
      deps.io.stderr(
        `omp-ui-lite routines enable: ${err instanceof DataDirLockedError ? err.message : err instanceof Error ? err.message : String(err)}`,
      );
      return LITE_EXIT.OPERATIONAL;
    }
    try {
      const registryFile = path.join(dataDir, "registry.json");
      const fresh = !fs.existsSync(registryFile);
      const registry = Registry.load(registryFile);
      seedMemberDefaults(registry, fresh);
      const patch: { routinesEnabled: boolean; routineWarnCostUsd?: number; routineMaxCostUsd?: number } = {
        routinesEnabled: true,
      };
      if (parsed.patch.warnUsd !== undefined || parsed.patch.maxUsd !== undefined) {
        const validated = parseRoutineSpendDefaults({
          warnUsd: parsed.patch.warnUsd ?? registry.getSetting("routineWarnCostUsd"),
          maxUsd: parsed.patch.maxUsd ?? registry.getSetting("routineMaxCostUsd"),
        });
        patch.routineWarnCostUsd = validated.warnUsd;
        patch.routineMaxCostUsd = validated.maxUsd;
      }
      registry.setSettings(patch);
      registry.flush();
      deps.io.stdout(
        `routines: enabled (spend warn=$${registry.getSetting("routineWarnCostUsd")} max=$${registry.getSetting("routineMaxCostUsd")}) — daemon offline`,
      );
      return LITE_EXIT.OK;
    } finally {
      lock.release();
    }
  }

  if (sub === "disable") {
    if (rest.length > 0) {
      deps.io.stderr(`omp-ui-lite routines disable: unexpected argument "${rest[0]}"`);
      return LITE_EXIT.USAGE;
    }
    try {
      await disableLocalRoutines(dataDir);
      deps.io.stdout("routines: disabled");
      return LITE_EXIT.OK;
    } catch (err) {
      if (err instanceof LocalControlHttpError) {
        deps.io.stderr(`omp-ui-lite routines disable: ${err.message}`);
        return LITE_EXIT.OPERATIONAL;
      }
      if (!(err instanceof LocalControlUnavailableError)) {
        deps.io.stderr(`omp-ui-lite routines disable: ${err instanceof Error ? err.message : String(err)}`);
        return LITE_EXIT.OPERATIONAL;
      }
    }
    let lock;
    try {
      lock = acquireDataDirLock(dataDir);
    } catch (err) {
      deps.io.stderr(
        `omp-ui-lite routines disable: ${err instanceof DataDirLockedError ? err.message : err instanceof Error ? err.message : String(err)}`,
      );
      return LITE_EXIT.OPERATIONAL;
    }
    try {
      const registryFile = path.join(dataDir, "registry.json");
      const fresh = !fs.existsSync(registryFile);
      const registry = Registry.load(registryFile);
      seedMemberDefaults(registry, fresh);
      registry.setSetting("routinesEnabled", false);
      registry.flush();
      deps.io.stdout("routines: disabled — daemon offline");
      return LITE_EXIT.OK;
    } finally {
      lock.release();
    }
  }

  if (sub === "spend") {
    const parsed = parseSpendFlags(rest);
    if (!parsed.ok) {
      deps.io.stderr(`omp-ui-lite routines spend: ${parsed.message}`);
      return LITE_EXIT.USAGE;
    }
    if (parsed.patch.warnUsd === undefined && parsed.patch.maxUsd === undefined) {
      deps.io.stderr("omp-ui-lite routines spend: specify at least one of --warn <usd> or --max <usd>");
      return LITE_EXIT.USAGE;
    }
    try {
      const state = await setLocalRoutineSpend(dataDir, parsed.patch);
      deps.io.stdout(
        `routines spend defaults: warn=$${state.defaultWarnCostUsd} max=$${state.defaultMaxCostUsd}`,
      );
      return LITE_EXIT.OK;
    } catch (err) {
      if (err instanceof LocalControlHttpError) {
        deps.io.stderr(`omp-ui-lite routines spend: ${err.message}`);
        return LITE_EXIT.OPERATIONAL;
      }
      if (!(err instanceof LocalControlUnavailableError)) {
        deps.io.stderr(`omp-ui-lite routines spend: ${err instanceof Error ? err.message : String(err)}`);
        return LITE_EXIT.OPERATIONAL;
      }
    }
    let lock;
    try {
      lock = acquireDataDirLock(dataDir);
    } catch (err) {
      deps.io.stderr(
        `omp-ui-lite routines spend: ${err instanceof DataDirLockedError ? err.message : err instanceof Error ? err.message : String(err)}`,
      );
      return LITE_EXIT.OPERATIONAL;
    }
    try {
      const registryFile = path.join(dataDir, "registry.json");
      const fresh = !fs.existsSync(registryFile);
      const registry = Registry.load(registryFile);
      seedMemberDefaults(registry, fresh);
      if (!registry.getSetting("routinesEnabled")) {
        deps.io.stderr(`omp-ui-lite routines spend: ${ROUTINES_DISABLED_MESSAGE}`);
        return LITE_EXIT.OPERATIONAL;
      }
      const validated = parseRoutineSpendDefaults({
        warnUsd: parsed.patch.warnUsd ?? registry.getSetting("routineWarnCostUsd"),
        maxUsd: parsed.patch.maxUsd ?? registry.getSetting("routineMaxCostUsd"),
      });
      registry.setSettings({
        routineWarnCostUsd: validated.warnUsd,
        routineMaxCostUsd: validated.maxUsd,
      });
      registry.flush();
      deps.io.stdout(
        `routines spend defaults: warn=$${validated.warnUsd} max=$${validated.maxUsd} — daemon offline`,
      );
      return LITE_EXIT.OK;
    } finally {
      lock.release();
    }
  }

  deps.io.stderr(`omp-ui-lite routines: unknown subcommand "${sub}"`);
  deps.io.stdout(HELP);
  return LITE_EXIT.USAGE;
}

/** Null = alive; otherwise the one-line human reason. */
async function probeLocal(
  url: string,
  token: string,
  connect: typeof connectInstanceClient,
): Promise<string | null> {
  let client: InstanceClient | null = null;
  try {
    client = await withTimeout(connect(url, token), PROBE_TIMEOUT_MS, "connect timed out");
    await withTimeout(client.request("state:get", []), PROBE_TIMEOUT_MS, "state:get timed out");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    client?.close();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const { promise: settled, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(message)), ms);
  timer.unref();
  void promise.then(resolve, reject);
  return settled.finally(() => clearTimeout(timer));
}

// Direct execution (`tsx src/cli.ts …` / a packaged bin): wire the real seams.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runLiteCli(process.argv.slice(2), {
    io: {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
      env: process.env,
    },
    // Production member: open the cipher, build the session cluster over the
    // bundle, and answer the fleet ladder — all composed by bootProductionLite.
    // A legs-build failure still degrades inside serve (one log line, fleet
    // channels absent), so a box with broken exec boots, joins, and gets watched.
    serve: ({ dataDir }) => bootProductionLite({ dataDir }),
    connect: connectInstanceClient,
  });
  process.exit(code);
}
