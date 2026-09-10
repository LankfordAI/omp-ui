import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BreadcrumbEntry, BreadcrumbSink } from "@omp-ui/core";
import { ChildrenLedger, LedgerUnresolved, ledgerPath, type ChildEntry, type ChildrenLedgerDeps } from "./children-ledger";
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

interface Harness {
  deps: ChildrenLedgerDeps;
  sink: RecordingSink;
  /** Current liveness per pid; the fake `kill` mutates it per `dies`. */
  liveness: Record<number, ProcessLiveness>;
  /** Which signal (if any) ends a pid. */
  dies: Record<number, NodeJS.Signals>;
  kills: Array<[number, NodeJS.Signals]>;
  sleeps: number[];
}

function harness(): Harness {
  const sink = crumbs();
  const liveness: Record<number, ProcessLiveness> = {};
  const dies: Record<number, NodeJS.Signals> = {};
  const kills: Array<[number, NodeJS.Signals]> = [];
  const sleeps: number[] = [];
  let clock = 1_000;
  const deps: ChildrenLedgerDeps = {
    bootId: () => "boot-A",
    processAlive: (pid) => liveness[pid] ?? "dead",
    now: () => clock,
    kill: (target, signal) => {
      kills.push([target, signal]);
      for (const [pid, endsWith] of Object.entries(dies)) {
        const p = Number(pid);
        const entry = entries.find((e) => e.pid === p);
        const hit = target === p || (entry !== undefined && target === -entry.pgid);
        if (hit && endsWith === signal) liveness[p] = "dead";
      }
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    breadcrumbs: sink,
  };
  return { deps, sink, liveness, dies, kills, sleeps };
}

const entries: ChildEntry[] = [];

function entry(pid: number, over: Partial<ChildEntry> = {}): ChildEntry {
  const e: ChildEntry = {
    pid,
    pgid: pid,
    bootId: "boot-A",
    procStartMs: 500_000 + pid,
    executable: "/usr/bin/omp",
    kind: "rpc-ui",
    tabId: `tab-${pid}`,
    lineageDir: `/lineage/${pid}`,
    ...over,
  };
  entries.push(e);
  return e;
}

function fileEntries(root: string): ChildEntry[] {
  const doc = JSON.parse(fs.readFileSync(ledgerPath(root), "utf8")) as { schemaVersion: number; entries: ChildEntry[] };
  expect(doc.schemaVersion).toBe(1);
  return doc.entries;
}

describe("ChildrenLedger", () => {
  let root: string;

  beforeEach(() => {
    entries.length = 0;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-children-ledger-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes every add and remove to runtime/children.json before returning, mode 0600", () => {
    const h = harness();
    const ledger = new ChildrenLedger(root, h.deps);
    expect(fs.existsSync(ledgerPath(root))).toBe(false);
    const a = entry(10, { kind: "pty" });
    const b = entry(11);
    ledger.add(a);
    expect(fileEntries(root)).toEqual([a]);
    if (process.platform !== "win32") expect(fs.statSync(ledgerPath(root)).mode & 0o777).toBe(0o600);
    ledger.add(b);
    ledger.add({ ...a, tabId: "tab-renamed" });
    expect(fileEntries(root)).toEqual([b, { ...a, tabId: "tab-renamed" }]);
    ledger.remove(11);
    expect(fileEntries(root)).toEqual([{ ...a, tabId: "tab-renamed" }]);
    expect(ledger.entries()).toEqual([{ ...a, tabId: "tab-renamed" }]);

    const reopened = new ChildrenLedger(root, h.deps);
    expect(reopened.entries()).toEqual([{ ...a, tabId: "tab-renamed" }]);
  });

  it("refuses to open a ledger it cannot read rather than start empty beside unknown children", () => {
    fs.mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
    fs.writeFileSync(ledgerPath(root), "{ not json");
    expect(() => new ChildrenLedger(root, harness().deps)).toThrow(/not JSON/);
    fs.writeFileSync(ledgerPath(root), JSON.stringify({ schemaVersion: 2, entries: [] }));
    expect(() => new ChildrenLedger(root, harness().deps)).toThrow(/schema version/);
  });

  it("reconcile drops children of another boot and dead pids without signalling anything", async () => {
    const h = harness();
    const ledger = new ChildrenLedger(root, h.deps);
    ledger.add(entry(20, { bootId: "boot-OLD" }));
    ledger.add(entry(21));
    h.liveness[20] = "alive"; // a reused pid on this boot: still not ours, other boot wins.
    await ledger.reconcileBeforeLoad();
    expect(ledger.entries()).toEqual([]);
    expect(fileEntries(root)).toEqual([]);
    expect(h.kills).toEqual([]);
    expect(h.sleeps).toEqual([]);
    expect(h.sink.details()).toEqual([
      "ledger rpc-ui pid=20: dropped: other boot",
      "ledger rpc-ui pid=21: dropped: dead",
    ]);
  });

  it("escalates SIGTERM → 3 s → SIGKILL → 2 s, group-killing recorded groups and pid-killing the rest", async () => {
    const h = harness();
    const ledger = new ChildrenLedger(root, h.deps);
    const termable = entry(30, { pgid: 30, kind: "pty" });
    const stubborn = entry(31, { pgid: 31 });
    const noGroup = entry(32, { pgid: 0, kind: "shell" });
    const ourGroup = entry(33, { pgid: process.pid });
    for (const e of [termable, stubborn, noGroup, ourGroup]) {
      ledger.add(e);
      h.liveness[e.pid] = "alive";
    }
    h.dies[30] = "SIGTERM";
    h.dies[31] = "SIGKILL";
    h.dies[32] = "SIGTERM";
    h.dies[33] = "SIGKILL";

    await ledger.reconcileBeforeLoad();

    expect(h.kills).toEqual([
      [-30, "SIGTERM"],
      [-31, "SIGTERM"],
      [32, "SIGTERM"],
      [33, "SIGTERM"],
      [-31, "SIGKILL"],
      [33, "SIGKILL"],
    ]);
    expect(h.sleeps).toEqual([3_000, 2_000]);
    expect(ledger.entries()).toEqual([]);
    expect(fileEntries(root)).toEqual([]);
    expect(h.sink.details()).toContain("ledger pty pid=30: exited after SIGTERM");
    expect(h.sink.details()).toContain("ledger rpc-ui pid=31: alive after SIGTERM");
    expect(h.sink.details()).toContain("ledger rpc-ui pid=31: exited after SIGKILL (5000 ms)");
  });

  it("throws LedgerUnresolved naming undying and unverifiable children, and keeps them in the ledger", async () => {
    const h = harness();
    const kill = h.deps.kill!;
    h.deps.kill = (target, signal) => {
      if (target === -43) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      kill(target, signal);
    };
    const ledger = new ChildrenLedger(root, h.deps);
    const immortal = entry(40);
    const unverifiable = entry(41);
    const fine = entry(42);
    const unkillable = entry(43);
    for (const e of [immortal, unverifiable, fine, unkillable]) ledger.add(e);
    h.liveness[40] = "alive";
    h.liveness[41] = "unverifiable";
    h.liveness[42] = "alive";
    h.liveness[43] = "alive";
    h.dies[42] = "SIGTERM";

    const error = await ledger.reconcileBeforeLoad().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerUnresolved);
    expect((error as LedgerUnresolved).pids).toEqual([41, 40, 43]);
    expect((error as LedgerUnresolved).message).toContain("40, 43");
    expect(ledger.entries().map((e) => e.pid)).toEqual([41, 40, 43]);
    expect(fileEntries(root).map((e) => e.pid)).toEqual([41, 40, 43]);
    expect(h.sleeps).toEqual([3_000, 2_000]);
    expect(h.sink.details()).toContain("ledger rpc-ui pid=41: unverifiable");
    expect(h.sink.details().some((d) => d.startsWith("ledger rpc-ui pid=43: SIGTERM → -43 failed"))).toBe(true);
    expect(h.sink.details()).toContain("ledger rpc-ui pid=40: alive after SIGKILL (5000 ms)");
  });

  it("a child that turns unverifiable after SIGTERM is unresolved, never assumed dead", async () => {
    const h = harness();
    h.deps.kill = () => {
      h.liveness[50] = "unverifiable";
    };
    const ledger = new ChildrenLedger(root, h.deps);
    ledger.add(entry(50));
    h.liveness[50] = "alive";
    await expect(ledger.reconcileBeforeLoad()).rejects.toMatchObject({ pids: [50] });
    expect(h.sleeps).toEqual([3_000, 2_000]);
    expect(h.sink.details()).toContain("ledger rpc-ui pid=50: unverifiable after SIGTERM");
  });
});
