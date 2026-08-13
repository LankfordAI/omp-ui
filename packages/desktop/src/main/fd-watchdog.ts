import * as fs from "node:fs";
import * as path from "node:path";
import { appendMainLog } from "./main-log";

/**
 * Linux fd watchdog (issue #184). #64 was fixed blind and its recurrence
 * arrived with zero captured state; this sampler exists so the next event
 * comes with an fd-type fingerprint and a dying process attached. Zero-cost
 * at steady state: one baseline line at boot, alert lines only on threshold
 * crossings (rate-limited), one recovery line when counts fall back.
 */

export interface FdSnapshot {
  at: number;
  total: number;
  /** socket / pipe / inotify / eventpoll/eventfd / pts / file / deleted-file / other */
  byType: Record<string, number>;
  /** Direct children of this process (ppid match), with their fd totals. */
  children: { pid: number; comm: string; total: number }[];
}

export interface FdWatchdogLimits {
  maxTotal: number;
  maxInotify: number;
  growthFactor: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const ELEVATED_LOG_EVERY_MS = 300_000;
const DEFAULT_LIMITS: FdWatchdogLimits = { maxTotal: 4096, maxInotify: 64, growthFactor: 2 };

function classify(target: string): string {
  if (target.startsWith("socket:")) return "socket";
  if (target.startsWith("pipe:")) return "pipe";
  if (target === "anon_inode:inotify") return "inotify";
  if (target.startsWith("/dev/pts") || target === "/dev/ptmx") return "pts";
  if (target.endsWith(" (deleted)")) return "deleted-file";
  if (target.startsWith("anon_inode:")) return "eventpoll/eventfd";
  if (target.startsWith("/")) return "file";
  return "other";
}

/** Pure: classify readlink targets into byType buckets. */
export function summarizeTargets(targets: readonly string[]): Record<string, number> {
  const byType: Record<string, number> = {};
  for (const target of targets) {
    const kind = classify(target);
    byType[kind] = (byType[kind] ?? 0) + 1;
  }
  return byType;
}

/** Pure: human-readable threshold violations (empty = healthy). */
export function thresholdViolations(
  snap: FdSnapshot,
  baseline: FdSnapshot,
  limits: FdWatchdogLimits,
): string[] {
  const out: string[] = [];
  if (snap.total > limits.maxTotal) {
    out.push(`fd total ${snap.total} over limit ${limits.maxTotal}`);
  }
  const inotify = snap.byType["inotify"] ?? 0;
  if (inotify > limits.maxInotify) {
    out.push(`inotify fds ${inotify} over limit ${limits.maxInotify}`);
  }
  if (snap.total > Math.max(limits.growthFactor * baseline.total, baseline.total + 512)) {
    out.push(`fd total ${snap.total} is >${limits.growthFactor}x the boot baseline ${baseline.total}`);
  }
  return out;
}

/** Direct children of `selfPid`, from /proc stat ppid fields. */
function listChildrenFromProc(selfPid: number): { pid: number; comm: string }[] {
  const out: { pid: number; comm: string }[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    try {
      const stat = fs.readFileSync(path.join("/proc", entry, "stat"), "utf8");
      // pid (comm) state ppid … — comm may contain spaces/parens, so anchor on
      // the last ")"; ppid is the second field after it.
      const close = stat.lastIndexOf(")");
      if (close === -1) continue;
      const comm = stat.slice(stat.indexOf("(") + 1, close);
      const rest = stat.slice(close + 2).split(" ");
      if (Number(rest[1]) === selfPid) out.push({ pid, comm });
    } catch {
      // Exited mid-scan.
    }
  }
  return out;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export interface FdWatchdogOptions {
  logDir: string;
  intervalMs?: number;
  limits?: Partial<FdWatchdogLimits>;
  // Test seams — real defaults read /proc:
  listFds?: (dir: string) => string[];
  readFdTarget?: (fdPath: string) => string;
  listChildren?: (selfPid: number) => { pid: number; comm: string }[];
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Linux-only. Returns a stop function; a no-op stop off Linux. */
export function startFdWatchdog(opts: FdWatchdogOptions): () => void {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return () => {};
  const env = opts.env ?? process.env;
  const intervalMs =
    opts.intervalMs ?? intFromEnv(env, "OMP_UI_FD_WATCHDOG_INTERVAL_MS") ?? DEFAULT_INTERVAL_MS;
  const envMaxTotal = intFromEnv(env, "OMP_UI_FD_WATCHDOG_MAX_TOTAL");
  const limits: FdWatchdogLimits = {
    ...DEFAULT_LIMITS,
    ...opts.limits,
    ...(envMaxTotal !== undefined ? { maxTotal: envMaxTotal } : {}),
  };
  const listFds = opts.listFds ?? ((dir: string) => fs.readdirSync(dir));
  const readFdTarget = opts.readFdTarget ?? ((p: string) => fs.readlinkSync(p));
  const listChildren = opts.listChildren ?? listChildrenFromProc;
  const log = opts.log ?? ((line: string) => appendMainLog(opts.logDir, "fd-watchdog.log", line));

  const snapshot = (): FdSnapshot | null => {
    try {
      const fds = listFds("/proc/self/fd");
      const targets: string[] = [];
      for (const fd of fds) {
        try {
          targets.push(readFdTarget(path.join("/proc/self/fd", fd)));
        } catch {
          // fd churn between readdir and readlink.
        }
      }
      const children = listChildren(process.pid).map((c) => {
        let total = 0;
        try {
          total = listFds(`/proc/${c.pid}/fd`).length;
        } catch {
          // Exited between the ppid scan and the fd read.
        }
        return { ...c, total };
      });
      return { at: Date.now(), total: fds.length, byType: summarizeTargets(targets), children };
    } catch {
      return null;
    }
  };

  const baseline = snapshot();
  if (baseline) log(`baseline ${JSON.stringify(baseline)}`);
  let elevated = false;
  let lastElevatedLog = 0;
  const timer = setInterval(() => {
    const snap = snapshot();
    if (!snap || !baseline) return;
    const violations = thresholdViolations(snap, baseline, limits);
    const now = Date.now();
    if (violations.length > 0) {
      if (!elevated || now - lastElevatedLog >= ELEVATED_LOG_EVERY_MS) {
        log(`ALERT ${violations.join("; ")} | ${JSON.stringify(snap)}`);
        lastElevatedLog = now;
      }
      elevated = true;
    } else if (elevated) {
      log(`recovered ${JSON.stringify(snap)}`);
      elevated = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
