import { describe, expect, it, vi } from "vitest";
import {
  startFdWatchdog,
  summarizeTargets,
  thresholdViolations,
  type FdSnapshot,
} from "./fd-watchdog";

const snap = (over: Partial<FdSnapshot>): FdSnapshot => ({
  at: 0,
  total: 100,
  byType: {},
  children: [],
  ...over,
});

describe("summarizeTargets (issue #184)", () => {
  it("buckets the /proc fd target shapes", () => {
    expect(
      summarizeTargets([
        "socket:[123]",
        "pipe:[456]",
        "anon_inode:inotify",
        "anon_inode:[eventpoll]",
        "/dev/pts/3",
        "/dev/ptmx",
        "/home/u/cache (deleted)",
        "/home/u/file.txt",
        "memfd:something",
      ]),
    ).toEqual({
      socket: 1,
      pipe: 1,
      inotify: 1,
      "eventpoll/eventfd": 1,
      pts: 2,
      "deleted-file": 1,
      file: 1,
      other: 1,
    });
  });
});

describe("thresholdViolations (issue #184)", () => {
  const limits = { maxTotal: 4096, maxInotify: 64, growthFactor: 2 };

  it("is quiet at baseline", () => {
    expect(thresholdViolations(snap({}), snap({}), limits)).toEqual([]);
  });

  it("fires on the absolute total", () => {
    expect(thresholdViolations(snap({ total: 5000 }), snap({}), limits)[0]).toContain("5000");
  });

  it("fires on inotify", () => {
    expect(
      thresholdViolations(snap({ byType: { inotify: 100 } }), snap({}), limits)[0],
    ).toContain("inotify");
  });

  it("fires on growth past the factor and floor", () => {
    const base = snap({ total: 100 });
    expect(thresholdViolations(snap({ total: 700 }), base, limits)).toHaveLength(1);
    expect(thresholdViolations(snap({ total: 500 }), base, limits)).toEqual([]);
  });
});

describe("startFdWatchdog (issue #184)", () => {
  it("is a no-op off Linux", () => {
    const log = vi.fn();
    const stop = startFdWatchdog({ logDir: "/tmp", platform: "darwin", log });
    stop();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a baseline once, alerts on breach (rate-limited), then recovers", () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      let current = ["socket:[1]"];
      const stop = startFdWatchdog({
        logDir: "/tmp",
        platform: "linux",
        intervalMs: 1_000,
        limits: { maxTotal: 2 },
        listFds: () => current.map((_, i) => String(i)),
        readFdTarget: (p) => {
          const sep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
          return current[Number(p.slice(sep + 1))]!;
        },
        listChildren: () => [],
        log,
      });

      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toContain("baseline");

      current = ["socket:[1]", "socket:[2]", "socket:[3]"];
      vi.advanceTimersByTime(1_000);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[1]![0]).toContain("ALERT");

      // Rate-limited while elevated.
      vi.advanceTimersByTime(1_000);
      expect(log).toHaveBeenCalledTimes(2);

      current = ["socket:[1]"];
      vi.advanceTimersByTime(1_000);
      expect(log).toHaveBeenCalledTimes(3);
      expect(log.mock.calls[2]![0]).toContain("recovered");

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
