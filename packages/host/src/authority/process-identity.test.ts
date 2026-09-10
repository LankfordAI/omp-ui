import { describe, expect, it } from "vitest";
import {
  linuxStartMs,
  ownProcessStartMs,
  parseFileTimeMs,
  parseLinuxStat,
  parseLstartMs,
  processAlive,
  readBootId,
  sameBoot,
  type ProcessIdentityDeps,
} from "./process-identity";

const LINUX_STAT =
  "279286 (node) R 151267 279286 279286 0 -1 4194304 4647 0 0 0 6 2 0 0 20 0 7 0 122750200 1057980416 13775 18446744073709551615 94686811717632 94686811734037 140731355855360 0 0 0 0 16781312 17922 0 0 0 17 3 0 0 0 0 0 94686811745624 94686811746308 94687799693312 140731355858998 140731355859614 140731355859614 140731355865066 0\n";
const PROC_STAT = "cpu  1 2 3 4 5 6 7 0 0 0\nintr 12345 0\nctxt 999\nbtime 1787845647\nprocesses 12\n";
/** btime × 1000 + 122750200 ticks / 100 Hz. */
const LINUX_START_MS = 1_787_845_647_000 + 1_227_502_000;

function enoent(): Error & { code: string } {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

function noExec(): never {
  throw new Error("test must not spawn");
}

describe("readBootId", () => {
  it("linux: trims the kernel boot id and refuses an empty one", () => {
    expect(readBootId("linux", { readFile: () => "fb63b35f-6958-4241-904c-fe429e8db648\n", exec: noExec })).toBe(
      "fb63b35f-6958-4241-904c-fe429e8db648",
    );
    expect(() => readBootId("linux", { readFile: () => "\n", exec: noExec })).toThrow(/empty/);
    expect(() =>
      readBootId("linux", {
        readFile: () => {
          throw enoent();
        },
        exec: noExec,
      }),
    ).toThrow(/ENOENT/);
  });

  it("darwin: takes `sec` from kern.boottime", () => {
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return "{ sec = 1757500000, usec = 123456 } Wed Sep 10 08:00:00 2026\n";
    };
    expect(readBootId("darwin", { exec })).toBe("1757500000");
    expect(calls).toEqual([["sysctl", "-n", "kern.boottime"]]);
    expect(() => readBootId("darwin", { exec: () => "sysctl: unknown oid\n" })).toThrow(/unparseable/);
  });

  it("win32 and unknown platforms: now − uptime, rounded to the second, as a string", () => {
    const deps: ProcessIdentityDeps = { now: () => 2_000_400, uptimeSeconds: () => 1000.2, exec: noExec };
    expect(readBootId("win32", deps)).toBe("1000000");
    expect(readBootId("freebsd", deps)).toBe("1000000");
  });
});

describe("sameBoot", () => {
  it("matches kernel ids exactly and uptime-derived ids within five seconds", () => {
    expect(sameBoot("fb63b35f", "fb63b35f")).toBe(true);
    expect(sameBoot("fb63b35f", "fb63b35e")).toBe(false);
    expect(sameBoot("1000000", "1005000")).toBe(true);
    expect(sameBoot("1000000", "1006000")).toBe(false);
    expect(sameBoot("1000000", "fb63b35f")).toBe(false);
  });
});

describe("linux parsers", () => {
  it("reads state and start ticks after the last ')' even when comm contains spaces and parens", () => {
    expect(parseLinuxStat(LINUX_STAT)).toEqual({ state: "R", startTicks: 122_750_200 });
    const weird = LINUX_STAT.replace("(node)", "(my (odd) name)");
    expect(parseLinuxStat(weird)).toEqual({ state: "R", startTicks: 122_750_200 });
    expect(parseLinuxStat("garbage")).toBeNull();
    expect(parseLinuxStat("1 (x) R 2 3")).toBeNull();
  });

  it("combines btime and ticks at the given clock rate", () => {
    expect(linuxStartMs({ startTicks: 122_750_200 }, PROC_STAT, 100)).toBe(LINUX_START_MS);
    expect(linuxStartMs({ startTicks: 1_000 }, PROC_STAT, 1000)).toBe(1_787_845_647_000 + 1_000);
    expect(linuxStartMs({ startTicks: 1 }, "cpu 1 2 3\n", 100)).toBeNull();
  });
});

describe("processAlive on linux", () => {
  function linuxDeps(files: Record<string, string | (() => string)>, clkTck = "100\n"): ProcessIdentityDeps {
    return {
      readFile: (p) => {
        const entry = files[p];
        if (entry === undefined) throw enoent();
        return typeof entry === "function" ? entry() : entry;
      },
      exec: (cmd, args) => {
        expect([cmd, ...args]).toEqual(["getconf", "CLK_TCK"]);
        return clkTck;
      },
    };
  }
  const files = { "/proc/4242/stat": LINUX_STAT, "/proc/stat": PROC_STAT };

  it("is alive when the start time matches within two seconds and dead beyond it (pid reuse)", () => {
    expect(processAlive(4242, LINUX_START_MS, "linux", linuxDeps(files))).toBe("alive");
    expect(processAlive(4242, LINUX_START_MS + 1_999, "linux", linuxDeps(files))).toBe("alive");
    expect(processAlive(4242, LINUX_START_MS - 2_001, "linux", linuxDeps(files))).toBe("dead");
  });

  it("is dead when /proc/<pid> is missing, the pid is invalid, or the process is a zombie", () => {
    expect(processAlive(9999, LINUX_START_MS, "linux", linuxDeps(files))).toBe("dead");
    expect(processAlive(0, LINUX_START_MS, "linux", linuxDeps(files))).toBe("dead");
    expect(processAlive(-5, LINUX_START_MS, "linux", linuxDeps(files))).toBe("dead");
    const zombie = { ...files, "/proc/4242/stat": LINUX_STAT.replace(") R ", ") Z ") };
    expect(processAlive(4242, LINUX_START_MS, "linux", linuxDeps(zombie))).toBe("dead");
  });

  it("is unverifiable on unreadable or unparseable sources", () => {
    const eacces = {
      ...files,
      "/proc/4242/stat": () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    expect(processAlive(4242, LINUX_START_MS, "linux", linuxDeps(eacces))).toBe("unverifiable");
    expect(processAlive(4242, LINUX_START_MS, "linux", linuxDeps({ ...files, "/proc/4242/stat": "nonsense" }))).toBe(
      "unverifiable",
    );
    expect(processAlive(4242, LINUX_START_MS, "linux", linuxDeps({ ...files, "/proc/stat": "cpu 1 2\n" }))).toBe(
      "unverifiable",
    );
    expect(processAlive(4242, LINUX_START_MS, "linux", linuxDeps({ "/proc/4242/stat": LINUX_STAT }))).toBe("unverifiable");
  });

  it("honours CLK_TCK from getconf and falls back to 100 when getconf cannot run", () => {
    // At 1000 Hz the same tick count is a tenth of the offset.
    const at1000Hz = 1_787_845_647_000 + 122_750_200;
    expect(processAlive(4242, at1000Hz, "linux", linuxDeps(files, "1000\n"))).toBe("alive");
    expect(processAlive(4242, LINUX_START_MS, "linux", linuxDeps(files, "1000\n"))).toBe("dead");
    const brokenGetconf: ProcessIdentityDeps = {
      readFile: linuxDeps(files).readFile,
      exec: () => {
        throw enoent();
      },
    };
    expect(processAlive(4242, LINUX_START_MS, "linux", brokenGetconf)).toBe("alive");
  });
});

describe("processAlive on darwin", () => {
  it("parses `ps -o lstart=` including the padded single-digit day", () => {
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return "Wed Sep  3 10:23:45 2026\n";
    };
    const startMs = parseLstartMs("Wed Sep 3 10:23:45 2026");
    expect(startMs).toBe(new Date(2026, 8, 3, 10, 23, 45).getTime());
    expect(processAlive(77, startMs!, "darwin", { exec })).toBe("alive");
    expect(processAlive(77, startMs! + 1_000, "darwin", { exec })).toBe("alive");
    expect(processAlive(77, startMs! + 60_000, "darwin", { exec })).toBe("dead");
    expect(calls[0]).toEqual(["ps", "-o", "lstart=", "-p", "77"]);
  });

  it("is dead on empty output and unverifiable when ps cannot run or prints nonsense", () => {
    expect(processAlive(77, 0, "darwin", { exec: () => "" })).toBe("dead");
    expect(processAlive(77, 0, "darwin", { exec: () => "   \n" })).toBe("dead");
    expect(processAlive(77, 0, "darwin", { exec: () => "not a date\n" })).toBe("unverifiable");
    expect(
      processAlive(77, 0, "darwin", {
        exec: () => {
          throw enoent();
        },
      }),
    ).toBe("unverifiable");
  });
});

describe("processAlive on win32", () => {
  const ms = 1_789_050_225_000;
  const fileTime = (BigInt(ms) * 10_000n + 116444736000000000n).toString();

  it("converts FILETIME and compares within tolerance", () => {
    expect(parseFileTimeMs(fileTime)).toBe(ms);
    expect(parseFileTimeMs("12x")).toBeNull();
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return `${fileTime}\r\n`;
    };
    expect(processAlive(555, ms, "win32", { exec })).toBe("alive");
    expect(processAlive(555, ms + 30_000, "win32", { exec })).toBe("dead");
    expect(calls[0][0]).toBe("powershell");
    expect(calls[0].at(-1)).toContain("Get-Process -Id 555");
  });

  it("is dead on the no-process sentinel and unverifiable when powershell fails", () => {
    expect(processAlive(555, ms, "win32", { exec: () => "none\r\n" })).toBe("dead");
    expect(processAlive(555, ms, "win32", { exec: () => "Get-Process : error\r\n" })).toBe("unverifiable");
    expect(
      processAlive(555, ms, "win32", {
        exec: () => {
          throw enoent();
        },
      }),
    ).toBe("unverifiable");
  });

  it("is unverifiable on a platform with no liveness source", () => {
    expect(processAlive(1, 0, "freebsd", { exec: noExec })).toBe("unverifiable");
  });
});

describe("ownProcessStartMs", () => {
  it("linux: reads /proc/self/stat so a later processAlive agrees exactly", () => {
    const deps: ProcessIdentityDeps = {
      readFile: (p) => {
        if (p === "/proc/self/stat") return LINUX_STAT;
        if (p === "/proc/stat") return PROC_STAT;
        throw enoent();
      },
      exec: () => "100\n",
    };
    expect(ownProcessStartMs("linux", deps)).toBe(LINUX_START_MS);
  });

  it("falls back to now − process.uptime() rounded to the second when the source is unreadable", () => {
    const now = 1_700_000_000_400;
    const deps: ProcessIdentityDeps = {
      readFile: () => {
        throw enoent();
      },
      exec: () => {
        throw enoent();
      },
      now: () => now,
    };
    const expected = Math.round((now - process.uptime() * 1000) / 1000) * 1000;
    const got = ownProcessStartMs("linux", deps);
    expect(got % 1000).toBe(0);
    expect(Math.abs(got - expected)).toBeLessThanOrEqual(1000);
    expect(ownProcessStartMs("freebsd", deps) % 1000).toBe(0);
  });
});
