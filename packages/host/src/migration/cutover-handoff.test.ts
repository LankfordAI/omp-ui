import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CUTOVER_HANDOFF_MAX_AGE_MS,
  cutoverHandoffPath,
  writeCutoverHandoff,
  type BreadcrumbEntry,
  type BreadcrumbSink,
  type CutoverHandoffV1,
} from "@omp-ui/core";
import { consumeCutoverHandoff, type ConsumeCutoverDeps } from "./cutover-handoff";

const dirs: string[] = [];

function dataRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cutover-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface RecordingSink extends BreadcrumbSink {
  details: string[];
}

function recording(): RecordingSink {
  const entries: BreadcrumbEntry[] = [];
  return {
    details: [],
    record(kind, fields) {
      entries.push({ at: "", seq: entries.length, kind, ...fields });
      this.details.push(`${kind}: ${fields?.detail ?? ""}`);
    },
    entries: () => entries,
  };
}

const NOW = 1_700_000_000_000;

function record(root: string, overrides: Partial<CutoverHandoffV1> = {}): CutoverHandoffV1 {
  return {
    schemaVersion: 1,
    pid: 4242,
    processStartMs: NOW - 60_000,
    legacyUserData: "/home/u/.config/@omp-ui/desktop",
    targetDataRoot: root,
    nonce: "abcdefgh12345678",
    createdAtMs: NOW - 5_000,
    ...overrides,
  };
}

type TestDeps = ConsumeCutoverDeps & { breadcrumbs: RecordingSink };

function deps(overrides: Partial<Omit<ConsumeCutoverDeps, "breadcrumbs">> = {}): TestDeps {
  return {
    now: () => NOW,
    processAlive: () => "alive",
    readlink: () => "myhost-4242",
    platform: "linux",
    breadcrumbs: recording(),
    ...overrides,
  };
}

describe("consumeCutoverHandoff", () => {
  it("returns null quietly when there is no handoff file", () => {
    const d = deps();
    expect(consumeCutoverHandoff(dataRoot(), d)).toBeNull();
    expect(d.breadcrumbs.details).toEqual([]);
  });

  it("accepts a fresh record from the live lock holder and renames it consumed", () => {
    const root = dataRoot();
    const written = record(root);
    writeCutoverHandoff(written);
    expect(fs.statSync(cutoverHandoffPath(root)).mode & 0o777).toBe(0o600);

    const seen: Array<[number, number]> = [];
    const links: string[] = [];
    const d = deps({
      processAlive: (pid, startMs) => {
        seen.push([pid, startMs]);
        return "alive";
      },
      readlink: (p) => {
        links.push(p);
        return "myhost-4242";
      },
    });
    expect(consumeCutoverHandoff(root, d)).toEqual(written);
    expect(seen).toEqual([[4242, NOW - 60_000]]);
    expect(links).toEqual([path.join(written.legacyUserData, "SingletonLock")]);
    expect(fs.existsSync(cutoverHandoffPath(root))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, "cutover-handoff.consumed-abcdefgh12345678.json"), "utf8"))).toEqual(written);
    expect(d.breadcrumbs.details).toEqual([`authority: cutover handoff accepted from pid 4242 for ${written.legacyUserData}`]);
  });

  function rejects(root: string, d: TestDeps, reason: RegExp): void {
    expect(consumeCutoverHandoff(root, d)).toBeNull();
    expect(fs.existsSync(cutoverHandoffPath(root))).toBe(true);
    expect(d.breadcrumbs.details).toHaveLength(1);
    expect(d.breadcrumbs.details[0]).toMatch(/^authority: cutover handoff rejected: /);
    expect(d.breadcrumbs.details[0]).toMatch(reason);
  }

  it("rejects a record aimed at a different data root", () => {
    const root = dataRoot();
    fs.writeFileSync(cutoverHandoffPath(root), JSON.stringify(record(root, { targetDataRoot: path.join(root, "other") })));
    rejects(root, deps(), /targets/);
  });

  it("rejects a stale or future-dated record", () => {
    const root = dataRoot();
    writeCutoverHandoff(record(root, { createdAtMs: NOW - CUTOVER_HANDOFF_MAX_AGE_MS }));
    rejects(root, deps(), /written 600000ms ago/);
    writeCutoverHandoff(record(root, { createdAtMs: NOW + 1 }));
    rejects(root, deps(), /written -1ms ago/);
    writeCutoverHandoff(record(root, { createdAtMs: NOW - CUTOVER_HANDOFF_MAX_AGE_MS + 1 }));
    expect(consumeCutoverHandoff(root, deps())).not.toBeNull();
  });

  it("rejects when the writer is dead or unverifiable", () => {
    const root = dataRoot();
    writeCutoverHandoff(record(root));
    rejects(root, deps({ processAlive: () => "dead" }), /pid 4242 is dead/);
    rejects(root, deps({ processAlive: () => "unverifiable" }), /unverifiable/);
  });

  it("rejects when the SingletonLock names another pid, is missing, or is malformed", () => {
    const root = dataRoot();
    writeCutoverHandoff(record(root));
    rejects(root, deps({ readlink: () => "myhost-999" }), /held by myhost-999, not pid 4242/);
    rejects(
      root,
      deps({
        readlink: () => {
          throw new Error("ENOENT: no such file");
        },
      }),
      /SingletonLock unreadable/,
    );
    rejects(root, deps({ readlink: () => "nodash" }), /held by nodash/);
    // Hostnames with dashes still resolve by the trailing pid.
    expect(consumeCutoverHandoff(root, deps({ readlink: () => "my-host-name-4242" }))).not.toBeNull();
  });

  it("on Windows the lock is held when the file cannot be opened exclusively", () => {
    const root = dataRoot();
    writeCutoverHandoff(record(root));
    const probed: string[] = [];
    rejects(
      root,
      deps({
        platform: "win32",
        canOpenExclusive: (p) => {
          probed.push(p);
          return true;
        },
        readlink: () => {
          throw new Error("readlink must not run on win32");
        },
      }),
      /not held/,
    );
    expect(probed).toEqual([path.join(record(root).legacyUserData, "SingletonLock")]);
    expect(consumeCutoverHandoff(root, deps({ platform: "win32", canOpenExclusive: () => false }))).not.toBeNull();
  });

  it("rejects malformed records and unsafe nonces without deleting them", () => {
    const root = dataRoot();
    fs.writeFileSync(cutoverHandoffPath(root), "{ nope");
    rejects(root, deps(), /unreadable/);
    fs.writeFileSync(cutoverHandoffPath(root), JSON.stringify({ ...record(root), schemaVersion: 2 }));
    rejects(root, deps(), /malformed/);
    fs.writeFileSync(cutoverHandoffPath(root), JSON.stringify({ ...record(root), nonce: "../escape" }));
    rejects(root, deps(), /malformed/);
    fs.writeFileSync(cutoverHandoffPath(root), JSON.stringify({ ...record(root), pid: 0 }));
    rejects(root, deps(), /malformed/);
    expect(() => writeCutoverHandoff(record(root, { nonce: "../escape" }))).toThrow(/filename-safe/);
  });
});
