import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeTextDurably, type BuildFlavor } from "@omp-ui/core";
import type { HostConnectionRecordV1 } from "@omp-ui/core";
import type { AuthorityDeps } from "./authority";
import { sameBoot } from "./process-identity";

/**
 * The single-owner lock on a data root (issue #442 §10.1; #450). A claimant
 * writes its own `locks/host-<rand>/owner.json` and publishes it by hard link
 * as `<dataRoot>/host.lock`: `link(2)` is atomic and fails `EEXIST` when the
 * name exists, so exactly one owner.json is ever reachable through that name.
 * `host.lock` is never unlinked — a takeover renames it aside, and only after
 * proving the recorded owner dead or released. Ownership while running is the
 * inode identity of the two names; no lease, heartbeat, or clock is involved,
 * so a suspended machine resumes into the same lock rather than an expired one.
 */
export interface OwnerRecordV1 {
  schemaVersion: 1;
  pid: number;
  bootId: string;
  processStartMs: number;
  startedAtMs: number;
  incarnation: number;
  hostVersion: string;
  dataRoot: string;
  flavor: BuildFlavor;
  /**
   * Set in place by `release()` (issue #442 §10.2): the owner gave the root up
   * while still running — the update handover's arbiter, or a clean stop — so
   * a claimant may take over without proving the pid dead.
   */
  releasedAtMs?: number;
}

export type AuthorityConflictReason = "live host" | "owner alive" | "owner unverifiable" | "lost race";

/** Another authority owns (or is claiming) the data root; the claimant must exit without touching state. */
export class AuthorityConflict extends Error {
  readonly reason: AuthorityConflictReason;
  /** The owner record that vetoed the claim, when one was readable. */
  readonly owner: OwnerRecordV1 | null;
  /** The connection record whose probe answered, for a `live host` conflict. */
  readonly record: HostConnectionRecordV1 | null;

  constructor(reason: AuthorityConflictReason, owner: OwnerRecordV1 | null, record: HostConnectionRecordV1 | null) {
    super(describeConflict(reason, owner, record));
    this.name = "AuthorityConflict";
    this.reason = reason;
    this.owner = owner;
    this.record = record;
  }
}

function describeConflict(
  reason: AuthorityConflictReason,
  owner: OwnerRecordV1 | null,
  record: HostConnectionRecordV1 | null,
): string {
  const who =
    owner === null
      ? ""
      : ` — pid ${owner.pid}, host ${owner.hostVersion} (${owner.flavor}), started ${new Date(owner.startedAtMs).toISOString()}`;
  switch (reason) {
    case "live host":
      return `another host answers at ${record?.endpoint ?? "its endpoint"}${who}`;
    case "owner alive":
      return `the lock owner is still running${who}; stop it before claiming this data root`;
    case "owner unverifiable":
      return `the lock owner could not be proven dead${who}; refusing to take over`;
    case "lost race":
      return `another claimant took the lock first${who}`;
  }
}

export interface HostLock {
  owner: OwnerRecordV1;
  /** Inode of our owner.json, which `host.lock` links to while we own it. */
  ino: number;
  /** `false` once `host.lock` names another inode or is gone: we are no longer the authority. */
  assertStillOwner(): boolean;
  /** Removes leftover `locks/host-*` dirs and `host.lock.stale-*` names whose recorded owner is proven dead. */
  sweepStale(): void;
  /**
   * Writes `releasedAtMs` into the owner record on the inode `host.lock` names
   * (truncate-and-rewrite, never a rename, so the hard link stays intact) and
   * lets a successor take the root over from this live pid.
   */
  release(atMs: number): void;
}

export type HostLockDeps = AuthorityDeps & {
  readHostRecord: (dataRoot: string) => HostConnectionRecordV1 | null;
};

export function lockPath(dataRoot: string): string {
  return path.join(dataRoot, "host.lock");
}

/** The current `host.lock` owner record; `null` when absent, unparseable, or from another schema. */
export function readOwnerRecord(dataRoot: string): OwnerRecordV1 | null {
  return parseOwnerFile(lockPath(dataRoot)) ?? null;
}

/** `undefined` when the file is absent, `null` when present but unparseable. */
function parseOwnerFile(file: string): OwnerRecordV1 | null | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    return null;
  }
  return parseOwnerText(text);
}

function parseOwnerText(text: string): OwnerRecordV1 | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isOwnerRecordV1(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface InspectedLock {
  /** The inode whose bytes `owner` was parsed from — the evidence a takeover must still be about. */
  ino: number;
  owner: OwnerRecordV1 | null;
}

/** Inode and content of `host.lock` read through ONE descriptor, so the two describe the same file. `undefined` when absent. */
function inspectLock(file: string): InspectedLock | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const ino = fs.fstatSync(fd).ino;
    let text: string;
    try {
      text = fs.readFileSync(fd, "utf8");
    } catch {
      return { ino, owner: null };
    }
    return { ino, owner: parseOwnerText(text) };
  } finally {
    fs.closeSync(fd);
  }
}

function isOwnerRecordV1(v: unknown): v is OwnerRecordV1 {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>; // shape checked field by field below
  return (
    r.schemaVersion === 1 &&
    typeof r.pid === "number" &&
    Number.isInteger(r.pid) &&
    typeof r.bootId === "string" &&
    typeof r.processStartMs === "number" &&
    Number.isFinite(r.processStartMs) &&
    typeof r.startedAtMs === "number" &&
    Number.isFinite(r.startedAtMs) &&
    typeof r.incarnation === "number" &&
    Number.isInteger(r.incarnation) &&
    typeof r.hostVersion === "string" &&
    typeof r.dataRoot === "string" &&
    (r.flavor === "installed" || r.flavor === "dev" || r.flavor === "dev-server") &&
    (r.releasedAtMs === undefined || (typeof r.releasedAtMs === "number" && Number.isFinite(r.releasedAtMs)))
  );
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Publishes this process as the owner of `dataRoot` or throws
 * `AuthorityConflict`. On contention the connection-record probe may veto
 * (a live host answered) but never authorises; takeover needs evidence that
 * nothing from the recorded owner can be running — its boot is over, or its
 * pid is dead on this boot. The single-winner step is creating
 * `host.lock.stale-<incarnation>` as a hard link to the inspected inode:
 * `link(2)` never replaces, so concurrent contenders get `EEXIST` and lose,
 * and a link that lands on a different inode means the lock changed hands
 * under us — also a loss. The winner then renames its owner.json OVER
 * `host.lock`, so the name never disappears and no live owner is displaced.
 */
export async function acquireHostLock(dataRoot: string, deps: HostLockDeps): Promise<HostLock> {
  const lockFile = lockPath(dataRoot);
  const locksDir = path.join(dataRoot, "locks");
  const ownDir = path.join(locksDir, `host-${randomBytes(8).toString("hex")}`);
  const ownerFile = path.join(ownDir, "owner.json");
  const bootId = deps.bootId();
  fs.mkdirSync(ownDir, { recursive: true, mode: 0o700 });

  const previous = parseOwnerFile(lockFile) ?? null;
  const owner: OwnerRecordV1 = {
    schemaVersion: 1,
    pid: deps.pid ?? process.pid,
    bootId,
    processStartMs: deps.processStartMs ?? Math.round((deps.now() - process.uptime() * 1000) / 1000) * 1000,
    startedAtMs: deps.now(),
    incarnation: (previous?.incarnation ?? 0) + 1,
    hostVersion: deps.hostVersion,
    dataRoot,
    flavor: deps.flavor,
  };
  writeTextDurably(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, 0o600);

  if (tryLink(ownerFile, lockFile) === "linked") {
    deps.breadcrumbs.record("authority", { detail: `claim incarnation=${owner.incarnation} pid=${owner.pid}` });
  } else {
    const record = deps.readHostRecord(dataRoot);
    if (record !== null && (await deps.probe(record))) {
      const current = parseOwnerFile(lockFile) ?? null;
      deps.breadcrumbs.record("authority", { detail: `conflict live host pid=${current?.pid ?? "?"} endpoint=${record.endpoint}` });
      throw new AuthorityConflict("live host", current, record);
    }
    const lostRace = (): AuthorityConflict => {
      const winner = parseOwnerFile(lockFile) ?? null;
      deps.breadcrumbs.record("authority", { detail: `conflict lost race pid=${winner?.pid ?? "?"}` });
      return new AuthorityConflict("lost race", winner, record);
    };
    const inspected = inspectLock(lockFile);
    let takeoverReason: string;
    if (inspected === undefined) {
      // The name vanished between our link and this read; the link below settles who owns it now.
      takeoverReason = "vacated";
    } else if (inspected.owner === null) {
      takeoverReason = "unparseable owner";
    } else if (!sameBoot(inspected.owner.bootId, bootId)) {
      takeoverReason = `other boot pid=${inspected.owner.pid} incarnation=${inspected.owner.incarnation}`;
    } else if (inspected.owner.releasedAtMs !== undefined) {
      takeoverReason = `released pid=${inspected.owner.pid} incarnation=${inspected.owner.incarnation}`;
    } else {
      const { pid, processStartMs, incarnation } = inspected.owner;
      const liveness = deps.processAlive(pid, processStartMs);
      if (liveness !== "dead") {
        const reason = liveness === "alive" ? "owner alive" : "owner unverifiable";
        deps.breadcrumbs.record("authority", { detail: `conflict ${reason} pid=${pid} incarnation=${incarnation}` });
        throw new AuthorityConflict(reason, inspected.owner, record);
      }
      takeoverReason = `dead pid=${pid} incarnation=${incarnation}`;
    }
    if (inspected?.owner && inspected.owner.incarnation >= owner.incarnation) {
      owner.incarnation = inspected.owner.incarnation + 1;
      writeTextDurably(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, 0o600);
    }
    if (inspected === undefined) {
      if (tryLink(ownerFile, lockFile) !== "linked") throw lostRace();
    } else {
      const staleName = `${lockFile}.stale-${owner.incarnation}`;
      const aside = tryLink(lockFile, staleName);
      if (aside === "exists") throw lostRace();
      if (aside === "missing") {
        if (tryLink(ownerFile, lockFile) !== "linked") throw lostRace();
      } else {
        if (fs.statSync(staleName).ino !== inspected.ino) {
          // host.lock changed hands after we inspected it; the extra name is theirs to lose.
          fs.rmSync(staleName, { force: true });
          throw lostRace();
        }
        fs.renameSync(ownerFile, lockFile);
        fs.linkSync(lockFile, ownerFile);
      }
    }
    deps.breadcrumbs.record("authority", { detail: `takeover ${takeoverReason} → incarnation=${owner.incarnation} pid=${owner.pid}` });
  }

  const ino = fs.statSync(ownerFile).ino;
  return {
    owner,
    ino,
    assertStillOwner() {
      try {
        return fs.statSync(lockFile).ino === ino;
      } catch {
        return false;
      }
    },
    release(atMs) {
      owner.releasedAtMs = atMs;
      // In place: a temp+rename would give owner.json a new inode and leave host.lock naming the old bytes.
      const fd = fs.openSync(ownerFile, "r+");
      try {
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, `${JSON.stringify(owner, null, 2)}\n`, 0, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    sweepStale() {
      const provenDead = (record: OwnerRecordV1 | null | undefined): boolean =>
        record !== null &&
        record !== undefined &&
        (!sameBoot(record.bootId, bootId) ||
          record.releasedAtMs !== undefined ||
          deps.processAlive(record.pid, record.processStartMs) === "dead");
      let names: string[];
      try {
        names = fs.readdirSync(locksDir);
      } catch {
        return;
      }
      for (const name of names) {
        const dir = path.join(locksDir, name);
        if (dir === ownDir || !name.startsWith("host-")) continue;
        if (!provenDead(parseOwnerFile(path.join(dir, "owner.json")))) continue;
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          deps.breadcrumbs.record("authority", { detail: `swept locks/${name}` });
        } catch (error) {
          deps.breadcrumbs.record("authority", { detail: `sweep failed locks/${name}: ${String(error)}` });
        }
      }
      let rootNames: string[];
      try {
        rootNames = fs.readdirSync(dataRoot);
      } catch {
        return;
      }
      for (const name of rootNames) {
        if (!name.startsWith("host.lock.stale-")) continue;
        const stale = path.join(dataRoot, name);
        if (!provenDead(parseOwnerFile(stale))) continue;
        try {
          fs.rmSync(stale, { force: true });
          deps.breadcrumbs.record("authority", { detail: `swept ${name}` });
        } catch (error) {
          deps.breadcrumbs.record("authority", { detail: `sweep failed ${name}: ${String(error)}` });
        }
      }
    },
  };
}

/** `exists` on `EEXIST` (the name is taken), `missing` on `ENOENT` (`from` is gone). Any other error propagates. */
function tryLink(from: string, to: string): "linked" | "exists" | "missing" {
  try {
    fs.linkSync(from, to);
    return "linked";
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") return "exists";
    if (code === "ENOENT") return "missing";
    throw error;
  }
}
