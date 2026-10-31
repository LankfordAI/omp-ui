import { Registry } from "@omp-ui/core";
import { connectInstanceClient, type InstanceClient } from "@omp-ui/server";
import { pathToFileURL } from "node:url";
import { ensureLiteHome, resolveLiteHome } from "./config";
import { buildProductionFleetLegs } from "./production-legs";
import { startLiteFleetMember } from "./serve";

/**
 * The `omp-lite` command (issue #1010): `serve` runs the headless fleet member
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

const HELP = `Usage: omp-lite <command>

Commands:
  serve       Run the headless fleet member in the foreground (never daemonizes).
  status      Print the local listener's bind/port/url and whether it answers state:get.
  help        Show this help.

Environment:
  OMP_UI_LITE_HOME   Data dir override (default: <appData>/omp-ui-lite[-dev]).
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
  deps.io.stderr(`omp-lite: unknown command "${command}"`);
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
    deps.io.stderr(`omp-lite serve: ${err instanceof Error ? err.message : String(err)}`);
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
    // Production member: answer the fleet ladder too. A legs-build failure
    // degrades inside serve (one log line, fleet channels absent) rather than
    // here, so a box with broken exec still boots, joins, and gets watched.
    serve: ({ dataDir }) => startLiteFleetMember({ dataDir, buildFleet: buildProductionFleetLegs }),
    connect: connectInstanceClient,
  });
  process.exit(code);
}
