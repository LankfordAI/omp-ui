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

/** Direct children of `selfPid`: fast path via /proc/self/task/<tid>/children, async /proc fallback. */
async function listChildrenFromProcAsync(selfPid: number): Promise<{ pid: number; comm: string }[]> {
  try {
    const tids = await fs.promises.readdir("/proc/self/task");
    const childPids = new Set<number>();
    let readAny = false;
    await Promise.all(
      tids.map(async (tid) => {
        try {
          const raw = await fs.promises.readFile(path.join("/proc/self/task", tid, "children"), "utf8");
          readAny = true;
          for (const token of raw.trim().split(/\s+/)) {
            if (!token) continue;
            const pid = Number(token);
            if (Number.isInteger(pid) && pid > 0 && pid !== selfPid) childPids.add(pid);
          }
        } catch {
          // Thread exited mid-scan or CONFIG_PROC_CHILDREN unavailable.
        }
      }),
    );
    if (readAny) {
      const results = await Promise.all(
        [...childPids].map(async (pid) => {
          try {
            const comm = (await fs.promises.readFile(path.join("/proc", String(pid), "comm"), "utf8")).trim();
            return { pid, comm };
          } catch {
            return null;
          }
        }),
      );
      return results.filter((entry): entry is { pid: number; comm: string } => entry !== null);
    }
  } catch {
    // Fall through to bounded async /proc scan.
  }

  const entries = (await fs.promises.readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  const out: { pid: number; comm: string }[] = [];
  const CONCURRENCY = 16;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const entry = entries[cursor++]!;
      const pid = Number(entry);
      if (pid === selfPid) continue;
      try {
        const stat = await fs.promises.readFile(path.join("/proc", entry, "stat"), "utf8");
        const close = stat.lastIndexOf(")");
        if (close === -1) continue;
        const comm = stat.slice(stat.indexOf("(") + 1, close);
        const rest = stat.slice(close + 2).split(" ");
        if (Number(rest[1]) === selfPid) out.push({ pid, comm });
      } catch {
        // Exited mid-scan.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker()));
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
  // Test seams — real defaults read /proc asynchronously:
  listFds?: (dir: string) => string[] | Promise<string[]>;
  readFdTarget?: (fdPath: string) => string | Promise<string>;
  listChildren?: (selfPid: number) => { pid: number; comm: string }[] | Promise<{ pid: number; comm: string }[]>;
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
  const listFds = opts.listFds ?? ((dir: string) => fs.promises.readdir(dir));
  const readFdTarget = opts.readFdTarget ?? ((p: string) => fs.promises.readlink(p));
  const listChildren = opts.listChildren ?? listChildrenFromProcAsync;
  const log = opts.log ?? ((line: string) => appendMainLog(opts.logDir, "fd-watchdog.log", line));

  const takeSnapshot = async (): Promise<FdSnapshot | null> => {
    try {
      const fds = await listFds("/proc/self/fd");
      const targets: string[] = [];
      await Promise.all(
        fds.map(async (fd) => {
          try {
            targets.push(await readFdTarget(path.join("/proc/self/fd", fd)));
          } catch {
            // fd churn between readdir and readlink.
          }
        }),
      );
      const rawChildren = await listChildren(process.pid);
      const children = await Promise.all(
        rawChildren.map(async (c) => {
          let total = 0;
          try {
            total = (await listFds(`/proc/${c.pid}/fd`)).length;
          } catch {
            // Exited between the child scan and the fd read.
          }
          return { ...c, total };
        }),
      );
      return { at: Date.now(), total: fds.length, byType: summarizeTargets(targets), children };
    } catch {
      return null;
    }
  };

  let baseline: FdSnapshot | null = null;
  let elevated = false;
  let lastElevatedLog = 0;
  let inFlight = false;
  let stopped = false;

  const runBaseline = async (): Promise<void> => {
    inFlight = true;
    try {
      const snap = await takeSnapshot();
      if (stopped || !snap) return;
      baseline = snap;
      log(`baseline ${JSON.stringify(baseline)}`);
    } finally {
      inFlight = false;
    }
  };

  const runTick = async (): Promise<void> => {
    if (stopped || inFlight || !baseline) return;
    inFlight = true;
    try {
      const snap = await takeSnapshot();
      if (stopped || !snap || !baseline) return;
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
    } finally {
      inFlight = false;
    }
  };

  void runBaseline();
  const timer = setInterval(() => {
    void runTick();
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
