import * as fs from "node:fs";
import * as path from "node:path";
import { writeTextDurably, type BreadcrumbSink } from "@omp-ui/core";

/**
 * The note a legacy Electron authority leaves for the host it is handing its
 * data root to (issue #442, WP7 §10.2). The host consumes it only when the
 * writer is provably the live Electron instance that still holds Chromium's
 * `SingletonLock` on the legacy userData dir — a stale or forged note is
 * ignored and left in place for a human to look at.
 */

export interface CutoverHandoffV1 {
  schemaVersion: 1;
  pid: number;
  processStartMs: number;
  legacyUserData: string;
  targetDataRoot: string;
  nonce: string;
  createdAtMs: number;
}

export const CUTOVER_HANDOFF_MAX_AGE_MS = 10 * 60_000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function cutoverHandoffPath(dataRoot: string): string {
  return path.join(dataRoot, "cutover-handoff.json");
}

/** Written by the legacy authority just before it exits; durable and private. */
export function writeCutoverHandoff(record: CutoverHandoffV1): void {
  if (!NONCE_PATTERN.test(record.nonce)) throw new Error(`cutover nonce is not filename-safe: ${record.nonce}`);
  writeTextDurably(cutoverHandoffPath(record.targetDataRoot), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

function isHandoff(value: unknown): value is CutoverHandoffV1 {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>; // shape-checked field by field below
  return (
    v.schemaVersion === 1 &&
    typeof v.pid === "number" &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.processStartMs === "number" &&
    typeof v.legacyUserData === "string" &&
    typeof v.targetDataRoot === "string" &&
    typeof v.nonce === "string" &&
    NONCE_PATTERN.test(v.nonce) &&
    typeof v.createdAtMs === "number"
  );
}

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
  if (!isHandoff(parsed)) return reject("malformed record");
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
