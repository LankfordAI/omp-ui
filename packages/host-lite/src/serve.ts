import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { CH, Registry, type RemoteState } from "@omp-ui/core";
import { mintRemoteToken } from "@omp-ui/server";
import { ensureInstanceId, ensureLiteHome, resolveLiteHome } from "./config";
import { LiteBackend, registryOnlySessions } from "./lite-backend";
import { LiteRemoteServer } from "./remote-server";
import type { FleetLegsHandle } from "./fleet-legs";
import type { LiteKeyCipher, LiteSessions } from "./seams";

/**
 * The headless `lite` fleet member's boot (issue #1010): data dir → registry →
 * stable instance id → the sessions seam (S2; injected, defaults to an honest
 * empty backend) → LiteBackend as RemoteHost → the remote listener on the
 * bind/port/token persisted in the member's own settings. `omp-lite serve`
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
  /** S3's cipher when injected; null until the keyed store slice lands. */
  readonly cipher: LiteKeyCipher | null;
  readonly sessions: LiteSessions;
  /** Stops the listener and disposes the sessions slice. Idempotent. */
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

export async function startLiteFleetMember(opts: LiteServeOptions = {}): Promise<LiteInstance> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const dataDir = ensureLiteHome(opts.dataDir ?? resolveLiteHome(env));
  const registryFile = `${dataDir}/registry.json`;
  // Fresh member (no persisted settings yet): seed the fleet-member defaults
  // once. After that the user's `remote:*` choices are law, same as desktop.
  const freshMember = !fs.existsSync(registryFile);
  const registry = Registry.load(registryFile);
  if (seedMemberDefaults(registry, freshMember)) {
    log(`omp-ui-lite: first boot — remote access on ${MEMBER_DEFAULTS.remoteBind}`);
  }
  // Mint at boot so `status` and pairing always have a credential, even before the listener first runs.
  if (registry.getSetting("remoteToken") === "") registry.setSetting("remoteToken", mintRemoteToken());
  const instanceId = ensureInstanceId(dataDir, randomUUID);

  const sessions = opts.sessions ?? registryOnlySessions(registry);
  // Fleet member legs (S4). A pre-built handle (tests) rides the backend's
  // deps; production builds legs AFTER the backend exists — its terminal
  // fan-out emits through `backend.emit` — and attaches them via a table
  // rebuild BEFORE the listener starts, so a joined owner sees the fleet
  // channels from its very first request. A build failure degrades to a
  // legs-absent member (`unknown channel` on every fleet:*, exactly what an
  // unupgraded desktop gives): broken exec must not stop the box joining.
  // `liveFleet` is whichever handle became active; stop() disposes it.
  let liveFleet: FleetLegsHandle | null = opts.fleet ?? null;
  const remote = new LiteRemoteServer({
    host: { handlers: () => backend.handlers(), addSink: (s) => backend.addSink(s) },
    // A member carries no browser bundle unless one is staged beside it; "" serves transport only.
    webRoot: env.OMP_UI_LITE_WEB_ROOT ?? "",
    getSettings: () => ({
      enabled: registry.getSetting("remoteEnabled"),
      bind: registry.getSetting("remoteBind"),
      port: registry.getSetting("remotePort"),
      token: registry.getSetting("remoteToken"),
      passwordHash: registry.getSetting("remotePasswordHash"),
      passwordSalt: registry.getSetting("remotePasswordSalt"),
    }),
    setToken: (token) => registry.setSetting("remoteToken", token),
    send: (state: RemoteState) => {
      // Joined owners watch `remote:state` like the desktop renderer does.
      backend.emit(CH.onRemoteState, [state]);
    },
    version: opts.version ?? PACKAGE_VERSION,
  });
  const backend = new LiteBackend({
    registry,
    sessions,
    instanceId,
    version: opts.version ?? PACKAGE_VERSION,
    remote,
    fleet: liveFleet ?? undefined,
  });
  // Production legs exist only after the backend (terminal fan-out needs its
  // emit); build-then-attach lands them in the table before any listener runs.
  if (opts.buildFleet !== undefined) {
    try {
      liveFleet = await opts.buildFleet({ backend, sessions, registry, dataDir, version: opts.version ?? PACKAGE_VERSION });
      backend.attachFleet(liveFleet);
    } catch (err) {
      log(`omp-ui-lite: fleet legs unavailable (${err instanceof Error ? err.message : String(err)}); fleet channels stay absent`);
    }
  }

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
    log(`omp-ui-lite: listening on ${live.tokenUrls.join(", ")}`);
  }

  let stopped = false;
  return {
    dataDir,
    instanceId,
    registry,
    backend,
    remote,
    cipher: opts.cipher ?? null,
    sessions,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await remote.stop();
      // Legs first after the listener: cancel detached execs and end fleet
      // terminals before the session machinery drains below them.
      liveFleet?.dispose();
      await sessions.dispose();
    },
  };
}

/** Read from this package's manifest at import time; tests override via options. */
const PACKAGE_VERSION: string = (() => {
  try {
    // new URL against import.meta.url keeps this correct under tsx, vitest, and a bundle.
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "version" in parsed) {
      const version: unknown = parsed.version;
      if (typeof version === "string") return version;
    }
  } catch {
    // Fall through: an unreadable manifest only costs the reported version string.
  }
  return "0.0.0";
})();
