import * as fs from "node:fs";
import * as path from "node:path";
import {
  compareVersions,
  idleHostUpdateState,
  writeTextDurably,
  type BreadcrumbSink,
  type HostUpdateState,
} from "@omp-ui/core";

/**
 * The host's own update lifecycle (issue #442 §10.2). A release is fetched,
 * hash-verified, and unpacked under `<dataRoot>/updates/host-<version>/`;
 * with no client and no live session it is applied at once, otherwise one
 * bounded global countdown runs that any client may apply now or defer.
 * Apply hibernates every live session, drains the listeners, releases
 * authority, and launches the staged binary directly; the old process stays
 * a non-authoritative arbiter until the replacement acknowledges (claim,
 * registry, hydration, authenticated local endpoint) or the ack deadline
 * passes — then it either commits the `current` pointer and retains exactly
 * one `host-previous`, or kills the replacement and reclaims through the
 * ordinary claim path. Rollback is the identical path with `host-previous`
 * as the target; data migrations are never reversed.
 */

export const HOST_UPDATE_GRACE_MS = 120_000;
export const HOST_UPDATE_DEFERRAL_LIMIT = 3;
export const HOST_UPDATE_DEFERRAL_CEILING_MS = 30 * 60_000;
export const HOST_UPDATE_ACK_TIMEOUT_MS = 60_000;

/** One entry of a `latest-host-<platform>.yml` feed, already selected for this platform/arch. */
export interface HostRelease {
  version: string;
  url: string;
  /** Hex or base64 as the feed publishes it; compared case-insensitively against `sha512File`. */
  sha512: string;
  size: number;
}

/** The replacement process the old binary arbitrates. */
export interface StagedHostChild {
  pid: number;
  /** True once the replacement reports claim + registry + hydration + accepting probes. */
  waitForAck(timeoutMs: number): Promise<boolean>;
  kill(): void;
}

export interface HostUpdateLimits {
  graceMs: number;
  deferralLimit: number;
  /** No deferral moves the deadline past `firstCountdownAt + ceilingMs`. */
  ceilingMs: number;
  ackTimeoutMs: number;
}

export interface HostUpdaterDeps {
  dataRoot: string;
  currentVersion: string;
  fetchFeed: () => Promise<HostRelease | null>;
  download: (url: string, dest: string, onProgress: (pct: number) => void) => Promise<void>;
  sha512File: (file: string) => Promise<string>;
  unpack: (archive: string, dir: string) => Promise<void>;
  /** Launches `<versionDir>/bin/omp-ui serve` (or the platform equivalent) against `dataRoot`. */
  spawnStaged: (versionDir: string, opts: { dataRoot: string }) => StagedHostChild;
  releaseAuthority: () => void;
  reclaimAuthority: () => Promise<void>;
  /** Hibernates every live session; returns the affected tab ids. */
  hibernateAll: () => Promise<string[]>;
  drainListeners: () => Promise<void>;
  clientCount: () => number;
  liveSessionCount: () => number;
  /**
   * Runs once the replacement acknowledged and `current`/`staged`/`host-previous`
   * name the new version: the installed layout's `current` pointer and the stable
   * command switch here (issue #442 §10.1), and the arbiter process may exit.
   */
  afterCommit?: (versionDir: string) => void;
  send: (state: HostUpdateState) => void;
  breadcrumbs: BreadcrumbSink;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Test seam; production uses the exported constants. */
  limits?: Partial<HostUpdateLimits>;
}

/** Where the updater keeps its durable state beneath `<dataRoot>/updates`. */
export interface HostUpdatePaths {
  dir: string;
  /** Names the version the launcher should run. */
  current: string;
  /** Names the most recently staged version; equals `current` once applied. */
  staged: string;
  /** Symlink (junction on Windows) to the one retained previous version dir. */
  previous: string;
  lastAttempt: string;
  versionDir(version: string): string;
  archive(version: string): string;
}

export function hostUpdatePaths(dataRoot: string): HostUpdatePaths {
  const dir = path.join(dataRoot, "updates");
  return {
    dir,
    current: path.join(dir, "current"),
    staged: path.join(dir, "staged"),
    previous: path.join(dir, "host-previous"),
    lastAttempt: path.join(dir, "last-attempt.json"),
    versionDir: (version) => path.join(dir, `host-${version}`),
    archive: (version) => path.join(dir, `host-${version}.download`),
  };
}

export interface HostUpdateDisk {
  current: string | null;
  /** Only when its version dir exists. */
  staged: string | null;
  /** Only when `host-previous` resolves to an existing version dir. */
  previous: string | null;
  lastAttempt: HostUpdateState["lastAttempt"];
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** What a fresh process (or `omp-ui status`, which never loads the Registry) learns from disk. */
export function readHostUpdateDisk(dataRoot: string): HostUpdateDisk {
  const paths = hostUpdatePaths(dataRoot);
  const pointer = (file: string): string | null => {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8").trim();
    } catch {
      return null;
    }
    return VERSION_RE.test(text) ? text : null;
  };
  const staged = pointer(paths.staged);
  let previous: string | null = null;
  try {
    const target = path.basename(fs.readlinkSync(paths.previous));
    const version = target.startsWith("host-") ? target.slice("host-".length) : "";
    if (VERSION_RE.test(version) && fs.existsSync(paths.versionDir(version))) previous = version;
  } catch {
    // No previous retained.
  }
  let lastAttempt: HostUpdateState["lastAttempt"] = null;
  try {
    lastAttempt = parseLastAttempt(JSON.parse(fs.readFileSync(paths.lastAttempt, "utf8")));
  } catch {
    // Never attempted, or unreadable: reported as none.
  }
  return {
    current: pointer(paths.current),
    staged: staged !== null && fs.existsSync(paths.versionDir(staged)) ? staged : null,
    previous,
    lastAttempt,
  };
}

function parseLastAttempt(raw: unknown): HostUpdateState["lastAttempt"] {
  if (typeof raw !== "object" || raw === null) return null;
  if (!("fromVersion" in raw && "toVersion" in raw && "outcome" in raw && "atMs" in raw)) return null;
  const { fromVersion, toVersion, outcome, atMs } = raw;
  if (typeof fromVersion !== "string" || typeof toVersion !== "string" || typeof atMs !== "number") return null;
  if (outcome !== "applied" && outcome !== "rolled-back" && outcome !== "failed") return null;
  return { fromVersion, toVersion, outcome, atMs };
}

export class HostUpdater {
  state: HostUpdateState;

  private readonly paths: HostUpdatePaths;
  private readonly limits: HostUpdateLimits;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** The release `check()` last offered; what `download()` fetches. */
  private release: HostRelease | null = null;
  private firstCountdownAt: number | null = null;
  private timer: unknown = null;
  private disposed = false;

  constructor(private readonly deps: HostUpdaterDeps) {
    this.paths = hostUpdatePaths(deps.dataRoot);
    this.limits = {
      graceMs: HOST_UPDATE_GRACE_MS,
      deferralLimit: HOST_UPDATE_DEFERRAL_LIMIT,
      ceilingMs: HOST_UPDATE_DEFERRAL_CEILING_MS,
      ackTimeoutMs: HOST_UPDATE_ACK_TIMEOUT_MS,
      ...deps.limits,
    };
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    const disk = readHostUpdateDisk(deps.dataRoot);
    const currentIsStaged = disk.staged !== null && disk.current === disk.staged;
    this.state = {
      ...idleHostUpdateState(deps.currentVersion),
      stagedVersion: disk.staged,
      // A version staged by an earlier process life waits for a client or the next check.
      status: disk.staged !== null && !currentIsStaged ? "staged" : "idle",
      deferralLimit: this.limits.deferralLimit,
      lastAttempt: disk.lastAttempt,
      rollbackVersion: disk.previous,
      currentIsStaged,
    };
  }

  async check(): Promise<HostUpdateState> {
    if (this.busy() || this.state.status === "countdown") return this.state;
    this.set({ status: "checking", error: null });
    let release: HostRelease | null;
    try {
      release = await this.deps.fetchFeed();
    } catch (error) {
      this.set({ status: "error", error: errorMessage(error) });
      return this.state;
    }
    const stagedPending = this.state.stagedVersion !== null && !this.state.currentIsStaged;
    if (release === null || compareVersions(release.version, this.deps.currentVersion) <= 0) {
      this.release = null;
      this.set({ status: stagedPending ? "staged" : "idle", latestVersion: release?.version ?? null });
      return this.state;
    }
    if (!VERSION_RE.test(release.version)) {
      this.release = null;
      this.set({ status: "error", error: `malformed feed version ${JSON.stringify(release.version)}` });
      return this.state;
    }
    this.release = release;
    if (stagedPending && this.state.stagedVersion === release.version) {
      this.set({ status: "staged", latestVersion: release.version }, release.version);
      await this.afterStaged(release.version);
    } else {
      this.set({ status: "available", latestVersion: release.version }, release.version);
    }
    return this.state;
  }

  async download(): Promise<void> {
    if (this.release === null || this.state.status !== "available") {
      throw new Error("no host update available to download");
    }
    const release = this.release;
    const version = release.version;
    const archive = this.paths.archive(version);
    const dir = this.paths.versionDir(version);
    this.set({ status: "downloading", progress: 0, error: null }, version);
    try {
      fs.mkdirSync(this.paths.dir, { recursive: true });
      await this.deps.download(release.url, archive, (pct) => {
        const progress = Math.max(0, Math.min(100, Math.round(pct)));
        if (progress !== this.state.progress) this.set({ progress });
      });
      const digest = await this.deps.sha512File(archive);
      if (digest.toLowerCase() !== release.sha512.toLowerCase()) {
        fs.rmSync(archive, { force: true });
        this.set({ status: "error", progress: null, error: `checksum mismatch for host ${version}` });
        return;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      await this.deps.unpack(archive, dir);
      fs.rmSync(archive, { force: true });
      writeTextDurably(this.paths.staged, `${version}\n`);
    } catch (error) {
      fs.rmSync(archive, { force: true });
      this.set({ status: "error", progress: null, error: errorMessage(error) });
      return;
    }
    this.set({ status: "staged", stagedVersion: version, progress: null, currentIsStaged: false }, version);
    await this.afterStaged(version);
  }

  /** Pushes the grace deadline by one grace period, within the count and total ceilings. */
  defer(): HostUpdateState {
    const { status, graceDeadlineMs, deferrals, deferralLimit } = this.state;
    if (status !== "countdown" || graceDeadlineMs === null || this.firstCountdownAt === null) return this.state;
    if (deferrals >= deferralLimit) return this.state;
    const deadline = Math.min(graceDeadlineMs + this.limits.graceMs, this.firstCountdownAt + this.limits.ceilingMs);
    if (deadline <= graceDeadlineMs) return this.state;
    this.armCountdown(deadline);
    this.set({ graceDeadlineMs: deadline, deferrals: deferrals + 1 }, `deferred ${deferrals + 1}`);
    return this.state;
  }

  async apply(): Promise<void> {
    const target = this.state.stagedVersion;
    if (target === null || this.state.currentIsStaged) throw new Error("no staged host version to apply");
    if (this.busy()) throw new Error(`cannot apply while ${this.state.status}`);
    await this.handover(target, "applied");
  }

  async rollback(): Promise<void> {
    const target = this.state.rollbackVersion;
    if (target === null) throw new Error("no previous host version to roll back to");
    if (this.busy()) throw new Error(`cannot roll back while ${this.state.status}`);
    await this.handover(target, "rolled-back");
  }

  dispose(): void {
    this.clearCountdown();
    this.disposed = true;
  }

  private busy(): boolean {
    return this.state.status === "checking" || this.state.status === "downloading" || this.state.status === "applying";
  }

  private async afterStaged(version: string): Promise<void> {
    if (this.deps.clientCount() === 0 && this.deps.liveSessionCount() === 0) {
      await this.handover(version, "applied");
      return;
    }
    const now = this.now();
    this.firstCountdownAt = now;
    this.armCountdown(now + this.limits.graceMs);
    this.set({ status: "countdown", graceDeadlineMs: now + this.limits.graceMs, deferrals: 0 }, version);
  }

  private armCountdown(deadline: number): void {
    this.clearCountdown();
    this.timer = this.setTimer(() => {
      this.timer = null;
      const target = this.state.stagedVersion;
      if (this.state.status === "countdown" && target !== null) void this.handover(target, "applied");
    }, Math.max(0, deadline - this.now()));
  }

  private clearCountdown(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Never rejects: every outcome lands in `state` (and `lastAttempt`) for clients to read. */
  private async handover(target: string, outcome: "applied" | "rolled-back"): Promise<void> {
    this.clearCountdown();
    this.firstCountdownAt = null;
    const dir = this.paths.versionDir(target);
    if (!fs.existsSync(dir)) {
      this.set({ status: "error", graceDeadlineMs: null, error: `host ${target} is not staged` });
      return;
    }
    this.set({ status: "applying", graceDeadlineMs: null, error: null }, target);
    let released = false;
    try {
      const affectedTabIds = await this.deps.hibernateAll();
      this.set({ affectedTabIds });
      await this.deps.drainListeners();
      this.deps.releaseAuthority();
      released = true;
      const child = this.deps.spawnStaged(dir, { dataRoot: this.deps.dataRoot });
      if (await child.waitForAck(this.limits.ackTimeoutMs)) {
        const replaced = readHostUpdateDisk(this.deps.dataRoot).current ?? this.deps.currentVersion;
        const previous = this.commit(target, replaced);
        this.set(
          {
            status: "idle",
            stagedVersion: target,
            currentIsStaged: true,
            rollbackVersion: previous,
            deferrals: 0,
            lastAttempt: this.recordAttempt(target, outcome),
          },
          `${outcome} ${target}`,
        );
        return;
      }
      child.kill();
      await this.deps.reclaimAuthority();
      released = false;
      this.set({
        status: "error",
        lastAttempt: this.recordAttempt(target, "failed"),
        error: `host ${target} did not acknowledge within ${Math.round(this.limits.ackTimeoutMs / 1000)} s`,
      });
    } catch (error) {
      if (released) await this.deps.reclaimAuthority();
      this.set({ status: "error", lastAttempt: this.recordAttempt(target, "failed"), error: errorMessage(error) });
    }
  }

  /**
   * Switches `current` (and `staged`) to `target`, points `host-previous` at
   * the replaced version's dir when it exists, removes every other version
   * dir, then runs `afterCommit`. Returns the retained previous version, or
   * null. An `afterCommit` failure is recorded, never propagated: the
   * replacement already owns the root, so nothing here may trigger a reclaim.
   */
  private commit(target: string, replaced: string): string | null {
    const { paths } = this;
    writeTextDurably(paths.current, `${target}\n`);
    writeTextDurably(paths.staged, `${target}\n`);
    fs.rmSync(paths.previous, { force: true });
    const keepPrevious = replaced !== target && fs.existsSync(paths.versionDir(replaced));
    if (keepPrevious) {
      // Junctions need an absolute target; POSIX links stay relocatable.
      const linkTarget = process.platform === "win32" ? paths.versionDir(replaced) : `host-${replaced}`;
      fs.symlinkSync(linkTarget, paths.previous, "junction");
    }
    for (const entry of fs.readdirSync(paths.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("host-")) continue;
      const version = entry.name.slice("host-".length);
      if (version === target || (keepPrevious && version === replaced)) continue;
      fs.rmSync(path.join(paths.dir, entry.name), { recursive: true, force: true });
    }
    try {
      this.deps.afterCommit?.(paths.versionDir(target));
    } catch (error) {
      this.deps.breadcrumbs.record("update-stage", { detail: `host:after-commit failed ${errorMessage(error)}` });
    }
    return keepPrevious ? replaced : null;
  }

  private recordAttempt(
    toVersion: string,
    outcome: "applied" | "rolled-back" | "failed",
  ): NonNullable<HostUpdateState["lastAttempt"]> {
    const attempt = { fromVersion: this.deps.currentVersion, toVersion, outcome, atMs: this.now() };
    writeTextDurably(this.paths.lastAttempt, `${JSON.stringify(attempt)}\n`);
    return attempt;
  }

  /** Publishes the new state; a status change or an explicit `detail` also leaves a breadcrumb. */
  private set(patch: Partial<HostUpdateState>, detail?: string): void {
    const before = this.state.status;
    this.state = { ...this.state, ...patch };
    if (this.disposed) return;
    this.deps.send(this.state);
    if (this.state.status !== before || detail !== undefined) {
      const suffix = detail ?? (this.state.status === "error" ? this.state.error : null);
      this.deps.breadcrumbs.record("update-stage", {
        detail: `host:${this.state.status}${suffix ? ` ${suffix}` : ""}`,
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
