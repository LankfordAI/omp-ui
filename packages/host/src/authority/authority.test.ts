import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BreadcrumbEntry, BreadcrumbSink } from "@omp-ui/core";
import {
  LOCK_ASSERT_INTERVAL_MS,
  claimAuthority,
  claimLegacyElectronAuthority,
  type AuthorityDeps,
} from "./authority";
import { lockPath, readOwnerRecord } from "./lock";

interface RecordingSink extends BreadcrumbSink {
  details(): string[];
}

function crumbs(): RecordingSink {
  const entries: BreadcrumbEntry[] = [];
  return {
    record(kind, fields = {}) {
      entries.push({ at: "", seq: entries.length, kind, ...fields });
    },
    entries: () => entries.slice(),
    details: () => entries.map((e) => e.detail ?? ""),
  };
}

function deps(over: Partial<Omit<AuthorityDeps, "breadcrumbs">> = {}): AuthorityDeps & { breadcrumbs: RecordingSink } {
  return {
    hostVersion: "1.2.3",
    flavor: "dev",
    probe: async () => false,
    processAlive: () => "dead",
    bootId: () => "boot-A",
    now: () => 1_700_000_000_000,
    breadcrumbs: crumbs(),
    pid: 4321,
    processStartMs: 9_000,
    ...over,
  };
}

/** Replaces host.lock with a fresh inode, as a takeover would. */
function displaceLock(root: string): void {
  const lockFile = lockPath(root);
  const owner = fs.readFileSync(lockFile, "utf8");
  fs.rmSync(lockFile);
  fs.writeFileSync(lockFile, owner);
}

describe("claimAuthority", () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-authority-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("publishes host.lock, sweeps proven-dead leftovers, and returns the token", async () => {
    const dead = path.join(root, "locks", "host-dead", "owner.json");
    fs.mkdirSync(path.dirname(dead), { recursive: true });
    fs.writeFileSync(
      dead,
      JSON.stringify({
        schemaVersion: 1,
        pid: 77,
        bootId: "boot-A",
        processStartMs: 1,
        startedAtMs: 1,
        incarnation: 3,
        hostVersion: "1.0.0",
        dataRoot: root,
        flavor: "dev",
      }),
    );
    const d = deps();
    const token = await claimAuthority(root, d);
    expect(token).toMatchObject({ dataRoot: root, incarnation: 1 });
    expect(readOwnerRecord(root)).toMatchObject({ pid: 4321, incarnation: 1, hostVersion: "1.2.3" });
    expect(fs.existsSync(path.dirname(dead))).toBe(false);
    expect(d.breadcrumbs.details()).toEqual(["claim incarnation=1 pid=4321", "swept locks/host-dead"]);
    token.release();
  });

  it("fires onLockLost exactly once when host.lock stops naming our inode", async () => {
    const onLockLost = vi.fn();
    const d = deps({ onLockLost });
    await claimAuthority(root, d);
    await vi.advanceTimersByTimeAsync(LOCK_ASSERT_INTERVAL_MS * 2);
    expect(onLockLost).not.toHaveBeenCalled();

    displaceLock(root);
    await vi.advanceTimersByTimeAsync(LOCK_ASSERT_INTERVAL_MS - 1);
    expect(onLockLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onLockLost).toHaveBeenCalledTimes(1);
    expect(d.breadcrumbs.details()).toContain("lock lost incarnation=1");

    await vi.advanceTimersByTimeAsync(LOCK_ASSERT_INTERVAL_MS * 3);
    expect(onLockLost).toHaveBeenCalledTimes(1);
    expect(d.breadcrumbs.details().filter((x) => x.startsWith("lock lost"))).toHaveLength(1);
  });

  it("release() stops the assertion without touching host.lock", async () => {
    const onLockLost = vi.fn();
    const token = await claimAuthority(root, deps({ onLockLost }));
    token.release();
    expect(fs.existsSync(lockPath(root))).toBe(true);
    displaceLock(root);
    await vi.advanceTimersByTimeAsync(LOCK_ASSERT_INTERVAL_MS * 3);
    expect(onLockLost).not.toHaveBeenCalled();
    expect(readOwnerRecord(root)?.pid).toBe(4321);
  });

  it("does not let a second claimant in while the owner is alive", async () => {
    const first = deps();
    await claimAuthority(root, first);
    const second = deps({ pid: 8765, processAlive: () => "alive" });
    await expect(claimAuthority(root, second)).rejects.toMatchObject({ name: "AuthorityConflict", reason: "owner alive" });
    expect(readOwnerRecord(root)?.pid).toBe(4321);
  });
});

describe("claimLegacyElectronAuthority", () => {
  it("is incarnation 0 for the given root and touches no file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-legacy-authority-"));
    try {
      expect(claimLegacyElectronAuthority(root)).toEqual({ dataRoot: root, incarnation: 0 });
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
