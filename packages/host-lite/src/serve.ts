import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { CH, Registry, resolveRepositoryKey, type RemoteState } from "@omp-ui/core";
import { mintRemoteToken } from "@omp-ui/server";
import { ensureInstanceId, ensureLiteHome, resolveLiteHome } from "./config";
import { acquireDataDirLockAsync, type DataDirLock } from "./data-dir-lock";
import { startLocalControlServer, type LocalControlServer } from "./local-control";
import { LiteBackend, registryOnlySessions } from "./lite-backend";
import { LiteRemoteServer } from "./remote-server";
import type { FleetLegsHandle } from "./fleet-legs";
import type { LiteKeyCipher, LiteSessions } from "./seams";

/**
 * The headless `lite` fleet member's boot (issue #1010): data dir → registry →
 * stable instance id → the sessions seam (S2; injected, defaults to an honest
 * empty backend) → LiteBackend as RemoteHost → the remote listener on the
 * bind/port/token persisted in the member's own settings. `omp-ui-lite serve`
 * calls this and nothing else does; tests boot the same pipeline with fakes.
 */

export interface LiteServeOptions {
  /** Overrides the `OMP_UI_LITE_HOME`/appData-derived data dir. */
  dataDir?: string;
  /** The version `instance:identity` reports; default from this package's manifest. */
  version?: string;
  /** S2's sessions slice; absent = a member that broadcasts its registry and no session rows. */
  sessions?: LiteSessions;
  /** S3's sealed-secret codec; threaded to the handle for stores that need it, used by nothing yet. */
  cipher?: LiteKeyCipher;
  /**
   * The fleet member-leg table (S4), for tests: a pre-built handle is attached
   * to the backend before the listener starts; absent/null = no fleet channels
   * (owners see `unknown channel`, the same contract an unupgraded desktop
   * gives). Production uses `buildFleet` instead — legs cannot exist before
   * the backend does (their terminal fan-out emits through it).
   */
  fleet?: FleetLegsHandle | null;
  /**
   * Production seam: build the member legs once the backend exists. Called
   * after LiteBackend construction and BEFORE the listener starts, and the
   * handle is attached to the backend before serving, so joined owners see the
   * fleet channels from their very first request. A rejection degrades to a
   * legs-absent member with one log line — broken exec must not prevent the
   * box from joining and being watched.
   */
  buildFleet?: (ctx: {
    backend: LiteBackend;
    sessions: LiteSessions;
    registry: Registry;
    dataDir: string;
    version: string;
  }) => Promise<FleetLegsHandle>;
  /**
   * Production seam: build the session cluster AFTER serve has loaded the one
   * authoritative `Registry` (so the cluster and the backend never hold two
   * divergent in-memory registries for the same file). Called before the
   * backend is constructed; its return replaces `opts.sessions`. Failing here
   * is fatal — a member with no session machinery answers joins with an empty
   * backend, so the CLI's production boot lets the rejection surface.
   */
  buildSessions?: (ctx: {
    registry: Registry;
    dataDir: string;
    version: string;
    instanceId: string;
  }) => Promise<LiteSessions>;
  env?: NodeJS.ProcessEnv;
  /**
   * Skip bringing up the remote listener (status-style unit tests that assert
   * pipeline wiring without grabbing a port). Production boots always listen.
   */
  listen?: boolean;
  /** One line per boot/teardown event; default console. */
  log?: (line: string) => void;
}

export interface LiteInstance {
  readonly dataDir: string;
  readonly instanceId: string;
  readonly registry: Registry;
  readonly backend: LiteBackend;
  readonly remote: LiteRemoteServer;
  /** OS-local control endpoint (`control.sock` on POSIX; loopback HTTP + nonce on Windows). */
  readonly localControl: LocalControlServer;
  /** S3's cipher when injected; null until the keyed store slice lands. */
  readonly cipher: LiteKeyCipher | null;
  readonly sessions: LiteSessions;
  /** Stops the listener, local control server, sessions, and releases the data-dir lock. Idempotent. */
  stop(): Promise<void>;
}

/** A member ships enabled on `lan`: its whole purpose is being joined from another machine. */
const MEMBER_DEFAULTS = { remoteEnabled: true, remoteBind: "lan" as const };

/**
 * Seed the fleet-member defaults on a never-persisted registry (no registry
 * file yet): a headless member nobody has configured should answer joins out
 * of the box. After the first boot the user's `remote:*` choices are law,
 * same as desktop. True = seeded.
 */
export function seedMemberDefaults(registry: Registry, freshInstall: boolean): boolean {
  if (!freshInstall) return false;
  registry.setSettings(MEMBER_DEFAULTS);
  return true;
}

/**
 * Boot-time override for `routinesEnabled` via `OMP_UI_LITE_ROUTINES` (issue #1368).
 * Unset or whitespace-only leaves the persisted setting untouched; `"1"`/`"true"`
 * (case-insensitive) enables; `"0"`/`"false"` disables; any other value throws.
 */
export function applyRoutinesEnvOverride(registry: Registry, env: NodeJS.ProcessEnv): boolean | null {
  const raw = env.OMP_UI_LITE_ROUTINES;
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return null;
  if (normalized === "1" || normalized === "true") {
    registry.setSetting("routinesEnabled", true);
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    registry.setSetting("routinesEnabled", false);
    return false;
  }
  throw new Error(`OMP_UI_LITE_ROUTINES must be 1, true, 0, or false (got "${raw}")`);
}

/**
 * Resolve `repositoryKey` for every project that still has null (issue #903,
 * #1374) so pre-existing registries learn their fleet repo keys without a
 * re-add. One shared callback when any key lands; a failed probe skips just
 * that project and retries on the next boot.
 */
export async function backfillRepositoryKeys(
  registry: Registry,
  onChanged: () => void,
  resolveKey: (cwd: string) => Promise<string | null> = resolveRepositoryKey,
  warn: (line: string) => void = (line) => console.warn(line),
): Promise<void> {
  let changed = false;
  for (const project of registry.projects) {
    if (project.repositoryKey !== null) continue;
    try {
      const key = await resolveKey(project.path);
      if (key === null) continue;
      registry.setProjectRepositoryKey(project.path, key);
      changed = true;
    } catch (err) {
      warn(
        `omp-ui-lite: repositoryKey backfill skipped for ${project.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (changed) onChanged();
}

export async function startLiteFleetMember(opts: LiteServeOptions = {}): Promise<LiteInstance> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const dataDir = ensureLiteHome(opts.dataDir ?? resolveLiteHome(env));
  // Exclusive ownership BEFORE loading Registry or RoutineRunHistory so a
  // duplicate `serve` cannot rewrite persisted state or mark running rows
  // interrupted while another daemon is live.
  let stopFn: (() => Promise<void>) | null = null;
  const lock: DataDirLock = await acquireDataDirLockAsync(dataDir, {
    onLockLost: (reason) => {
      log(`omp-ui-lite: fatal — lost exclusive data-dir lock (${reason}); shutting down to protect data integrity`);
      const shutdown = stopFn ? stopFn() : Promise.resolve();
      void shutdown.finally(() => {
        process.kill(process.pid, "SIGTERM");
      });
    },
  });

  let sessions: LiteSessions | null = null;
  let liveFleet: FleetLegsHandle | null = opts.fleet ?? null;
  let remote: LiteRemoteServer | null = null;
  let localControl: LocalControlServer | null = null;
  let registry: Registry | null = null;
  let backfillPromise: Promise<void> = Promise.resolve();
  let stopped = false;

  try {
    const registryFile = `${dataDir}/registry.json`;
    // Fresh member (no persisted settings yet): seed the fleet-member defaults
    // once. After that the user's `remote:*` choices are law, same as desktop.
    const freshMember = !fs.existsSync(registryFile);
    registry = Registry.load(registryFile);
    if (seedMemberDefaults(registry, freshMember)) {
      log(`omp-ui-lite: first boot — remote access on ${MEMBER_DEFAULTS.remoteBind}`);
    }
    applyRoutinesEnvOverride(registry, env);
    // Mint at boot so `status` and pairing always have a credential, even before the listener first runs.
    if (registry.getSetting("remoteToken") === "") registry.setSetting("remoteToken", mintRemoteToken());
    const instanceId = ensureInstanceId(dataDir, randomUUID);
    if (registry.getSetting("instanceId") !== instanceId) {
      registry.setSetting("instanceId", instanceId);
    }

    // Sessions resolve before the backend (whose constructor subscribes to
    // LiteSessions.on). Production builds the real cluster here through the one
    // authoritative Registry serve just loaded; tests pass `sessions` directly.
    const version = opts.version ?? PACKAGE_VERSION;
    if (opts.buildSessions !== undefined) {
      sessions = await opts.buildSessions({ registry, dataDir, version, instanceId });
    } else {
      sessions = opts.sessions ?? registryOnlySessions(registry);
    }
    // Fleet member legs (S4). A pre-built handle (tests) rides the backend's
    // deps; production builds legs AFTER the backend exists — its terminal
    // fan-out emits through `backend.emit` — and attaches them via a table
    // rebuild BEFORE the listener starts, so a joined owner sees the fleet
    // channels from its very first request. A build failure degrades to a
    // legs-absent member (`unknown channel` on every fleet:*, exactly what an
    // unupgraded desktop gives): broken exec must not stop the box joining.
    // `liveFleet` is whichever handle became active; stop() disposes it.
    const loadedRegistry = registry;
    remote = new LiteRemoteServer({
      host: { handlers: () => backend.handlers(), addSink: (s) => backend.addSink(s) },
      // A member carries no browser bundle unless one is staged beside it; "" serves transport only.
      webRoot: env.OMP_UI_LITE_WEB_ROOT ?? "",
      getSettings: () => ({
        enabled: loadedRegistry.getSetting("remoteEnabled"),
        bind: loadedRegistry.getSetting("remoteBind"),
        port: loadedRegistry.getSetting("remotePort"),
        token: loadedRegistry.getSetting("remoteToken"),
        passwordHash: loadedRegistry.getSetting("remotePasswordHash"),
        passwordSalt: loadedRegistry.getSetting("remotePasswordSalt"),
      }),
      setToken: (token) => loadedRegistry.setSetting("remoteToken", token),
      send: (state: RemoteState) => {
        // Joined owners watch `remote:state` like the desktop renderer does.
        backend.emit(CH.onRemoteState, [state]);
      },
      version,
    });
    const backend = new LiteBackend({
      registry: loadedRegistry,
      sessions,
      instanceId,
      version,
      remote,
      fleet: liveFleet ?? undefined,
    });
    backfillPromise = backfillRepositoryKeys(
      loadedRegistry,
      () => {
        if (stopped) return;
        void backend
          .state()
          .then((state) => {
            if (!stopped) backend.emit(CH.onStateChanged, [state]);
          })
          .catch(() => {});
      },
      undefined,
      log,
    );
    // Production legs exist only after the backend (terminal fan-out needs its
    // emit); build-then-attach lands them in the table before any listener runs.
    if (opts.buildFleet !== undefined) {
      try {
        liveFleet = await opts.buildFleet({ backend, sessions, registry: loadedRegistry, dataDir, version });
        backend.attachFleet(liveFleet);
      } catch (err) {
        log(`omp-ui-lite: fleet legs unavailable (${err instanceof Error ? err.message : String(err)}); fleet channels stay absent`);
      }
    }

    localControl = await startLocalControlServer({
      dataDir,
      routinesControl: sessions.routinesControl,
    });

    if (opts.listen !== false) {
      await remote.apply();
    }
    const live = remote.state;
    if (live.status === "error") throw new Error(`remote listener failed: ${live.error}`);
    if (opts.listen === false) {
      // Boot wiring verified without a socket: nothing to listen on or report.
    } else if (live.status !== "listening") {
      log("omp-ui-lite: remote access is off; set remoteEnabled or use `remote:setEnabled`");
    } else {
      // Never log token-bearing URLs (in token-only mode `live.urls` equals
      // `tokenUrls`): a token in journald outlives rotation. Read pairing URLs
      // via the CLI `status` subcommand or `registry.json` (0600).
      log(`omp-ui-lite: listening on ${live.bind} port ${live.port}; check health with \`omp-ui-lite status\` or read the join token with \`omp-ui-lite token\``);
    }
    if (loadedRegistry.getSetting("routinesEnabled")) {
      const warn = loadedRegistry.getSetting("routineWarnCostUsd");
      const max = loadedRegistry.getSetting("routineMaxCostUsd");
      log(`omp-ui-lite: routines enabled (default spend warn=$${warn} max=$${max})`);
    }

    const activeRemote = remote;
    const activeSessions = sessions;
    const activeControl = localControl;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        await activeRemote.stop();
        await activeControl.close();
        // Legs first after the listener: cancel detached execs and end fleet
        // terminals before the session machinery drains below them.
        liveFleet?.dispose();
        await activeSessions.dispose();
        await Promise.allSettled([backfillPromise]);
        loadedRegistry.flush();
      } finally {
        await (lock.releaseAsync ? lock.releaseAsync() : Promise.resolve(lock.release()));
      }
    };
    stopFn = stop;
    return {
      dataDir,
      instanceId,
      registry: loadedRegistry,
      backend,
      remote: activeRemote,
      localControl: activeControl,
      cipher: opts.cipher ?? null,
      sessions: activeSessions,
      stop,
    };
  } catch (err) {
    // Best-effort cleanup before releasing the exclusive lock.
    await remote?.stop().catch(() => {});
    await localControl?.close().catch(() => {});
    liveFleet?.dispose();
    await sessions?.dispose().catch(() => {});
    stopped = true;
    await Promise.allSettled([backfillPromise]);
    registry?.flush();
    await (lock.releaseAsync ? lock.releaseAsync() : Promise.resolve(lock.release()));
    throw err;
  }
}

declare const __OMP_UI_LITE_VERSION__: string | undefined;

function readManifestVersion(url: URL): string | null {
  try {
    const raw = fs.readFileSync(url, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "version" in parsed) {
      const version: unknown = parsed.version;
      if (typeof version === "string" && version.trim() !== "") return version.trim();
    }
  } catch {
    // Fall through to next candidate.
  }
  return null;
}

/**
 * Resolve the host-lite package version with strict precedence:
 * 1. Compile-time esbuild define (`__OMP_UI_LITE_VERSION__`), when non-empty and not "0.0.0".
 * 2. Sibling `./package.json` (flat container/install layout beside `cli.js`).
 * 3. Parent `../package.json` (workspace `src/` or `dist/` layout).
 * 4. Fallback `"0.0.0"`.
 */
export function resolveLitePackageVersion(
  metaUrl: string = import.meta.url,
  injectedVersion: string | undefined = typeof __OMP_UI_LITE_VERSION__ === "string" ? __OMP_UI_LITE_VERSION__ : undefined,
): string {
  const trimmedInjected = injectedVersion?.trim();
  if (trimmedInjected !== undefined && trimmedInjected !== "" && trimmedInjected !== "0.0.0") {
    return trimmedInjected;
  }
  const sibling = readManifestVersion(new URL("./package.json", metaUrl));
  if (sibling !== null && sibling !== "0.0.0") return sibling;
  const parent = readManifestVersion(new URL("../package.json", metaUrl));
  if (parent !== null) return parent;
  if (sibling !== null) return sibling;
  return "0.0.0";
}

/** Read from compile-time define or manifest at import time; tests override via options. */
export const PACKAGE_VERSION: string = resolveLitePackageVersion(import.meta.url);
