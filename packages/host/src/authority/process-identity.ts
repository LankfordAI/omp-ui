import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

/**
 * Process and boot identity for the authority claim and the children ledger
 * (issue #442 §10.1). A pid alone proves nothing — pids recycle — so every
 * record pairs it with the process start time and the kernel boot it belongs
 * to, and every liveness answer is one of three values: `alive` (pid exists
 * and its start time matches the record), `dead` (no such process, or the
 * pid has been reused by a process started at another time), or
 * `unverifiable` (the platform could not answer). Callers never treat
 * `unverifiable` as dead.
 *
 * Every shell-out and file read goes through the injected seams so tests
 * exercise the parsers against fixtures without spawning anything.
 */
export type ProcessLiveness = "alive" | "dead" | "unverifiable";

export interface ProcessIdentityDeps {
  readFile?: (p: string) => string;
  /** Stdout of `cmd`; throws only when the command cannot run at all. A non-zero exit still yields its stdout. */
  exec?: (cmd: string, args: string[]) => string;
  uptimeSeconds?: () => number;
  now?: () => number;
}

/** Two start times this close are the same process: `ps` prints whole seconds, and `/proc` ticks at 10 ms. */
export const START_TIME_TOLERANCE_MS = 2_000;

/**
 * Uptime-derived boot ids (Windows, and any platform without a kernel boot
 * id) are `wallClock - uptime`, so a wall-clock adjustment after the record
 * was written shifts a later reading by the adjustment. Two readings this
 * close describe one boot — no machine boots twice in five seconds — so the
 * tolerance only ever prevents a false "other boot" takeover.
 */
const BOOT_TIME_TOLERANCE_MS = 5_000;

const FILETIME_EPOCH_OFFSET_100NS = 116444736000000000n;

const defaultExec = (cmd: string, args: string[]): string => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  } catch (error) {
    // A non-zero exit (e.g. `ps -p` with no match) still produced stdout; only a
    // command that could not run has none to give.
    if (
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number" &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return error.stdout;
    }
    throw error;
  }
};

function resolve(deps: ProcessIdentityDeps | undefined): Required<ProcessIdentityDeps> {
  return {
    readFile: deps?.readFile ?? ((p) => fs.readFileSync(p, "utf8")),
    exec: deps?.exec ?? defaultExec,
    uptimeSeconds: deps?.uptimeSeconds ?? os.uptime,
    now: deps?.now ?? Date.now,
  };
}

/**
 * An opaque string that changes on every kernel boot. Linux reads the
 * kernel's random boot id; macOS the `sec` of `kern.boottime`; elsewhere
 * `now - uptime` rounded to the second, the only boot identity such a
 * platform offers. Throws when the platform's source is unreadable: a host
 * that cannot name its boot cannot prove anything about pids and must not
 * claim.
 */
export function readBootId(platform: NodeJS.Platform = process.platform, deps?: ProcessIdentityDeps): string {
  const d = resolve(deps);
  switch (platform) {
    case "linux": {
      const id = d.readFile("/proc/sys/kernel/random/boot_id").trim();
      if (id.length === 0) throw new Error("boot id: /proc/sys/kernel/random/boot_id is empty");
      return id;
    }
    case "darwin": {
      const out = d.exec("sysctl", ["-n", "kern.boottime"]);
      const match = /sec\s*=\s*(\d+)/.exec(out);
      if (match === null) throw new Error(`boot id: unparseable kern.boottime ${JSON.stringify(out.trim())}`);
      return match[1];
    }
    default:
      return String(Math.round((d.now() - d.uptimeSeconds() * 1000) / 1000) * 1000);
  }
}

/**
 * Whether two boot ids name the same kernel boot. Exact match, except that
 * two uptime-derived ids within `BOOT_TIME_TOLERANCE_MS` are one boot.
 */
export function sameBoot(a: string, b: string): boolean {
  if (a === b) return true;
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  return Math.abs(Number(a) - Number(b)) <= BOOT_TIME_TOLERANCE_MS;
}

let cachedClockTicks: number | undefined;

/** `getconf CLK_TCK`, or 100 (USER_HZ on every Linux ABI). Cached only for the real system, never for an injected seam. */
function linuxClockTicks(d: Required<ProcessIdentityDeps>, cache: boolean): number {
  if (cache && cachedClockTicks !== undefined) return cachedClockTicks;
  let ticks = 100;
  try {
    const parsed = Number.parseInt(d.exec("getconf", ["CLK_TCK"]).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) ticks = parsed;
  } catch {
    // getconf only confirms the ABI constant.
  }
  if (cache) cachedClockTicks = ticks;
  return ticks;
}

/**
 * The state (field 3) and start time in clock ticks (field 22) of a
 * `/proc/<pid>/stat` line. `comm` may contain spaces and parentheses, so the
 * numbered fields resume after the LAST `)`. `null` when unparseable.
 */
export function parseLinuxStat(statLine: string): { state: string; startTicks: number } | null {
  const close = statLine.lastIndexOf(")");
  if (close < 0) return null;
  const fields = statLine.slice(close + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state); field 22 (starttime) is index 19.
  if (fields.length < 20) return null;
  const startTicks = Number(fields[19]);
  if (!Number.isFinite(startTicks)) return null;
  return { state: fields[0], startTicks };
}

/** Start time in ms from a parsed stat line and `/proc/stat`'s `btime`; `null` when `btime` is missing. */
export function linuxStartMs(stat: { startTicks: number }, procStat: string, clockTicks: number): number | null {
  const btimeMatch = /^btime\s+(\d+)\s*$/m.exec(procStat);
  if (btimeMatch === null) return null;
  return Number(btimeMatch[1]) * 1000 + Math.round((stat.startTicks * 1000) / clockTicks);
}

/** `ps -o lstart=` output (`Wed Sep  3 10:23:45 2026`) as local-time ms; `null` when unparseable. */
export function parseLstartMs(out: string): number | null {
  const text = out.trim().replace(/\s+/g, " ");
  if (text.length === 0) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** Windows FILETIME (100 ns since 1601-01-01 UTC) as Unix ms; `null` when not a non-negative integer. */
export function parseFileTimeMs(out: string): number | null {
  const text = out.trim();
  if (!/^\d+$/.test(text)) return null;
  return Number((BigInt(text) - FILETIME_EPOCH_OFFSET_100NS) / 10_000n);
}

/** Sentinel the Windows probe prints when `Get-Process` finds no such pid. */
const WINDOWS_NO_PROCESS = "none";

function windowsStartTimeCommand(pid: number): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToFileTimeUtc() } else { '${WINDOWS_NO_PROCESS}' }`,
  ];
}

function matches(observedMs: number, recordedMs: number): ProcessLiveness {
  return Math.abs(observedMs - recordedMs) <= START_TIME_TOLERANCE_MS ? "alive" : "dead";
}

/**
 * Whether the process `pid` recorded as started at `startMs` is still
 * running. See the module comment for the three answers; a pid that exists
 * with a different start time is `dead` (the number was reused), and so is
 * a Linux zombie — its pid entry lingers, but nothing can execute in it.
 */
export function processAlive(
  pid: number,
  startMs: number,
  platform: NodeJS.Platform = process.platform,
  deps?: ProcessIdentityDeps,
): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  const d = resolve(deps);
  switch (platform) {
    case "linux": {
      let statLine: string;
      try {
        statLine = d.readFile(`/proc/${pid}/stat`);
      } catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        return code === "ENOENT" || code === "ESRCH" ? "dead" : "unverifiable";
      }
      const stat = parseLinuxStat(statLine);
      if (stat === null) return "unverifiable";
      if (stat.state === "Z" || stat.state === "X") return "dead";
      let procStat: string;
      try {
        procStat = d.readFile("/proc/stat");
      } catch {
        return "unverifiable";
      }
      const observed = linuxStartMs(stat, procStat, linuxClockTicks(d, deps?.exec === undefined));
      return observed === null ? "unverifiable" : matches(observed, startMs);
    }
    case "win32": {
      let out: string;
      try {
        out = d.exec("powershell", windowsStartTimeCommand(pid));
      } catch {
        return "unverifiable";
      }
      if (out.trim() === WINDOWS_NO_PROCESS) return "dead";
      const observed = parseFileTimeMs(out);
      return observed === null ? "unverifiable" : matches(observed, startMs);
    }
    case "darwin": {
      let out: string;
      try {
        out = d.exec("ps", ["-o", "lstart=", "-p", String(pid)]);
      } catch {
        return "unverifiable";
      }
      if (out.trim().length === 0) return "dead";
      const observed = parseLstartMs(out);
      return observed === null ? "unverifiable" : matches(observed, startMs);
    }
    default:
      return "unverifiable";
  }
}

/**
 * This process's start time in ms, read from the same source `processAlive`
 * will consult about it later, so the two agree exactly. When that source is
 * unavailable, `now - process.uptime()` rounded to the second — within
 * `START_TIME_TOLERANCE_MS` of any observer's reading.
 */
export function ownProcessStartMs(platform: NodeJS.Platform = process.platform, deps?: ProcessIdentityDeps): number {
  const d = resolve(deps);
  let observed: number | null = null;
  try {
    switch (platform) {
      case "linux": {
        const stat = parseLinuxStat(d.readFile("/proc/self/stat"));
        if (stat !== null) observed = linuxStartMs(stat, d.readFile("/proc/stat"), linuxClockTicks(d, deps?.exec === undefined));
        break;
      }
      case "win32": {
        const out = d.exec("powershell", windowsStartTimeCommand(process.pid));
        if (out.trim() !== WINDOWS_NO_PROCESS) observed = parseFileTimeMs(out);
        break;
      }
      case "darwin":
        observed = parseLstartMs(d.exec("ps", ["-o", "lstart=", "-p", String(process.pid)]));
        break;
      default:
        break;
    }
  } catch {
    // The fallback below is within tolerance of any observer.
  }
  return observed ?? Math.round((d.now() - process.uptime() * 1000) / 1000) * 1000;
}
