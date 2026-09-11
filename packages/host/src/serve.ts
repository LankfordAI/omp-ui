import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  appendMainLog,
  canonicalDataRoot,
  createBreadcrumbRing,
  RegistryCorrupt,
  type BreadcrumbSink,
  type BuildFlavor,
} from "@omp-ui/core";
import { connectInstanceClient, HOST_PROTOCOL } from "@omp-ui/server";
import {
  AuthorityConflict,
  claimAuthority,
  LOCK_LOST_EXIT_CODE,
  type AuthorityDeps,
  type ClaimedAuthority,
} from "./authority/authority";
import { ChildrenLedger, LedgerUnresolved, type ChildrenLedgerDeps } from "./authority/children-ledger";
import { ownProcessStartMs, processAlive, readBootId } from "./authority/process-identity";
import { EXIT } from "./cli";
import type { HostConnectionRecordV1 } from "@omp-ui/core";
import { startLocalControl, type LocalControl } from "./control/local-control";
import { asBuffer, DEK_WORKER_TIMEOUT_MS, runProtectorInWorker } from "./credentials/dek-worker";
import { DekTimeout, isHostEnvelope, openHostKeyCipher, type KeyProtector } from "./credentials/host-key-cipher";
import { lookupLinuxSecretServiceMany } from "./credentials/linux-secret-service";
import { selectProtector } from "./credentials/protector";
import { HostApplication, type HostApplicationDeps, type HostUpdateHandoverDeps } from "./host-application";
import { handoffCredentials, type ElectronBlobReader } from "./migration/credential-handoff";
import { consumeCutoverHandoff } from "./migration/cutover-handoff";
import { MigrationJournal } from "./migration/journal";
import {
  LINUX_SAFE_STORAGE_APPLICATIONS,
  LINUX_SAFE_STORAGE_SCHEMA,
  readElectronSafeStorage as readLinuxSafeStorage,
} from "./migration/linux-electron";
import {
  keychainSafeStoragePassword,
  readElectronSafeStorage as readMacosSafeStorage,
} from "./migration/macos-electron";
import { legacyUserDataFromRelocation, relocateAuthorityStores } from "./migration/relocate";
import {
  readElectronSafeStorage as readWindowsSafeStorage,
  readLocalStateEncryptedKey,
  WINDOWS_KEY_PREFIX,
} from "./migration/windows-electron";
import {
  downloadHostArchive,
  fetchHostFeed,
  sha512File,
  spawnStagedHost,
  switchCurrent,
  unpackHostArchive,
} from "./update/host-update-deps";

/**
 * The host's foreground boot sequence (issue #442 §9; #450): the one place
 * the authority claim, the children ledger, the one-shot migration, the
 * credential cipher, the application, the loopback control plane, and the
 * host's own updater are composed, in that fixed order. `omp-ui serve` calls
 * it and nothing else does; every step leaves an `authority` breadcrumb and a
 * `log` line so a boot that stopped can be read back from `logs/main.log` and
 * `logs/breadcrumbs.log`.
 */

/** The updater's feed/archive/replacement machinery; production takes every default from `host-update-deps`. */
export type ServeHandoverDeps = Pick<
  HostUpdateHandoverDeps,
  "fetchFeed" | "download" | "sha512File" | "unpack" | "spawnStaged" | "limits"
> & {
  /** Re-points the installed layout's `current` at the committed version dir (issue #442 §10.1). */
  switchCurrent: (versionDir: string) => void;
};

/** Seams for the boot-order unit test; production takes every default. */
export interface ServeDeps {
  claim: typeof claimAuthority;
  ledger: (dataRoot: string, deps: ChildrenLedgerDeps) => ChildrenLedger;
  protector: (dataRoot: string) => KeyProtector;
  /** `true` when the host `record` describes still authenticates a probe (a veto on the claim). */
  probe: (record: HostConnectionRecordV1) => Promise<boolean>;
  now: () => number;
  /** Bounded legacy Chromium password lookup; tests never contact the workstation keyring. */
  lookupLinuxSecretServiceMany?: typeof lookupLinuxSecretServiceMany;
  handover?: Partial<ServeHandoverDeps>;
}

export interface ServeOptions {
  dataRoot: string;
  hostVersion: string;
  flavor: BuildFlavor;
  /** Directory holding the built browser bundle for remote clients; "" serves the transport only. */
  webRoot: string;
  verifier: HostApplicationDeps["verifier"];
  /**
   * Electron's userData dir to migrate from when no live Electron instance
   * left a cutover note; null (the installed binary's default) migrates only
   * on a note.
   */
  legacyUserData?: string | null;
  /** Where SIGINT/SIGTERM arrive; default `process`. */
  signals?: NodeJS.EventEmitter;
  env?: NodeJS.ProcessEnv;
  /** Default: stdout plus `<dataRoot>/logs/main.log`. */
  log?: (line: string) => void;
  deps?: Partial<ServeDeps>;
}

/** How long the claim's veto probe waits for the recorded host to answer. */
const PROBE_TIMEOUT_MS = 2000;

const execFileAsync = promisify(execFile);

/** Electron's `app.getName()`: electron-builder's productName when packaged, package.json's name in dev. */
const ELECTRON_APP_NAME: Readonly<Record<BuildFlavor, string>> = {
  installed: "omp-ui",
  dev: "@omp-ui/desktop",
  "dev-server": "@omp-ui/desktop",
};

/** Dials the recorded host as the CLI does and asks it `host:status`; any failure is "not live". */
async function defaultProbe(record: HostConnectionRecordV1): Promise<boolean> {
  try {
    const client = await connectInstanceClient(record.endpoint, record.controlCredential, {
      timeoutMs: PROBE_TIMEOUT_MS,
      hello: {
        clientRole: "browser",
        clientKind: "browser",
        clientVersion: record.hostVersion,
        clientProtocol: HOST_PROTOCOL,
      },
    });
    try {
      await client.request("host:status", []);
      return true;
    } finally {
      client.close();
    }
  } catch {
    return false;
  }
}

/** Every base64 credential blob the two stores hold; a missing or unreadable store contributes none. */
function storedBlobs(dataRoot: string): Buffer[] {
  const blobs: Buffer[] = [];
  const parse = (name: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataRoot, name), "utf8"));
    } catch {
      return undefined;
    }
  };
  const keys = parse("provider-keys.json");
  if (keys !== null && typeof keys === "object" && "keys" in keys && keys.keys !== null && typeof keys.keys === "object") {
    for (const value of Object.values(keys.keys)) {
      if (typeof value === "string") blobs.push(Buffer.from(value, "base64"));
    }
  }
  const instances = parse("remote-instances.json");
  if (instances !== null && typeof instances === "object" && "instances" in instances && Array.isArray(instances.instances)) {
    for (const instance of instances.instances) {
      if (instance !== null && typeof instance === "object" && "credential" in instance && typeof instance.credential === "string") {
        blobs.push(Buffer.from(instance.credential, "base64"));
      }
    }
  }
  return blobs;
}

/**
 * The platform's reader for Electron `safeStorage` blobs. A keyring secret the
 * host cannot reach reads as `"locked"`, which keeps the handoff step open for
 * a later run rather than dropping a credential:
 * - Linux: `v10` blobs decrypt under Chromium's fixed password; `v11` needs the
 *   keyring's "<App> Safe Storage" item, which no host-side lookup exists for.
 * - macOS: the login Keychain via `security`.
 * - Windows: the `Local State` session key is unwrapped once, on the DPAPI
 *   Worker with its deadline, so the synchronous reader never blocks the boot.
 */
async function electronReader(
  platform: NodeJS.Platform,
  legacyUserData: string,
  flavor: BuildFlavor,
  dataRoot: string,
  lookupLinuxPasswords: typeof lookupLinuxSecretServiceMany,
): Promise<ElectronBlobReader> {
  switch (platform) {
    case "darwin":
      return (blob) =>
        readMacosSafeStorage(blob, {
          readKeychainPassword: () => keychainSafeStoragePassword(ELECTRON_APP_NAME[flavor]),
        });
    case "win32": {
      const encryptedKey = readLocalStateEncryptedKey(legacyUserData);
      const wrapped =
        encryptedKey !== null && encryptedKey.subarray(0, WINDOWS_KEY_PREFIX.length).equals(WINDOWS_KEY_PREFIX)
          ? encryptedKey.subarray(WINDOWS_KEY_PREFIX.length)
          : encryptedKey;
      // null: locked (no key, or the Worker timed out); Error: DPAPI refused it (foreign).
      let sessionKey: Buffer | null | Error = null;
      if (wrapped !== null) {
        try {
          const value = await runProtectorInWorker(
            { backend: "windows-dpapi", dataRoot },
            { name: "unprotect", args: [wrapped] },
            DEK_WORKER_TIMEOUT_MS,
          );
          sessionKey = asBuffer(value, "Electron session key");
        } catch (error) {
          sessionKey = error instanceof DekTimeout ? null : error instanceof Error ? error : new Error(String(error));
        }
      }
      return (blob) =>
        readWindowsSafeStorage(blob, {
          encryptedKey,
          dpapiUnprotect: (candidate) => {
            if (sessionKey instanceof Error) throw sessionKey;
            // Only the session key was unwrapped; a legacy raw-DPAPI blob stays locked.
            return sessionKey !== null && wrapped !== null && candidate.equals(wrapped) ? sessionKey : null;
          },
        });
    }
    default: {
      let passwords: string[] | null = null;
      try {
        const secrets = await lookupLinuxPasswords(
          dataRoot,
          LINUX_SAFE_STORAGE_SCHEMA,
          LINUX_SAFE_STORAGE_APPLICATIONS.map((application) => ({ application })),
        );
        passwords = secrets.map((secret) => secret.toString("utf8")).filter((password) => password.length > 0);
      } catch {
        passwords = null;
      }
      return (blob) => readLinuxSafeStorage(blob, { passwords });
    }
  }
}

/**
 * Runs the host until a stop: SIGINT/SIGTERM, a `host:stop` control request,
 * or a committed update handover (the replacement owns the root; this process
 * exits so the supervisor's `KillMode=process` leaves the replacement alone).
 * Resolves with the process exit code: 0 after any of those,
 * {@link EXIT.AUTHORITY_CONFLICT} when another authority owns the root, 1 for
 * any other boot failure — every path releases the token and closes the
 * control plane before returning.
 */
export async function serve(opts: ServeOptions): Promise<number> {
  const now = opts.deps?.now ?? Date.now;
  const claim = opts.deps?.claim ?? claimAuthority;
  const probe = opts.deps?.probe ?? defaultProbe;
  const signals = opts.signals ?? process;
  const platform = process.platform;

  const root = canonicalDataRoot(opts.dataRoot, platform);
  fs.mkdirSync(root, { recursive: true });
  const logDir = path.join(root, "logs");
  const log =
    opts.log ??
    ((line: string) => {
      console.log(`[host] ${line}`);
      appendMainLog(logDir, "main.log", line);
    });
  const breadcrumbs: BreadcrumbSink = createBreadcrumbRing(logDir);
  const step = (detail: string): void => {
    breadcrumbs.record("authority", { detail: `boot: ${detail}` });
    log(detail);
  };
  step(`data root ${root} (${opts.flavor} ${opts.hostVersion})`);

  const processStartMs = ownProcessStartMs(platform);
  const claimDeps: AuthorityDeps = {
    hostVersion: opts.hostVersion,
    flavor: opts.flavor,
    probe,
    processAlive: (pid, startMs) => processAlive(pid, startMs, platform),
    bootId: () => readBootId(platform),
    now,
    breadcrumbs,
    processStartMs,
    onLockLost: () => {
      log(`host.lock no longer names this process; exiting ${LOCK_LOST_EXIT_CODE}`);
      process.exit(LOCK_LOST_EXIT_CODE);
    },
  };
  let token: ClaimedAuthority;
  try {
    token = await claim(root, claimDeps);
  } catch (error) {
    if (error instanceof AuthorityConflict) {
      step(`authority conflict: ${error.message}`);
      return EXIT.AUTHORITY_CONFLICT;
    }
    throw error;
  }
  step(`authority claimed incarnation=${token.incarnation}`);

  // One stop for every reason; the first wins and the rest are ignored.
  // Executor form (not Promise.withResolvers): the node tsconfig lib is ES2022.
  let resolveStop: (reason: string) => void = () => {};
  const stopping = new Promise<string>((resolve) => {
    resolveStop = resolve;
  });
  let host: HostApplication | null = null;
  let control: LocalControl | null = null;
  try {
    const ledger = (opts.deps?.ledger ?? ((dataRoot, deps) => new ChildrenLedger(dataRoot, deps)))(root, {
      bootId: () => readBootId(platform),
      processAlive: (pid, startMs) => processAlive(pid, startMs, platform),
      now,
      breadcrumbs,
    });
    await ledger.reconcileBeforeLoad();
    step("children ledger reconciled");

    const journal = MigrationJournal.open(root, { now });
    const handoff = consumeCutoverHandoff(root, {
      now,
      processAlive: (pid, startMs) => processAlive(pid, startMs, platform),
      platform,
      breadcrumbs,
    });
    const legacy = handoff?.legacyUserData ?? opts.legacyUserData ?? legacyUserDataFromRelocation(journal);
    if (legacy !== null && journal.step("relocate-authority-stores-v1")?.status !== "committed") {
      await relocateAuthorityStores({
        legacyUserData: legacy,
        dataRoot: root,
        journal,
        git: async (args, cwd) => {
          try {
            const { stdout, stderr } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
            return { code: 0, stdout, stderr };
          } catch (error) {
            const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
          }
        },
        breadcrumbs,
      });
      step(`authority stores relocated from ${legacy}`);
    } else {
      step(legacy === null ? "no legacy userData to migrate" : "authority stores already relocated");
    }

    const protector = (opts.deps?.protector ?? ((dataRoot) => selectProtector(dataRoot, platform)))(root);
    const cipher = await openHostKeyCipher(protector, {
      hasCiphertext: storedBlobs(root).some(isHostEnvelope),
    });
    step(`credential cipher ${cipher.backend} ${cipher.available ? "available" : "degraded"}`);
    if (cipher.available && legacy !== null && journal.step("credential-handoff-v1")?.status !== "committed") {
      const { complete } = await handoffCredentials({
        dataRoot: root,
        journal,
        read: await electronReader(
          platform,
          legacy,
          opts.flavor,
          root,
          opts.deps?.lookupLinuxSecretServiceMany ?? lookupLinuxSecretServiceMany,
        ),
        encrypt: (plain) => cipher.encrypt(plain),
        isHostEnvelope,
        breadcrumbs,
      });
      step(complete ? "credential handoff committed" : "credential handoff left open: a keyring secret is locked; retried next boot");
    }

    host = new HostApplication({
      paths: {
        dataRoot: root,
        registryFile: path.join(root, "registry.json"),
        providerKeysFile: path.join(root, "provider-keys.json"),
        remoteInstancesFile: path.join(root, "remote-instances.json"),
        worktreesRoot: path.join(root, "worktrees"),
        oauthScratchDir: path.join(root, "oauth-login"),
        logDir,
        webRoot: opts.webRoot,
      },
      hostVersion: opts.hostVersion,
      cipher,
      authority: token,
      verifier: opts.verifier,
      breadcrumbs,
      ledger,
      recoveryPolicy: "stop",
      requestStop: () => resolveStop("host:stop"),
    });
    step("registry loaded; application constructed");

    const openControl = async (incarnation: number): Promise<LocalControl> =>
      startLocalControl({
        surface: host!,
        dataRoot: root,
        hostVersion: opts.hostVersion,
        processStartMs,
        incarnation,
        now,
        breadcrumbs,
      });
    control = await openControl(token.incarnation);
    step(`control plane listening at ${control.record.endpoint}`);

    // The host's own updater (issue #442 §10.2). Its handover half lives here
    // because only the boot sequence holds the token and the control plane. A
    // dev-flavour host has no installed layout to switch, so it stays idle
    // (the env override exercises the real flow against a release, like the
    // desktop's OMP_UI_APP_UPDATE_ENABLE).
    const handover = opts.deps?.handover ?? {};
    const env = opts.env ?? process.env;
    if (opts.flavor === "installed" || env.OMP_UI_HOST_UPDATE_ENABLE === "1") host.attachHostUpdater({
      fetchFeed: handover.fetchFeed ?? (() => fetchHostFeed(platform, process.arch)),
      download: handover.download ?? downloadHostArchive,
      sha512File: handover.sha512File ?? sha512File,
      unpack: handover.unpack ?? unpackHostArchive,
      spawnStaged:
        handover.spawnStaged ??
        ((versionDir, spawnOpts) =>
          spawnStagedHost(versionDir, spawnOpts, { platform, hostVersion: opts.hostVersion, env: opts.env, now })),
      limits: handover.limits,
      // Release only stops asserting and marks the record; the lock name stays for the replacement's takeover.
      releaseAuthority: () => token.release(),
      // The replacement never acknowledged and is dead: the ordinary claim path takes the root back, and the
      // listeners the drain closed come back under the new incarnation.
      reclaimAuthority: async () => {
        token = await claim(root, claimDeps);
        host!.adoptAuthority(token);
        control = await openControl(token.incarnation);
        await host!.startRemote();
        step(`authority reclaimed incarnation=${token.incarnation}; control plane at ${control.record.endpoint}`);
      },
      drainListeners: async () => {
        await host!.drainRemote();
        await control?.close();
        control = null;
        step("listeners drained for handover");
      },
      afterCommit: (versionDir) => {
        try {
          (handover.switchCurrent ?? ((dir) => switchCurrent(dir, { platform, env: opts.env, dataRoot: root })))(versionDir);
          step(`current host is now ${versionDir}`);
        } finally {
          resolveStop("handover");
        }
      },
    });

    await host.hydrateAll();
    await host.startRemote();
    host.startRemoteInstances();
    host.captureShellKeys().catch((error: unknown) => log(`login-shell key capture failed: ${String(error)}`));
    host.refreshProviderOAuth().catch((error: unknown) => log(`provider OAuth refresh failed: ${String(error)}`));
    step("host ready");
    host.checkUpdatesOnLaunch();

    const onSigint = (): void => resolveStop("SIGINT");
    const onSigterm = (): void => resolveStop("SIGTERM");
    signals.on("SIGINT", onSigint);
    signals.on("SIGTERM", onSigterm);
    const reason = await stopping;
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", onSigterm);
    step(`${reason}; shutting down`);
    if (reason !== "handover") {
      // Graceful: every live session records a clean stop before whatever remains is killed.
      const dormant = await host.hibernateAll();
      if (dormant.length > 0) step(`hibernated ${dormant.length} live session(s)`);
    }
    await host.shutdown();
    host = null;
    await control?.close();
    control = null;
    token.release();
    step("shutdown complete");
    return EXIT.OK;
  } catch (error) {
    if (error instanceof LedgerUnresolved) step(`stopped: ${error.message}`);
    else if (error instanceof RegistryCorrupt) step(`stopped: ${error.message}; nothing was moved`);
    else step(`boot failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (host !== null) {
      try {
        await host.shutdown();
      } catch (shutdownError) {
        log(`shutdown after failure: ${String(shutdownError)}`);
      }
    }
    if (control !== null) await control.close();
    token.release();
    return EXIT.OPERATIONAL;
  }
}
