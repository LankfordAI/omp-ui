import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BreadcrumbEntry, BreadcrumbSink } from "@omp-ui/core";
import type { HostConnectionRecordV1 } from "../control/connection-record";
import { AuthorityConflict, acquireHostLock, lockPath, readOwnerRecord, type HostLockDeps, type OwnerRecordV1 } from "./lock";
import type { ProcessLiveness } from "./process-identity";

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

const RECORD: HostConnectionRecordV1 = {
  schemaVersion: 1,
  dataRoot: "",
  hostVersion: "1.0.0",
  hostProtocol: 1,
  protocolRange: { min: 1, max: 1 },
  endpoint: "http://127.0.0.1:4677",
  desktopCredential: "omp1.desk.x",
  controlCredential: "omp1.ctl.x",
  pid: 111,
  processStartMs: 1_000,
  startedAtMs: 1_000,
  incarnation: 1,
};

interface Fake {
  deps: HostLockDeps;
  sink: RecordingSink;
  liveness: Record<number, ProcessLiveness>;
}

function fake(over: Partial<HostLockDeps> = {}): Fake {
  const sink = crumbs();
  const liveness: Record<number, ProcessLiveness> = {};
  const deps: HostLockDeps = {
    hostVersion: "1.0.0",
    flavor: "dev",
    probe: async () => false,
    processAlive: (pid) => liveness[pid] ?? "dead",
    bootId: () => "boot-A",
    now: () => 1_700_000_000_000,
    breadcrumbs: sink,
    pid: 111,
    processStartMs: 5_000,
    readHostRecord: () => null,
    ...over,
  };
  return { deps, sink, liveness };
}

function ownerOf(file: string): OwnerRecordV1 {
  return JSON.parse(fs.readFileSync(file, "utf8")) as OwnerRecordV1;
}

describe("acquireHostLock", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-host-lock-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("links a fresh claim as host.lock with incarnation 1 and records the claim", async () => {
    const f = fake();
    const lock = await acquireHostLock(root, f.deps);
    expect(lock.owner).toMatchObject({
      schemaVersion: 1,
      pid: 111,
      bootId: "boot-A",
      processStartMs: 5_000,
      startedAtMs: 1_700_000_000_000,
      incarnation: 1,
      hostVersion: "1.0.0",
      dataRoot: root,
      flavor: "dev",
    });
    expect(readOwnerRecord(root)).toEqual(lock.owner);
    expect(fs.statSync(lockPath(root)).ino).toBe(lock.ino);
    const dirs = fs.readdirSync(path.join(root, "locks"));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^host-[0-9a-f]{16}$/);
    expect(fs.statSync(path.join(root, "locks", dirs[0], "owner.json")).ino).toBe(lock.ino);
    if (process.platform !== "win32") {
      expect(fs.statSync(lockPath(root)).mode & 0o777).toBe(0o600);
    }
    expect(lock.assertStillOwner()).toBe(true);
    expect(f.sink.details()).toEqual(["claim incarnation=1 pid=111"]);
  });

  it("refuses with `live host` when the connection record's probe answers, whatever the owner file says", async () => {
    const first = fake();
    await acquireHostLock(root, first.deps);
    // Even a dead-looking owner cannot be taken over from while a host answers.
    const second = fake({ pid: 222, probe: async () => true, readHostRecord: () => RECORD });
    const error = await acquireHostLock(root, second.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorityConflict);
    const conflict = error as AuthorityConflict;
    expect(conflict.reason).toBe("live host");
    expect(conflict.owner?.pid).toBe(111);
    expect(conflict.record).toBe(RECORD);
    expect(conflict.message).toContain("http://127.0.0.1:4677");
    expect(readOwnerRecord(root)?.pid).toBe(111);
    expect(second.sink.details()).toEqual(["conflict live host pid=111 endpoint=http://127.0.0.1:4677"]);
  });

  it("takes over a dead same-boot owner: renames it aside, increments the incarnation, invalidates the old holder", async () => {
    const first = fake();
    const oldLock = await acquireHostLock(root, first.deps);
    const second = fake({ pid: 222 });
    second.liveness[111] = "dead";
    const lock = await acquireHostLock(root, second.deps);
    expect(lock.owner.incarnation).toBe(2);
    expect(lock.owner.pid).toBe(222);
    expect(readOwnerRecord(root)?.pid).toBe(222);
    const stale = `${lockPath(root)}.stale-2`;
    expect(ownerOf(stale)).toMatchObject({ pid: 111, incarnation: 1 });
    expect(fs.statSync(stale).ino).toBe(oldLock.ino);
    expect(oldLock.assertStillOwner()).toBe(false);
    expect(lock.assertStillOwner()).toBe(true);
    expect(second.sink.details()).toEqual(["takeover dead pid=111 incarnation=1 → incarnation=2 pid=222"]);
  });

  it("takes over an owner from another boot without consulting process liveness", async () => {
    const first = fake({ bootId: () => "boot-OLD" });
    await acquireHostLock(root, first.deps);
    const second = fake({
      pid: 222,
      processAlive: () => {
        throw new Error("liveness must not be consulted across boots");
      },
    });
    const lock = await acquireHostLock(root, second.deps);
    expect(lock.owner).toMatchObject({ pid: 222, incarnation: 2, bootId: "boot-A" });
    expect(fs.existsSync(`${lockPath(root)}.stale-2`)).toBe(true);
    expect(second.sink.details()).toEqual(["takeover other boot pid=111 incarnation=1 → incarnation=2 pid=222"]);
  });

  it("refuses an alive owner and an unverifiable one, leaving the holder untouched", async () => {
    const first = fake();
    const held = await acquireHostLock(root, first.deps);
    for (const [liveness, reason] of [
      ["alive", "owner alive"],
      ["unverifiable", "owner unverifiable"],
    ] as const) {
      const contender = fake({ pid: 222 });
      contender.liveness[111] = liveness;
      const error = await acquireHostLock(root, contender.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthorityConflict);
      expect((error as AuthorityConflict).reason).toBe(reason);
      expect((error as AuthorityConflict).owner?.pid).toBe(111);
      expect(contender.sink.details()).toEqual([`conflict ${reason} pid=111 incarnation=1`]);
    }
    expect(held.assertStillOwner()).toBe(true);
    expect(readOwnerRecord(root)).toEqual(held.owner);
    expect(fs.readdirSync(root).filter((n) => n.startsWith("host.lock.stale-"))).toEqual([]);
  });

  it("takes over an unparseable host.lock when no live host answers", async () => {
    fs.writeFileSync(lockPath(root), "not json");
    const f = fake();
    const lock = await acquireHostLock(root, f.deps);
    expect(lock.owner.incarnation).toBe(1);
    expect(readOwnerRecord(root)?.pid).toBe(111);
    expect(fs.readFileSync(`${lockPath(root)}.stale-1`, "utf8")).toBe("not json");
    expect(f.sink.details()).toEqual(["takeover unparseable owner → incarnation=1 pid=111"]);
  });

  /** A rival that finishes its own takeover while `contender` is still deciding about the dead owner. */
  function rivalTakeover(root: string, vacate: (lockFile: string, staleName: string) => void) {
    const lockFile = lockPath(root);
    const staleName = `${lockFile}.stale-2`;
    const dead = ownerOf(lockFile);
    vacate(lockFile, staleName);
    const rivalOwner = path.join(root, "locks", "host-rival", "owner.json");
    fs.mkdirSync(path.dirname(rivalOwner), { recursive: true });
    fs.writeFileSync(rivalOwner, JSON.stringify({ ...dead, pid: 333, incarnation: 2 }));
    fs.linkSync(rivalOwner, lockFile);
  }

  it("loses the race when a rival claimed the stale name first", async () => {
    await acquireHostLock(root, fake().deps);
    const contender = fake({
      pid: 222,
      processAlive: () => {
        rivalTakeover(root, (lockFile, staleName) => fs.renameSync(lockFile, staleName));
        return "dead";
      },
    });
    const error = await acquireHostLock(root, contender.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorityConflict);
    expect((error as AuthorityConflict).reason).toBe("lost race");
    expect((error as AuthorityConflict).owner?.pid).toBe(333);
    expect(readOwnerRecord(root)?.pid).toBe(333);
    expect(ownerOf(`${lockPath(root)}.stale-2`).pid).toBe(111);
    expect(contender.sink.details()).toEqual(["conflict lost race pid=333"]);
  });

  it("loses the race when host.lock changed hands under it, and never displaces the new owner", async () => {
    await acquireHostLock(root, fake().deps);
    const contender = fake({
      pid: 222,
      processAlive: () => {
        // No stale name to contend on: the rival saw the name vanish and linked fresh.
        rivalTakeover(root, (lockFile) => fs.rmSync(lockFile));
        return "dead";
      },
    });
    const error = await acquireHostLock(root, contender.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorityConflict);
    expect((error as AuthorityConflict).reason).toBe("lost race");
    expect(readOwnerRecord(root)?.pid).toBe(333);
    expect(fs.existsSync(`${lockPath(root)}.stale-2`)).toBe(false);
    expect(contender.sink.details()).toEqual(["conflict lost race pid=333"]);
  });

  it("assertStillOwner is false once host.lock is replaced or gone", async () => {
    const lock = await acquireHostLock(root, fake().deps);
    expect(lock.assertStillOwner()).toBe(true);
    fs.rmSync(lockPath(root));
    expect(lock.assertStillOwner()).toBe(false);
    fs.writeFileSync(lockPath(root), JSON.stringify(lock.owner));
    expect(lock.assertStillOwner()).toBe(false);
  });

  it("sweepStale removes only leftovers whose owner is proven dead or from another boot", async () => {
    const f = fake();
    const lock = await acquireHostLock(root, f.deps);
    const leftover = (name: string, owner: Partial<OwnerRecordV1> | string) => {
      const file = path.join(root, "locks", name, "owner.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof owner === "string" ? owner : JSON.stringify({ ...lock.owner, ...owner }));
    };
    leftover("host-dead", { pid: 900 });
    leftover("host-alive", { pid: 901 });
    leftover("host-unverifiable", { pid: 902 });
    leftover("host-otherboot", { pid: 903, bootId: "boot-OLD" });
    leftover("host-garbage", "{");
    f.liveness[901] = "alive";
    f.liveness[902] = "unverifiable";
    f.liveness[903] = "alive";
    fs.writeFileSync(`${lockPath(root)}.stale-3`, JSON.stringify({ ...lock.owner, pid: 900, incarnation: 3 }));
    fs.writeFileSync(`${lockPath(root)}.stale-4`, JSON.stringify({ ...lock.owner, pid: 901, incarnation: 4 }));

    lock.sweepStale();

    const ownDir = fs.readdirSync(path.join(root, "locks")).find((n) => !["host-alive", "host-unverifiable", "host-garbage"].includes(n));
    expect(fs.readdirSync(path.join(root, "locks")).sort()).toEqual(
      ["host-alive", "host-garbage", "host-unverifiable", ownDir].sort(),
    );
    expect(fs.existsSync(`${lockPath(root)}.stale-3`)).toBe(false);
    expect(fs.existsSync(`${lockPath(root)}.stale-4`)).toBe(true);
    expect(lock.assertStillOwner()).toBe(true);
    expect(f.sink.details().slice(1).sort()).toEqual(
      ["swept host.lock.stale-3", "swept locks/host-dead", "swept locks/host-otherboot"].sort(),
    );
  });
});
