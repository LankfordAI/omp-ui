import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { CH, Registry, type RemoteState } from "@omp-ui/core";
import { mintRemoteToken } from "@omp-ui/server";
import { ensureInstanceId, ensureLiteHome, resolveLiteHome } from "./config";
import { LiteBackend, registryOnlySessions } from "./lite-backend";
import { LiteRemoteServer } from "./remote-server";
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
