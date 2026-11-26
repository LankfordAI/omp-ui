import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLiteHome } from "./config";

/**
 * Exclusive data-dir ownership lock (`<dataDir>/lite.lock`, issue #1368).
 *
 * A live `omp-ui-lite serve` holds an authoritative in-memory `Registry` and
 * `RoutineRunHistory` snapshot. Neither a second `serve` nor an offline CLI
 * write may touch files in the data dir while a live process owns it.
 */
export interface DataDirLock {
  readonly lockPath: string;
  readonly pid: number;
  release(): void;
  /** Resolves once any kernel lock holder has finished exiting (no-op for file-only locks). */
  releaseAsync?(): Promise<void>;
}

export class DataDirLockedError extends Error {
  readonly pid: number | null;
  readonly lockPath: string;

  constructor(lockPath: string, pid: number | null) {
    super(
      pid === null
        ? `omp-ui-lite data dir is locked (${lockPath})`
        : `omp-ui-lite daemon (pid ${pid}) is running and owns ${path.dirname(lockPath)}`,
    );
    this.name = "DataDirLockedError";
    this.pid = pid;
    this.lockPath = lockPath;
  }
}

interface LockPayload {
  pid: number;
  hostname?: string;
  startedAt: string;
  kernelLock?: boolean;
}

const LOCK_FILENAME = "lite.lock";
const FLOCK_FILENAME = "lite.flock";

export function dataDirLockPath(dataDir: string): string {
  return path.join(dataDir, LOCK_FILENAME);
}

export function dataDirFlockPath(dataDir: string): string {
  return path.join(dataDir, FLOCK_FILENAME);
}

function parseLockPayload(lockPath: string): LockPayload | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    if (raw === "") return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "pid" in parsed) {
      const { pid } = parsed;
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
        const hostname = "hostname" in parsed && typeof parsed.hostname === "string" ? parsed.hostname : undefined;
        const startedAt = "startedAt" in parsed && typeof parsed.startedAt === "string" ? parsed.startedAt : "";
        const kernelLock = "kernelLock" in parsed && parsed.kernelLock === true ? true : undefined;
        return {
          pid,
          ...(hostname === undefined ? {} : { hostname }),
          startedAt,
          ...(kernelLock === undefined ? {} : { kernelLock }),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function parseLockPid(lockPath: string): number | null {
  return parseLockPayload(lockPath)?.pid ?? null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists under another user/security boundary.
    if (code === "EPERM") return true;
    // ESRCH means no such process.
    return false;
  }
}

function writeExclusiveLock(lockPath: string, payload: LockPayload): void {
  // Write payload to a private temp file first and hard-link atomically onto
  // `lockPath` (`fs.linkSync` fails with EEXIST if `lockPath` already exists).
  // That guarantees any observer seeing `lockPath` reads a complete PID payload,
  // eliminating the empty-file race between `open(wx)` and `write()`.
  const tmpPath = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmpPath, lockPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup of temp path.
    }
  }
}

/**
 * Acquires an exclusive lock in `dataDir` (ensuring the 0700 dir exists first).
 * Recovers once from a stale lock whose PID is dead (`ESRCH`) or whose payload
 * is corrupt/empty; throws `DataDirLockedError` if a live process holds it.
 */
export function acquireDataDirLock(dataDir: string): DataDirLock {
  ensureLiteHome(dataDir);
  const lockPath = dataDirLockPath(dataDir);
  const pid = process.pid;
  const payload: LockPayload = { pid, startedAt: new Date().toISOString() };

  try {
    writeExclusiveLock(lockPath, payload);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;

    const existingPid = parseLockPid(lockPath);
    if (existingPid !== null && isPidAlive(existingPid)) {
      throw new DataDirLockedError(lockPath, existingPid);
    }

    // Stale (dead PID) or corrupt/empty lock file: unlink once and retry once.
    try {
      fs.unlinkSync(lockPath);
    } catch (unlinkErr) {
      const uCode = (unlinkErr as NodeJS.ErrnoException).code;
      if (uCode !== "ENOENT") throw unlinkErr;
    }

    try {
      writeExclusiveLock(lockPath, payload);
    } catch (retryErr) {
      const rCode = (retryErr as NodeJS.ErrnoException).code;
      if (rCode === "EEXIST") {
        throw new DataDirLockedError(lockPath, parseLockPid(lockPath));
      }
      throw retryErr;
    }
  }

  let released = false;
  return {
    lockPath,
    pid,
    release(): void {
      if (released) return;
      released = true;
      // Only remove the lock if it still belongs to this process.
      if (parseLockPid(lockPath) !== pid) return;
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[host-lite] failed to unlink lock ${lockPath}:`, err);
        }
      }
    },
  };
}

function writeMetadataFile(lockPath: string, payload: LockPayload): void {
  const tmpPath = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, lockPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup.
    }
    throw err;
  }
}

type KernelFlockResult =
  | { status: "acquired"; release(): void; releaseAsync(): Promise<void> }
  | { status: "locked" }
  | { status: "unavailable" };

function acquireKernelFlock(flockPath: string): Promise<KernelFlockResult> {
  if (process.platform !== "linux") {
    return Promise.resolve({ status: "unavailable" });
  }
  try {
    // Create the stable flock inode (0600) without unlinking it so concurrent
    // openers across PID namespaces lock the exact same VFS inode.
    const fd = fs.openSync(flockPath, "a", 0o600);
    fs.closeSync(fd);
  } catch {
    return Promise.resolve({ status: "unavailable" });
  }

  const { promise, resolve } = Promise.withResolvers<KernelFlockResult>();
  let settled = false;
  const finish = (res: KernelFlockResult): void => {
    if (settled) return;
    settled = true;
    resolve(res);
  };

  let child: ChildProcess;
  try {
    // `flock -n` opens and locks `flockPath`, then runs `sh -c "printf OK; exec cat"`.
    // Closing stdin ends `cat` cleanly so `flock` releases the fd and exits; killing
    // the parent with SIGKILL closes the pipe, ending `cat` and releasing the lock.
    child = spawn("flock", ["-n", flockPath, "sh", "-c", "printf OK; exec cat"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    finish({ status: "unavailable" });
    return promise;
  }

  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  let released = false;
  const triggerRelease = (): void => {
    if (released) return;
    released = true;
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      markExited();
    }
  };

  const releaseAsync = (): Promise<void> => {
    triggerRelease();
    return exited;
  };

  let out = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    out += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (out.includes("OK")) {
      child.unref();
      finish({ status: "acquired", release: triggerRelease, releaseAsync });
    }
  });

  child.once("error", () => {
    markExited();
    finish({ status: "unavailable" });
  });

  child.once("exit", (code) => {
    markExited();
    if (!settled) {
      // `flock -n` exits 1 when the lock is already held by another process/container.
      finish(code === 1 ? { status: "locked" } : { status: "unavailable" });
    }
  });
  return promise;
}

/**
 * Acquires an exclusive data-dir lock backed by a kernel `flock(2)` on Linux
 * (`<dataDir>/lite.flock`) so two containers in separate PID namespaces cannot
 * share a volume and a SIGKILLed container recovers cleanly on restart even
 * when assigned the same PID. Falls back to `acquireDataDirLock` when `flock`
 * is unavailable (macOS/Windows). Still honors pre-upgrade legacy `lite.lock`
 * files without `kernelLock: true` while their PID is alive.
 */
export async function acquireDataDirLockAsync(dataDir: string): Promise<DataDirLock> {
  ensureLiteHome(dataDir);
  const lockPath = dataDirLockPath(dataDir);
  const flockPath = dataDirFlockPath(dataDir);
  const pid = process.pid;

  const kernel = await acquireKernelFlock(flockPath);
  if (kernel.status === "unavailable") {
    return acquireDataDirLock(dataDir);
  }
  if (kernel.status === "locked") {
    throw new DataDirLockedError(lockPath, parseLockPid(lockPath));
  }

  // Backward compatibility: if an existing `lite.lock` was written by a legacy
  // daemon (no `kernelLock: true`) whose PID is still alive, respect it.
  const existing = parseLockPayload(lockPath);
  if (existing !== null && existing.kernelLock !== true && isPidAlive(existing.pid)) {
    await kernel.releaseAsync();
    throw new DataDirLockedError(lockPath, existing.pid);
  }

  const payload: LockPayload = {
    pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    kernelLock: true,
  };
  try {
    writeMetadataFile(lockPath, payload);
  } catch (err) {
    await kernel.releaseAsync();
    throw err;
  }

  let released = false;
  const unlinkMetadata = (): void => {
    try {
      const current = parseLockPayload(lockPath);
      if (current !== null && current.pid === pid && current.startedAt === payload.startedAt) {
        fs.unlinkSync(lockPath);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[host-lite] failed to unlink lock ${lockPath}:`, err);
      }
    }
  };
  return {
    lockPath,
    pid,
    release(): void {
      if (released) return;
      released = true;
      try {
        unlinkMetadata();
      } finally {
        kernel.release();
      }
    },
    async releaseAsync(): Promise<void> {
      if (!released) {
        released = true;
        unlinkMetadata();
      }
      await kernel.releaseAsync();
    },
  };
}
