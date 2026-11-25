import * as fs from "node:fs";
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
  startedAt: string;
}

const LOCK_FILENAME = "lite.lock";

export function dataDirLockPath(dataDir: string): string {
  return path.join(dataDir, LOCK_FILENAME);
}

function parseLockPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    if (raw === "") return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "pid" in parsed) {
      const { pid } = parsed;
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
    return null;
  } catch {
    return null;
  }
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
