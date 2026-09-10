import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ipcMain } from "electron";
import { CH } from "@omp-ui/core/backend-channels";
import { writeCutoverHandoff } from "@omp-ui/core/cutover-handoff";
import type { BuildFlavor } from "@omp-ui/core/data-root";
import {
  BCH,
  type HostBootstrapConnection,
  type HostBootstrapStatus,
  type HostSupervisorKind,
} from "@omp-ui/core/host-bootstrap-channels";
import { hostLaunchCommands, type HostLaunchCommand } from "@omp-ui/core/host-launch";
import { hostRecordPath, readHostRecord, type HostConnectionRecordV1 } from "@omp-ui/core/host-record";
import { InstanceConnectError, type InstanceClient } from "@omp-ui/server/client";

/**
 * How the desktop client finds — or brings up — the persistent host it is a
 * client of (issue #442 §9, §10.1, §11). Launch priority: a compatible live
 * host named by `host.json`, then the installed `current` host, then the
 * embedded seed relocated into `versions/<version>`. The host is never
 * `spawn()`ed: the platform supervisor's reserved on-demand identity is
 * submitted and the connection record polled. Nothing here opens an
 * authoritative store; the only file this writes into the data root is the
 * one-use cutover note (§5.5).
 */

export const HOST_START_TIMEOUT_MS = 30_000;
export const HOST_POLL_INTERVAL_MS = 250;
/** A connection that held this long resets the reconnect backoff. */
const STABLE_CONNECTION_MS = 60_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

const SUPERVISOR_BY_PLATFORM: Partial<Record<NodeJS.Platform, HostSupervisorKind>> = {
  linux: "systemd-user",
  darwin: "launchd-agent",
  win32: "windows-task",
};

/** Where installed hosts live (spec §10.1); every path is owned by the installer, never a user's. */
export interface HostInstallLayout {
  /** `<dataHome>/omp-ui-host` */
  root: string;
  /** `process.resourcesPath/host` — the embedded seed's parent; null in an unpackaged run. */
  seedDir: string | null;
  /** `~/.local/bin/omp-ui`; null on win32, where the junctioned `bin` is the stable command. */
  stableCommand: string | null;
}

export interface HostBootstrapDeps {
  flavor: BuildFlavor;
  dataRoot: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  clientVersion: string;
  clientLogDir: string;
  /** Legacy Electron userData: Chromium's SingletonLock and, before migration, registry.json. */
  legacyUserData: string;
  install: HostInstallLayout;
  pid: number;
  /** This process's start time as the host's liveness check will read it back. */
  processStartMs: number;
  /** Connects with the desktop credential and the desktop hello; rejects with InstanceConnectError. */
  probe: (record: HostConnectionRecordV1) => Promise<InstanceClient>;
  /** Connects with the control credential, for stop and rollback. */
  control: (record: HostConnectionRecordV1) => Promise<InstanceClient>;
  /** Runs one supervisor command; resolves with its exit, rejects only when it cannot be spawned. */
  run: (command: HostLaunchCommand) => Promise<{ code: number; stderr: string }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 256-bit base64url for the cutover note. */
  nonce: () => string;
  /** The host's retained rollback target, from the mirrored state once connected. */
  rollbackVersion: () => string | null;
  log: (line: string) => void;
  onStatus: (status: HostBootstrapStatus) => void;
}

export type ConnectedListener = (client: InstanceClient, record: HostConnectionRecordV1) => void;

export class HostBootstrap {
  private current: HostBootstrapStatus;
  private client: InstanceClient | null = null;
  private record: HostConnectionRecordV1 | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly waiters: Array<{
    resolve: (c: HostBootstrapConnection) => void;
    reject: (e: Error) => void;
  }> = [];
  private readonly connected: ConnectedListener[] = [];
  private readyAtMs = 0;
  private losses = 0;
  /** Set by stop(): a connection lost afterwards is the stop taking effect, not a crash. */
  private stopped = false;
  private disposed = false;

  constructor(private readonly deps: HostBootstrapDeps) {
    this.current = {
      phase: "probing",
      message: null,
      dataRoot: deps.dataRoot,
      clientLogDir: deps.clientLogDir,
      hostLogDir: join(deps.dataRoot, "logs"),
      hostVersion: null,
      hostPid: null,
      supervisor: null,
      rollbackVersion: null,
    };
  }

  get status(): HostBootstrapStatus {
    return { ...this.current, rollbackVersion: this.deps.rollbackVersion() };
  }

  /** Main's hook: the probe client that proved the host live becomes main's own connection. */
  onConnected(cb: ConnectedListener): void {
    this.connected.push(cb);
  }

  /** The first resolve → install → start pass; later passes come from retry() and lost connections. */
  start(): void {
    void this.attempt();
  }

  /** The renderer's Retry: from the top, whatever the phase. */
  retry(): Promise<void> {
    this.stopped = false;
    this.losses = 0;
    return this.attempt();
  }

  /** Resolves once the host is reachable; rejects with the failure while the phase is `failed`. */
  connection(): Promise<HostBootstrapConnection> {
    if (this.record !== null && this.current.phase === "ready") {
      return Promise.resolve(this.connectionOf(this.record));
    }
    if (this.current.phase === "failed") {
      return Promise.reject(new Error(this.current.message ?? "the host is unavailable"));
    }
    // Executor form (not Promise.withResolvers): the node tsconfig lib is ES2022.
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Asks the live host to stop; its socket closing is the success signal (like `omp-ui stop`). */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.controlRequest(CH.stopHost, "stop");
  }

  /** Asks the live host to hand over to its retained previous version. */
  async rollback(): Promise<void> {
    await this.controlRequest(CH.rollbackHostUpdate, "roll back");
  }

  /** App quit: drop main's connection without reconnecting; the host keeps running. */
  dispose(): void {
    this.disposed = true;
    this.detach();
  }

  // --- the pass ------------------------------------------------------------

  private attempt(): Promise<void> {
    if (this.inFlight === null) {
      this.inFlight = this.pass().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async pass(): Promise<void> {
    if (this.disposed) return;
    this.detach();
    this.publish({ phase: "probing", message: null, hostVersion: null, hostPid: null });
    try {
      const record = readHostRecord(this.deps.dataRoot);
      if (record !== null) {
        const live = await this.probe(record);
        if (live !== null) {
          this.ready(live, record);
          return;
        }
      }
      if (!this.deps.packaged) {
        throw new Error(
          `no host is serving ${this.deps.dataRoot}. Start one with ` +
            `\`npm run dev:serve -w @omp-ui/host -- --flavor ${this.deps.flavor}\`, then retry.`,
        );
      }
      const execPath = this.locateOrInstallHost();
      this.leaveCutoverHandoff();
      const launchFailure = await this.submitStart(execPath);
      await this.awaitHost(launchFailure);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** A stale record — host gone, or restarted with rotated credentials — is null; incompatible throws. */
  private async probe(record: HostConnectionRecordV1): Promise<InstanceClient | null> {
    try {
      return await this.deps.probe(record);
    } catch (error) {
      if (error instanceof InstanceConnectError && error.failure.kind === "incompatible") {
        throw new Error(
          `host ${error.failure.hostVersion || record.hostVersion} at ${record.endpoint} ` +
            `refused this client (v${this.deps.clientVersion}): ${error.failure.reason}`,
          { cause: error },
        );
      }
      this.deps.log(
        `[bootstrap] host.json names ${record.endpoint} (pid ${record.pid}) but it did not answer: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private locateOrInstallHost(): string {
    const execPath = installedHostPath(this.deps.install, this.deps.platform);
    if (fs.existsSync(execPath)) return execPath;
    this.publish({ phase: "installing", message: `installing the embedded host under ${this.deps.install.root}` });
    const installed = installEmbeddedHost(this.deps.install, this.deps.platform);
    this.deps.log(`[bootstrap] installed embedded host ${installed.version} at ${installed.execPath}`);
    return installed.execPath;
  }

  /**
   * Pre-migration only: the legacy userData still holds the registry and the
   * data root has neither adopted one nor journalled its relocation. Written
   * before the start is submitted, while this process provably holds
   * Chromium's SingletonLock — the host verifies exactly that (§5.5).
   */
  private leaveCutoverHandoff(): void {
    const { dataRoot, legacyUserData } = this.deps;
    if (!fs.existsSync(join(legacyUserData, "registry.json"))) return;
    if (fs.existsSync(join(dataRoot, "registry.json"))) return;
    if (relocationCommitted(dataRoot)) return;
    fs.mkdirSync(dataRoot, { recursive: true });
    writeCutoverHandoff({
      schemaVersion: 1,
      pid: this.deps.pid,
      processStartMs: this.deps.processStartMs,
      legacyUserData,
      targetDataRoot: dataRoot,
      nonce: this.deps.nonce(),
      createdAtMs: this.deps.now(),
    });
    this.deps.log(`[bootstrap] left cutover handoff for ${legacyUserData} in ${dataRoot}`);
  }

  /**
   * Submits the supervisor identity. A command that exits non-zero is not yet
   * fatal: the usual cause is a host already coming up under that identity
   * (an installed service at login), so the poll below gets its window and the
   * exit becomes the failure only when no host appears.
   */
  private async submitStart(execPath: string): Promise<string | null> {
    const { dataRoot, platform } = this.deps;
    const commands = hostLaunchCommands(platform, { execPath, dataRoot, logDir: join(dataRoot, "logs") });
    if (commands === null) throw new Error(`no host supervisor for platform ${platform}`);
    fs.mkdirSync(join(dataRoot, "logs"), { recursive: true });
    this.publish({
      phase: "starting",
      message: `starting the host through ${SUPERVISOR_BY_PLATFORM[platform]}`,
      supervisor: SUPERVISOR_BY_PLATFORM[platform] ?? null,
    });
    for (const command of commands) {
      const result = await this.deps.run(command);
      if (result.code !== 0) {
        const stderr = result.stderr.trim();
        const failure = `${command.cmd} ${command.args[0]} exited ${result.code}${stderr ? `: ${stderr}` : ""}`;
        this.deps.log(`[bootstrap] ${failure}`);
        this.publish({ message: `${failure}; waiting for a host that may already be starting` });
        return failure;
      }
    }
    return null;
  }

  private async awaitHost(launchFailure: string | null): Promise<void> {
    const deadline = this.deps.now() + HOST_START_TIMEOUT_MS;
    for (;;) {
      await this.deps.sleep(HOST_POLL_INTERVAL_MS);
      const record = readHostRecord(this.deps.dataRoot);
      if (record !== null) {
        const live = await this.probe(record);
        if (live !== null) {
          this.ready(live, record);
          return;
        }
      }
      if (this.deps.now() >= deadline) {
        const seconds = HOST_START_TIMEOUT_MS / 1000;
        throw new Error(
          launchFailure !== null
            ? `${launchFailure}; no host came up within ${seconds} s`
            : `the host did not come up within ${seconds} s; check ${this.current.hostLogDir} or run \`omp-ui status\``,
        );
      }
    }
  }

  // --- transitions -----------------------------------------------------------

  private ready(client: InstanceClient, record: HostConnectionRecordV1): void {
    this.client = client;
    this.record = record;
    this.readyAtMs = this.deps.now();
    client.onClose((code, reason) => this.lost(client, code, reason));
    this.publish({ phase: "ready", message: null, hostVersion: record.hostVersion, hostPid: record.pid });
    // Listeners first: main registers its event sinks before the client replays buffered frames.
    for (const cb of this.connected) cb(client, record);
    const connection = this.connectionOf(record);
    for (const waiter of this.waiters.splice(0)) waiter.resolve(connection);
  }

  private fail(message: string): void {
    this.deps.log(`[bootstrap] failed: ${message}`);
    this.publish({ phase: "failed", message, hostVersion: null, hostPid: null });
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(message));
  }

  /** Main's connection closed under us. Backoff doubles per quick loss; a stop is not a loss. */
  private lost(client: InstanceClient, code: number, reason: string): void {
    if (client !== this.client) return;
    this.client = null;
    this.record = null;
    if (this.disposed) return;
    if (this.stopped) {
      this.fail("the host was stopped from this client; Retry starts it again");
      return;
    }
    const held = this.deps.now() - this.readyAtMs;
    this.losses = held >= STABLE_CONNECTION_MS ? 1 : this.losses + 1;
    const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** (this.losses - 1));
    this.deps.log(`[bootstrap] host connection closed (${code} ${reason}); reconnecting in ${delay} ms`);
    this.publish({
      phase: "probing",
      message: `connection to the host closed; reconnecting in ${Math.round(delay / 1000)} s`,
      hostPid: null,
    });
    void this.deps.sleep(delay).then(() => {
      if (!this.disposed && !this.stopped) void this.attempt();
    });
  }

  private detach(): void {
    const client = this.client;
    this.client = null;
    this.record = null;
    client?.close();
  }

  private publish(patch: Partial<HostBootstrapStatus>): void {
    this.current = { ...this.current, ...patch };
    this.deps.onStatus(this.status);
  }

  private connectionOf(record: HostConnectionRecordV1): HostBootstrapConnection {
    return {
      endpoint: record.endpoint,
      desktopCredential: record.desktopCredential,
      clientVersion: this.deps.clientVersion,
      hostVersion: record.hostVersion,
    };
  }

  private async controlRequest(channel: string, verb: string): Promise<void> {
    const record = readHostRecord(this.deps.dataRoot);
    if (record === null) {
      throw new Error(`no host record at ${hostRecordPath(this.deps.dataRoot)}: there is no running host to ${verb}`);
    }
    const client = await this.deps.control(record);
    // Executor form (not Promise.withResolvers): the node tsconfig lib is ES2022.
    await new Promise<void>((resolve, reject) => {
      // A socket the host closes mid-request rejects every pending call; that close is the
      // request taking effect. Anything else is the host refusing.
      client.onClose(() => resolve());
      client.request(channel, []).then(
        () => resolve(),
        (error: unknown) => {
          queueMicrotask(() => reject(error instanceof Error ? error : new Error(String(error))));
        },
      );
    });
    client.close();
  }
}

// --- IPC --------------------------------------------------------------------------

/**
 * Binds the five `bootstrap:*` requests (issue #442 §11) over Electron IPC for the
 * window's preload; every one is argless, so an argument is a malformed call.
 * Status pushes travel the other way through `HostBootstrapDeps.onStatus`.
 * Returns the unbind.
 */
export function bindHostBootstrapIpc(bootstrap: HostBootstrap): () => void {
  const requests: Record<string, () => unknown> = {
    [BCH.connection]: () => bootstrap.connection(),
    [BCH.retry]: () => bootstrap.retry(),
    [BCH.status]: () => bootstrap.status,
    [BCH.stop]: () => bootstrap.stop(),
    [BCH.rollback]: () => bootstrap.rollback(),
  };
  for (const [channel, handler] of Object.entries(requests)) {
    // async: a malformed call becomes the same rejected invoke a failing handler does.
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      if (args.length > 0) throw new Error(`invalid arguments for ${channel}: expected none`);
      return handler();
    });
  }
  return () => {
    for (const channel of Object.keys(requests)) ipcMain.removeHandler(channel);
  };
}

// --- installed layout ---------------------------------------------------------

/** The stable executable of the installed host: `current/bin/omp-ui`, or the junctioned `bin` on Windows. */
export function installedHostPath(layout: HostInstallLayout, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? join(layout.root, "bin", "omp-ui.exe")
    : join(layout.root, "current", "bin", "omp-ui");
}

/**
 * The first-line marker of the AppImage wrapper `packaging/install.sh` used to
 * leave at `~/.local/bin/omp-ui` before that path became the host command
 * (the wrapper now lives at `omp-ui-desktop`). A file carrying it is ours to
 * replace; install.sh removes it too, whichever runs first.
 */
export const LEGACY_LAUNCHER_MARKER = "# omp-ui launcher, installed by packaging/install.sh.";

/**
 * Relocates the one embedded host directory into `versions/<version>`, then
 * points `current` (Linux/macOS: symlink, plus `~/.local/bin/omp-ui`; Windows:
 * the `bin` junction) at it. The copy lands under a partial name and is
 * renamed into place, so an interrupted install never leaves a half-copied
 * version behind a valid pointer. A pointer path that is neither a link into
 * the install root nor the legacy install.sh wrapper is someone else's and is
 * refused, never replaced.
 */
export function installEmbeddedHost(
  layout: HostInstallLayout,
  platform: NodeJS.Platform,
): { version: string; execPath: string } {
  if (layout.seedDir === null) throw new Error("this build embeds no host");
  const versions = fs
    .readdirSync(layout.seedDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (versions.length !== 1) {
    throw new Error(`expected exactly one embedded host under ${layout.seedDir}, found ${versions.length}`);
  }
  const version = versions[0]!;
  const versionsDir = join(layout.root, "versions");
  const versionDir = join(versionsDir, version);
  const partial = join(versionsDir, `.${version}.partial`);
  const binary = platform === "win32" ? "omp-ui.exe" : "omp-ui";

  fs.mkdirSync(versionsDir, { recursive: true });
  fs.rmSync(partial, { recursive: true, force: true });
  fs.cpSync(join(layout.seedDir, version), partial, { recursive: true });
  fs.chmodSync(join(partial, "bin", binary), 0o755);
  fs.rmSync(versionDir, { recursive: true, force: true });
  fs.renameSync(partial, versionDir);

  if (platform === "win32") {
    replaceOwnedLink(join(layout.root, "bin"), join(versionDir, "bin"), "junction", layout.root);
  } else {
    replaceOwnedLink(join(layout.root, "current"), join("versions", version), "dir", layout.root);
    if (layout.stableCommand !== null) {
      fs.mkdirSync(dirname(layout.stableCommand), { recursive: true });
      placeStableCommand(layout.stableCommand, installedHostPath(layout, platform), layout.root);
    }
  }
  return { version, execPath: installedHostPath(layout, platform) };
}

/**
 * `~/.local/bin/omp-ui`: replaced when absent, a link into the install root,
 * or the legacy install.sh wrapper (its marker within the first three lines);
 * anything else is refused by name.
 */
export function placeStableCommand(commandPath: string, target: string, ownedRoot: string): void {
  const existing = lstatOrNull(commandPath);
  if (existing !== null && existing.isFile()) {
    let head: string;
    try {
      head = fs.readFileSync(commandPath, "utf8").split("\n", 3).join("\n");
    } catch (error) {
      throw new Error(`refusing to replace ${commandPath}: unreadable (${(error as Error).message})`, { cause: error });
    }
    if (!head.includes(LEGACY_LAUNCHER_MARKER)) {
      throw new Error(`refusing to replace ${commandPath}: not a link omp-ui installed and not its legacy launcher`);
    }
    fs.rmSync(commandPath, { force: true });
    replaceOwnedLink(commandPath, target, "file", ownedRoot);
    return;
  }
  replaceOwnedLink(commandPath, target, "file", ownedRoot);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

/**
 * Points `linkPath` at `target`. An existing entry must be a link whose target
 * resolves inside `ownedRoot` — otherwise it is not ours and the install
 * refuses. Symlinks swap atomically through a rename; a junction is a directory
 * entry that rename cannot overwrite, so it is removed and relinked.
 */
function replaceOwnedLink(
  linkPath: string,
  target: string,
  type: "dir" | "file" | "junction",
  ownedRoot: string,
): void {
  const existing = lstatOrNull(linkPath);
  if (existing !== null) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`refusing to replace ${linkPath}: not a link omp-ui installed`);
    }
    const points = fs.readlinkSync(linkPath);
    const rel = relative(ownedRoot, resolve(dirname(linkPath), points));
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`refusing to replace ${linkPath}: it points outside ${ownedRoot} (${points})`);
    }
  }
  if (type === "junction") {
    if (existing !== null) fs.rmdirSync(linkPath);
    fs.symlinkSync(target, linkPath, "junction");
    return;
  }
  const staged = `${linkPath}.${process.pid}.tmp`;
  fs.rmSync(staged, { force: true });
  fs.symlinkSync(target, staged, type);
  fs.renameSync(staged, linkPath);
}

/**
 * Whether `<dataRoot>/migration.json` records the store relocation as
 * committed. Read leniently — the journal is the host's; anything unreadable
 * means "not committed" and the host decides what the note is worth.
 */
function relocationCommitted(dataRoot: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(join(dataRoot, "migration.json"), "utf8"));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || !("steps" in parsed) || !Array.isArray(parsed.steps)) {
    return false;
  }
  return parsed.steps.some(
    (step: unknown) =>
      step !== null &&
      typeof step === "object" &&
      "id" in step &&
      step.id === "relocate-authority-stores-v1" &&
      "status" in step &&
      step.status === "committed",
  );
}
