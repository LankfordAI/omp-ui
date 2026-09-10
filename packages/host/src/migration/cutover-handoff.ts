import * as fs from "node:fs";
import * as path from "node:path";
import {
  CUTOVER_HANDOFF_MAX_AGE_MS,
  cutoverHandoffPath,
  isCutoverHandoff,
  type BreadcrumbSink,
  type CutoverHandoffV1,
} from "@omp-ui/core";

/**
 * The host's half of the cutover note (issue #442 §5.5; the record and its
 * writer live in core so the desktop client can leave one without linking
 * this package). The host consumes it only when the writer is provably the
 * live Electron instance that still holds Chromium's `SingletonLock` on the
 * legacy userData dir — a stale or forged note is ignored and left in place
 * for a human to look at.
 */

export interface ConsumeCutoverDeps {
  now: () => number;
  processAlive: (pid: number, startMs: number) => "alive" | "dead" | "unverifiable";
  /** Linux/macOS: the SingletonLock symlink target, `<host>-<pid>`. Throws when absent. */
  readlink?: (p: string) => string;
  /** Windows: false while another process holds the lock file open exclusively. */
  canOpenExclusive?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  breadcrumbs: BreadcrumbSink;
}

function defaultCanOpenExclusive(p: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(p, "r+");
  } catch (error) {
    // A missing lock is not held; a lock we cannot open is.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  fs.closeSync(fd);
  return true;
}

/** Whether `pid` holds Chromium's SingletonLock in `legacyUserData`; a reason when it does not. */
function singletonLockHeldBy(legacyUserData: string, pid: number, deps: ConsumeCutoverDeps): string | null {
  const lock = path.join(legacyUserData, "SingletonLock");
  if ((deps.platform ?? process.platform) === "win32") {
    const canOpen = deps.canOpenExclusive ?? defaultCanOpenExclusive;
    return canOpen(lock) ? "SingletonLock is not held" : null;
  }
  let target: string;
  try {
    target = (deps.readlink ?? fs.readlinkSync)(lock);
  } catch (error) {
    return `SingletonLock unreadable: ${(error as Error).message}`;
  }
  const dash = target.lastIndexOf("-");
  const lockPid = dash === -1 ? NaN : Number(target.slice(dash + 1));
  if (lockPid !== pid) return `SingletonLock is held by ${target}, not pid ${pid}`;
  return null;
}

/**
 * Reads and validates `<dataRoot>/cutover-handoff.json`. On success the file
 * is renamed to `cutover-handoff.consumed-<nonce>.json` and the record
 * returned; any failed check leaves the file where it is, records a
 * breadcrumb, and returns null.
 */
export function consumeCutoverHandoff(dataRoot: string, deps: ConsumeCutoverDeps): CutoverHandoffV1 | null {
  const file = cutoverHandoffPath(dataRoot);
  const reject = (reason: string): null => {
    deps.breadcrumbs.record("authority", { detail: `cutover handoff rejected: ${reason}` });
    return null;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return reject(`unreadable: ${(error as Error).message}`);
  }
  if (!isCutoverHandoff(parsed)) return reject("malformed record");
  if (path.resolve(parsed.targetDataRoot) !== path.resolve(dataRoot)) {
    return reject(`targets ${parsed.targetDataRoot}, not ${dataRoot}`);
  }
  const age = deps.now() - parsed.createdAtMs;
  if (age < 0 || age >= CUTOVER_HANDOFF_MAX_AGE_MS) return reject(`written ${age}ms ago`);
  const alive = deps.processAlive(parsed.pid, parsed.processStartMs);
  if (alive !== "alive") return reject(`writer pid ${parsed.pid} is ${alive}`);
  const lock = singletonLockHeldBy(parsed.legacyUserData, parsed.pid, deps);
  if (lock !== null) return reject(lock);
  fs.renameSync(file, path.join(dataRoot, `cutover-handoff.consumed-${parsed.nonce}.json`));
  deps.breadcrumbs.record("authority", {
    detail: `cutover handoff accepted from pid ${parsed.pid} for ${parsed.legacyUserData}`,
  });
  return parsed;
}
