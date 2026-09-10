import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  resolveDataRoot,
  type BuildFlavor,
  type HostPairing,
  type HostStatus,
} from "@omp-ui/core";
import {
  connectInstanceClient,
  HOST_PROTOCOL,
  InstanceConnectError,
  type InstanceClient,
} from "@omp-ui/server";
import type { OwnerRecordV1 } from "./authority/lock";
import type { HostConnectionRecordV1 } from "@omp-ui/core";
import type { Supervisor, SupervisorStatus } from "./supervisor";

/**
 * The `omp-ui` command (issue #442 §9, decision #456). Every effect is an
 * injected dependency so the whole command table runs under vitest with a fake
 * host; the SEA entry supplies the real ones. `serve` is foreground-only and
 * arrives injected so this module never imports the boot sequence.
 */

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
}

export interface CliDeps {
  /** This executable's host version; the hello's `clientVersion` and `--version`. */
  version: string;
  flavor: BuildFlavor;
  now: () => number;
  serve: (opts: { dataRoot: string }) => Promise<number>;
  readHostRecord: (dataRoot: string) => HostConnectionRecordV1 | null;
  /** `<dataRoot>/host.lock`; null when absent or unparseable. */
  readLock: (dataRoot: string) => OwnerRecordV1 | null;
  connect: typeof connectInstanceClient;
  supervisor: (io: CliIo) => Supervisor;
  /** Starts the desktop client; resolves to the exit code. */
  launchDesktop: (io: CliIo) => Promise<number>;
  isDesktopInstalled: (io: CliIo) => boolean;
}

export const EXIT = {
  OK: 0,
  OPERATIONAL: 1,
  USAGE: 2,
  ABSENT: 3,
  UNHEALTHY: 4,
  AUTHORITY_CONFLICT: 5,
  UNSUPPORTED: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Two-second authenticated probe, as #456 fixes for `status`. */
const PROBE_TIMEOUT_MS = 2000;
const DEFAULT_STOP_TIMEOUT_S = 30;

export const HELP = `Usage: omp-ui <command> [options]

Commands:
  serve                       Run the host in the foreground (never daemonizes).
  status [--json]             Probe the local host; never loads the registry.
  pair [--all] [--json]       Print the sign-in URL for a running host.
                              --all also prints full-access token URLs.
  stop [--timeout <s>]        Ask the host to hibernate and exit (default 30 s).
  rollback                    Roll the host back to its previous version.
  service install             Install the boot/login supervisor definition.
  service status [--json]     Report the supervisor definition and host state.
  service uninstall [--purge-data --yes]
                              Stop the host and remove the definition; data is
                              preserved unless --purge-data --yes is given.
  desktop                     Start the desktop client.
  (no command)                Start the desktop client when installed, else this help.

Options:
  -h, --help                  Show this help.
  -v, --version               Print the host version.

Exit codes:
  0  completed or healthy
  1  other operational failure
  2  usage or configuration error
  3  absent or not running
  4  present but unhealthy, unresponsive, or incompatible
  5  authority conflict
  6  unsupported platform, unavailable supervisor, or permission failure
`;

type FlagKind = "bool" | "value";

interface ParsedArgs {
  flags: Partial<Record<string, string | true>>;
  positionals: string[];
}

/** Long flags only; `--k v` and `--k=v` both bind a value flag. A string is a usage error. */
function parseArgs(argv: readonly string[], spec: Readonly<Record<string, FlagKind>>): ParsedArgs | string {
  const flags: Partial<Record<string, string | true>> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name];
    if (kind === undefined) return `unknown option ${arg}`;
    if (kind === "bool") {
      if (eq !== -1) return `option --${name} takes no value`;
      flags[name] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") return `option --${name} requires a value`;
    flags[name] = value;
  }
  return { flags, positionals };
}

function usage(io: CliIo, message: string): ExitCode {
  io.stderr(`omp-ui: ${message}\n\n${HELP}`);
  return EXIT.USAGE;
}

function json(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

/** Aligned `key  value` lines; nested objects flatten to dotted keys, arrays print as JSON. */
export function renderLines(value: Record<string, unknown>): string {
  const rows: Array<[string, string]> = [];
  const walk = (prefix: string, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) {
        rows.push([prefix, "{}"]);
        return;
      }
      for (const [k, child] of entries) walk(prefix ? `${prefix}.${k}` : k, child);
      return;
    }
    rows.push([prefix, typeof v === "string" ? v : JSON.stringify(v)]);
  };
  walk("", value);
  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}\n`).join("");
}

function print(io: CliIo, asJson: boolean, value: Record<string, unknown>): void {
  if (asJson) json(io, value);
  else io.stdout(renderLines(value));
}

type ProbeResult =
  | { ok: true; client: InstanceClient }
  | { ok: false; state: "unresponsive" | "incompatible"; reason: string; hostVersion?: string };

async function probe(record: HostConnectionRecordV1, deps: CliDeps): Promise<ProbeResult> {
  try {
    const client = await deps.connect(record.endpoint, record.controlCredential, {
      timeoutMs: PROBE_TIMEOUT_MS,
      hello: {
        clientRole: "browser",
        clientKind: "browser",
        clientVersion: deps.version,
        clientProtocol: HOST_PROTOCOL,
      },
    });
    return { ok: true, client };
  } catch (err) {
    if (err instanceof InstanceConnectError && err.failure.kind === "incompatible") {
      return {
        ok: false,
        state: "incompatible",
        reason: err.failure.reason,
        hostVersion: err.failure.hostVersion,
      };
    }
    return { ok: false, state: "unresponsive", reason: err instanceof Error ? err.message : String(err) };
  }
}

function runtimeOf(record: HostConnectionRecordV1) {
  return {
    pid: record.pid,
    startedAtMs: record.startedAtMs,
    incarnation: record.incarnation,
    endpoint: record.endpoint,
  };
}

function logsOf(dataRoot: string) {
  return { dir: path.join(dataRoot, "logs") };
}

/** Shared by `status` and `service status`: the probe plus every field #456 lists. */
async function hostReport(
  dataRoot: string,
  io: CliIo,
  deps: CliDeps,
): Promise<{ report: Record<string, unknown>; code: ExitCode }> {
  const record = deps.readHostRecord(dataRoot);
  const lock = deps.readLock(dataRoot);
  // A clean stop deletes host.json but leaves host.lock in place with `releasedAtMs`
  // (the lock is never unlinked as cleanup, ADR-0030): that is a stopped host, not a
  // wedged one. A lock without either is an owner that died holding the root.
  if (record === null && (lock === null || lock.releasedAtMs !== undefined)) {
    return {
      report: { schemaVersion: 1, state: "absent", dataRoot, ...(lock === null ? {} : { lastOwner: lock }) },
      code: EXIT.ABSENT,
    };
  }
  if (record === null) {
    return {
      report: {
        schemaVersion: 1,
        state: "unresponsive",
        dataRoot,
        owner: lock,
        reason: "host.lock present without host.json",
        logs: logsOf(dataRoot),
      },
      code: EXIT.UNHEALTHY,
    };
  }
  const probed = await probe(record, deps);
  if (!probed.ok) {
    return {
      report: {
        schemaVersion: 1,
        state: probed.state,
        dataRoot,
        runtime: runtimeOf(record),
        owner: lock,
        versions: {
          host: probed.hostVersion ?? record.hostVersion,
          protocol: record.hostProtocol,
          range: record.protocolRange,
          verdict: probed.state === "incompatible" ? "incompatible" : "unknown",
        },
        reason: probed.reason,
        logs: logsOf(dataRoot),
      },
      code: EXIT.UNHEALTHY,
    };
  }
  const { client } = probed;
  let status: HostStatus;
  try {
    status = await client.request<HostStatus>("host:status", []);
  } catch (err) {
    client.close();
    return {
      report: {
        schemaVersion: 1,
        state: "unresponsive",
        dataRoot,
        runtime: runtimeOf(record),
        owner: lock,
        reason: err instanceof Error ? err.message : String(err),
        logs: logsOf(dataRoot),
      },
      code: EXIT.UNHEALTHY,
    };
  }
  client.close();
  return {
    report: {
      schemaVersion: 1,
      state: "running",
      dataRoot,
      runtime: runtimeOf(record),
      owner: lock,
      versions: {
        host: record.hostVersion,
        protocol: record.hostProtocol,
        range: record.protocolRange,
        verdict: client.hello?.verdict ?? "unknown",
      },
      staged: {
        matchesCurrent: status.hostUpdate.stagedVersion === null || status.hostUpdate.currentIsStaged,
      },
      lastUpdateAttempt: status.hostUpdate.lastAttempt,
      rollbackVersion: status.hostUpdate.rollbackVersion,
      verifier: status.verifier,
      credentialBackend: status.credentialBackend,
      supervisor: await deps.supervisor(io).status(),
      logs: logsOf(dataRoot),
    },
    code: EXIT.OK,
  };
}

/** A running host or the exit code that explains why not (3 absent, 4 unreachable). */
async function requireHost(
  dataRoot: string,
  io: CliIo,
  deps: CliDeps,
): Promise<{ client: InstanceClient; record: HostConnectionRecordV1 } | ExitCode> {
  const record = deps.readHostRecord(dataRoot);
  if (record === null) {
    io.stderr(`omp-ui: no host running for ${dataRoot}\n`);
    return EXIT.ABSENT;
  }
  const probed = await probe(record, deps);
  if (!probed.ok) {
    io.stderr(`omp-ui: host at ${record.endpoint} (pid ${record.pid}) is ${probed.state}: ${probed.reason}\n`);
    return EXIT.UNHEALTHY;
  }
  return { client: probed.client, record };
}

async function cmdStatus(argv: string[], io: CliIo, deps: CliDeps, dataRoot: string): Promise<ExitCode> {
  const parsed = parseArgs(argv, { json: "bool" });
  if (typeof parsed === "string") return usage(io, parsed);
  if (parsed.positionals.length > 0) return usage(io, `unexpected argument ${parsed.positionals[0]}`);
  const { report, code } = await hostReport(dataRoot, io, deps);
  print(io, parsed.flags.json === true, report);
  return code;
}

async function cmdPair(argv: string[], io: CliIo, deps: CliDeps, dataRoot: string): Promise<ExitCode> {
  const parsed = parseArgs(argv, { all: "bool", json: "bool" });
  if (typeof parsed === "string") return usage(io, parsed);
  if (parsed.positionals.length > 0) return usage(io, `unexpected argument ${parsed.positionals[0]}`);
  const host = await requireHost(dataRoot, io, deps);
  if (typeof host === "number") return host;
  let pairing: HostPairing;
  try {
    pairing = await host.client.request<HostPairing>("host:pair", []);
  } catch (err) {
    io.stderr(`omp-ui: pairing failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.OPERATIONAL;
  } finally {
    host.client.close();
  }
  const all = parsed.flags.all === true;
  if (parsed.flags.json === true) {
    json(io, {
      schemaVersion: 1,
      hasPassword: pairing.hasPassword,
      urls: pairing.urls,
      ...(all ? { tokenUrls: pairing.tokenUrls } : {}),
    });
    return EXIT.OK;
  }
  const label = pairing.hasPassword ? "password sign-in" : "sign-in";
  let out = "";
  for (const url of pairing.urls) out += `${label}: ${url}\n`;
  if (all) for (const url of pairing.tokenUrls) out += `full access (token): ${url}\n`;
  io.stdout(out);
  return EXIT.OK;
}

/** Asks a live host to stop and waits for the socket to close; bounded, never force-kills. */
async function stopHost(
  io: CliIo,
  deps: CliDeps,
  dataRoot: string,
  timeoutMs: number,
): Promise<ExitCode> {
  const record = deps.readHostRecord(dataRoot);
  if (record === null) {
    io.stdout("no host running\n");
    return EXIT.OK;
  }
  const probed = await probe(record, deps);
  if (!probed.ok) {
    io.stderr(`omp-ui: host at ${record.endpoint} (pid ${record.pid}) is ${probed.state}: ${probed.reason}\n`);
    return EXIT.UNHEALTHY;
  }
  const { client } = probed;
  const outcome = await new Promise<"closed" | "timeout" | Error>((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    const settle = (v: "closed" | Error) => {
      clearTimeout(timer);
      resolve(v);
    };
    client.onClose(() => settle("closed"));
    client.request("host:stop", []).catch((err: unknown) => {
      // A socket the host closed mid-request rejects every pending request; onClose
      // settles that path as success. Anything else is the host refusing.
      queueMicrotask(() => settle(err instanceof Error ? err : new Error(String(err))));
    });
  });
  if (outcome === "closed") {
    io.stdout(`stopped host pid ${record.pid}\n`);
    return EXIT.OK;
  }
  client.close();
  if (outcome === "timeout") {
    io.stderr(
      `omp-ui: host pid ${record.pid} (${record.endpoint}) did not exit within ${timeoutMs / 1000} s; ` +
        `not killed. Logs: ${logsOf(dataRoot).dir}\n`,
    );
    return EXIT.UNHEALTHY;
  }
  io.stderr(`omp-ui: stop refused: ${outcome.message}\n`);
  return EXIT.OPERATIONAL;
}

async function cmdStop(argv: string[], io: CliIo, deps: CliDeps, dataRoot: string): Promise<ExitCode> {
  const parsed = parseArgs(argv, { timeout: "value" });
  if (typeof parsed === "string") return usage(io, parsed);
  if (parsed.positionals.length > 0) return usage(io, `unexpected argument ${parsed.positionals[0]}`);
  const raw = parsed.flags.timeout;
  let seconds = DEFAULT_STOP_TIMEOUT_S;
  if (typeof raw === "string") {
    seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return usage(io, `--timeout must be a positive number of seconds, got ${raw}`);
  }
  return stopHost(io, deps, dataRoot, seconds * 1000);
}

async function cmdRollback(argv: string[], io: CliIo, deps: CliDeps, dataRoot: string): Promise<ExitCode> {
  const parsed = parseArgs(argv, {});
  if (typeof parsed === "string") return usage(io, parsed);
  if (parsed.positionals.length > 0) return usage(io, `unexpected argument ${parsed.positionals[0]}`);
  const host = await requireHost(dataRoot, io, deps);
  if (typeof host === "number") return host;
  try {
    await host.client.request("host-update:rollback", []);
  } catch (err) {
    io.stderr(`omp-ui: rollback failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.OPERATIONAL;
  } finally {
    host.client.close();
  }
  io.stdout("rollback requested; the host restarts on its previous version\n");
  return EXIT.OK;
}

const UNSUPPORTED_INSTALL = /^(unsupported platform|linger not enabled|foreign supervisor definition)|\b(EACCES|EPERM)\b/;

function supervisorExit(kind: "install" | "uninstall", io: CliIo, err: unknown): ExitCode {
  const message = err instanceof Error ? err.message : String(err);
  io.stderr(`omp-ui: service ${kind} failed: ${message}\n`);
  return UNSUPPORTED_INSTALL.test(message) ? EXIT.UNSUPPORTED : EXIT.OPERATIONAL;
}

function supervisorStatusExit(io: CliIo, status: SupervisorStatus): ExitCode {
  if (status.kind === "absent") return EXIT.ABSENT;
  if (status.kind === "unsupported") return EXIT.UNSUPPORTED;
  if (status.foreign) {
    io.stderr(`omp-ui: the definition at ${status.path} is not owned by omp-ui; leaving it untouched\n`);
    return EXIT.UNSUPPORTED;
  }
  return status.running ? EXIT.OK : EXIT.UNHEALTHY;
}

async function cmdService(argv: string[], io: CliIo, deps: CliDeps, dataRoot: string): Promise<ExitCode> {
  const [verb, ...rest] = argv;
  switch (verb) {
    case "install": {
      const parsed = parseArgs(rest, {});
      if (typeof parsed === "string") return usage(io, parsed);
      if (parsed.positionals.length > 0) return usage(io, `unexpected argument ${parsed.positionals[0]}`);
      const supervisor = deps.supervisor(io);
      const execPath = io.env.OMP_UI_EXEC_PATH || process.execPath;
      try {
        await supervisor.install({ execPath, dataRoot, logDir: logsOf(dataRoot).dir });
      } catch (err) {
        return supervisorExit("install", io, err);
      }
      io.stdout(`installed ${supervisor.id} definition at ${supervisor.definitionPath}\n`);
      return EXIT.OK;
    }
    case "status": {
      const parsed = parseArgs(rest, { json: "bool" });
      if (typeof parsed === "string") return usage(io, parsed);
      if (parsed.positionals.length > 0) return usage(io, `unexpected argument ${parsed.positionals[0]}`);
      const status = await deps.supervisor(io).status();
      const code = supervisorStatusExit(io, status);
      const host = await hostReport(dataRoot, io, deps);
      print(io, parsed.flags.json === true, { schemaVersion: 1, supervisor: status, host: host.report });
      // Healthy needs both an owned, running definition and a responsive host.
      return code === EXIT.OK ? host.code : code;
    }
    case "uninstall": {
      const parsed = parseArgs(rest, { "purge-data": "bool", yes: "bool" });
      if (typeof parsed === "string") return usage(io, parsed);
      if (parsed.positionals.length > 0) return usage(io, `unexpected argument ${parsed.positionals[0]}`);
      const purge = parsed.flags["purge-data"] === true;
      if (purge && parsed.flags.yes !== true) {
        return usage(io, `--purge-data deletes ${dataRoot} and every project, session, credential, and worktree record in it; pass --yes to confirm`);
      }
      // A host that stays alive keeps its definition: uninstall never orphans a running owner.
      const stopped = await stopHost(io, deps, dataRoot, DEFAULT_STOP_TIMEOUT_S * 1000);
      if (stopped !== EXIT.OK) return stopped;
      const supervisor = deps.supervisor(io);
      try {
        await supervisor.uninstall(purge ? { purgeData: true, dataRoot } : { purgeData: false });
      } catch (err) {
        return supervisorExit("uninstall", io, err);
      }
      io.stdout(purge ? `removed ${supervisor.id} definition and purged ${dataRoot}\n` : `removed ${supervisor.id} definition; data preserved at ${dataRoot}\n`);
      return EXIT.OK;
    }
    case undefined:
      return usage(io, "service needs one of: install, status, uninstall");
    default:
      return usage(io, `unknown service command ${verb}`);
  }
}

/** Canonical desktop artifact per platform (ADR-0011 on Linux); null where none is defined. */
export function desktopArtifactPath(io: CliIo): string | null {
  switch (io.platform) {
    case "linux":
      return path.posix.join(io.home, ".local", "bin", "omp-ui.AppImage");
    case "win32":
      return path.win32.join(
        io.env.LOCALAPPDATA || path.win32.join(io.home, "AppData", "Local"),
        "Programs",
        "omp-ui",
        "omp-ui.exe",
      );
    case "darwin":
      return "/Applications/omp-ui.app";
    default:
      return null;
  }
}

export interface DesktopLaunchDeps {
  exists: (p: string) => boolean;
  spawn: typeof spawn;
}

const realLaunch: DesktopLaunchDeps = { exists: existsSync, spawn };

/**
 * Linux only: `packaging/install.sh` also installs `~/.local/bin/omp-ui-desktop`,
 * a wrapper that falls back to extract-and-run where FUSE is missing. Launch
 * prefers it; the AppImage itself stays the canonical artifact (ADR-0011).
 */
function linuxDesktopWrapper(io: CliIo): string {
  return path.posix.join(io.home, ".local", "bin", "omp-ui-desktop");
}

/** The executable `defaultLaunchDesktop` starts: the Linux wrapper when present, else the artifact. */
function desktopLaunchPath(io: CliIo, exists: (p: string) => boolean): string | null {
  const artifact = desktopArtifactPath(io);
  if (artifact === null) return null;
  if (io.platform === "linux" && exists(linuxDesktopWrapper(io))) return linuxDesktopWrapper(io);
  return artifact;
}

export function defaultIsDesktopInstalled(io: CliIo, exists: (p: string) => boolean = existsSync): boolean {
  const artifact = desktopArtifactPath(io);
  if (artifact === null) return false;
  if (io.platform === "darwin") {
    return exists(artifact) || exists(path.posix.join(io.home, "Applications", "omp-ui.app"));
  }
  if (io.platform === "linux") return exists(linuxDesktopWrapper(io)) || exists(artifact);
  return exists(artifact);
}

/**
 * Starts the desktop client detached so the CLI can exit: the wrapper or the
 * AppImage on Linux, `open -a` on macOS, the installed exe on Windows. An
 * absent client is an operational error, not a usage one.
 */
export async function defaultLaunchDesktop(io: CliIo, launch: DesktopLaunchDeps = realLaunch): Promise<number> {
  const target = desktopLaunchPath(io, launch.exists);
  if (target === null) {
    io.stderr(`omp-ui: no desktop client is defined for ${io.platform}\n`);
    return EXIT.UNSUPPORTED;
  }
  if (!defaultIsDesktopInstalled(io, launch.exists)) {
    io.stderr(`omp-ui: desktop client not installed at ${target}\n`);
    return EXIT.OPERATIONAL;
  }
  const [command, args] =
    io.platform === "darwin" ? ["open", ["-a", "omp-ui"]] : [target, [] as string[]];
  // Executor form (not Promise.withResolvers): the node tsconfig lib is ES2022.
  return new Promise<number>((resolve) => {
    const child = launch.spawn(command, args, { detached: true, stdio: "ignore", env: io.env });
    child.once("error", (err) => {
      io.stderr(`omp-ui: could not start ${command}: ${err.message}\n`);
      resolve(EXIT.OPERATIONAL);
    });
    child.once("spawn", () => {
      child.unref();
      resolve(EXIT.OK);
    });
  });
}

export async function runCli(argv: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    if (deps.isDesktopInstalled(io)) return deps.launchDesktop(io);
    io.stdout(HELP);
    return EXIT.OK;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    io.stdout(HELP);
    return EXIT.OK;
  }
  if (command === "--version" || command === "-v") {
    io.stdout(`${deps.version}\n`);
    return EXIT.OK;
  }
  let dataRoot: string;
  try {
    dataRoot = resolveDataRoot(deps.flavor, io.env, io.platform, io.home);
  } catch (err) {
    io.stderr(`omp-ui: invalid data root: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.USAGE;
  }
  switch (command) {
    case "serve": {
      const parsed = parseArgs(rest, {});
      if (typeof parsed === "string") return usage(io, parsed);
      if (parsed.positionals.length > 0) return usage(io, `unexpected argument ${parsed.positionals[0]}`);
      return deps.serve({ dataRoot });
    }
    case "status":
      return cmdStatus(rest, io, deps, dataRoot);
    case "pair":
      return cmdPair(rest, io, deps, dataRoot);
    case "stop":
      return cmdStop(rest, io, deps, dataRoot);
    case "rollback":
      return cmdRollback(rest, io, deps, dataRoot);
    case "service":
      return cmdService(rest, io, deps, dataRoot);
    case "desktop": {
      const parsed = parseArgs(rest, {});
      if (typeof parsed === "string") return usage(io, parsed);
      if (parsed.positionals.length > 0) return usage(io, `unexpected argument ${parsed.positionals[0]}`);
      return deps.launchDesktop(io);
    }
    default:
      return usage(io, `unknown command ${command}`);
  }
}
