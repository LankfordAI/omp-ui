import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeTextDurably, type BreadcrumbSink } from "@omp-ui/core";
import { sameBoot, type ProcessLiveness } from "./process-identity";

/**
 * The children ledger (issue #442 §10.1; #450 "exactly one resumer after a
 * crash"). The lock stops two hosts; it does not stop an `omp` child a killed
 * host left writing into a lineage dir. Every spawn lands here durably before
 * the spawn is reported, every reap removes it, and the next authority
 * reconciles the ledger BEFORE it loads the registry: children of another boot
 * died with it, dead pids are dropped, live ones are terminated and awaited,
 * and anything it cannot prove dead stops the boot by name. Never "assume
 * dead", never resume beside it.
 */
export interface ChildEntry {
  pid: number;
  /** Process group at spawn; `0` when the platform has none (Windows). */
  pgid: number;
  bootId: string;
  procStartMs: number;
  executable: string;
  kind: "pty" | "rpc-ui" | "shell";
  tabId: string;
  lineageDir: string;
}

interface LedgerFileV1 {
  schemaVersion: 1;
  entries: ChildEntry[];
}

/** Children that outlived SIGKILL or could not be verified; the authority path stops here. */
export class LedgerUnresolved extends Error {
  readonly pids: number[];

  constructor(pids: number[]) {
    super(`children from the previous host could not be proven dead: pid ${pids.join(", ")}`);
    this.name = "LedgerUnresolved";
    this.pids = pids;
  }
}

export interface ChildrenLedgerDeps {
  bootId(): string;
  processAlive(pid: number, startMs: number): ProcessLiveness;
  now(): number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  breadcrumbs: BreadcrumbSink;
}

const TERM_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;

export function ledgerPath(dataRoot: string): string {
  return path.join(dataRoot, "runtime", "children.json");
}

export class ChildrenLedger {
  private readonly file: string;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private list: ChildEntry[];

  /** Throws when an existing ledger is unreadable: a boot that cannot read its children must not proceed to resume beside them. */
  constructor(
    dataRoot: string,
    private readonly deps: ChildrenLedgerDeps,
  ) {
    this.file = ledgerPath(dataRoot);
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.sleep = deps.sleep ?? ((ms) => delay(ms));
    this.list = readLedger(this.file);
  }

  entries(): readonly ChildEntry[] {
    return this.list;
  }

  /** The boot id every entry this host adds carries — the same one `reconcileBeforeLoad` compares against. */
  bootId(): string {
    return this.deps.bootId();
  }

  /** Durable before returning; an existing entry for the pid is replaced. */
  add(entry: ChildEntry): void {
    this.list = [...this.list.filter((e) => e.pid !== entry.pid), entry];
    this.persist();
  }

  remove(pid: number): void {
    const kept = this.list.filter((e) => e.pid !== pid);
    if (kept.length === this.list.length) return;
    this.list = kept;
    this.persist();
  }

  /**
   * Terminates every child of the previous host that is still running and
   * drops those that are not. Entries the platform cannot classify, and
   * children that survive SIGTERM → 3 s → SIGKILL → 2 s, stay in the ledger
   * and are reported through `LedgerUnresolved`.
   */
  async reconcileBeforeLoad(): Promise<void> {
    const bootId = this.deps.bootId();
    const live: ChildEntry[] = [];
    const unresolved: ChildEntry[] = [];
    for (const entry of this.list) {
      if (!sameBoot(entry.bootId, bootId)) {
        this.crumb(entry, "dropped: other boot");
        continue;
      }
      const liveness = this.deps.processAlive(entry.pid, entry.procStartMs);
      if (liveness === "dead") {
        this.crumb(entry, "dropped: dead");
      } else if (liveness === "alive") {
        live.push(entry);
      } else {
        this.crumb(entry, "unverifiable");
        unresolved.push(entry);
      }
    }
    if (live.length > 0) {
      const startedAt = this.deps.now();
      for (const entry of live) this.signal(entry, "SIGTERM");
      await this.sleep(TERM_GRACE_MS);
      const afterTerm = live.filter((entry) => this.stillThere(entry, "after SIGTERM"));
      if (afterTerm.length > 0) {
        for (const entry of afterTerm) this.signal(entry, "SIGKILL");
        await this.sleep(KILL_GRACE_MS);
        for (const entry of afterTerm) {
          if (this.stillThere(entry, `after SIGKILL (${this.deps.now() - startedAt} ms)`)) unresolved.push(entry);
        }
      }
    }
    this.list = unresolved;
    this.persist();
    if (unresolved.length > 0) throw new LedgerUnresolved(unresolved.map((e) => e.pid));
  }

  /** Group kill on the recorded pgid unless that group is ours (a reused pid would make it so), else the pid alone. */
  private signal(entry: ChildEntry, signal: NodeJS.Signals): void {
    const target = entry.pgid > 0 && entry.pgid !== process.pid ? -entry.pgid : entry.pid;
    try {
      this.kill(target, signal);
      this.crumb(entry, `${signal} → ${target}`);
    } catch (error) {
      // ESRCH: gone between the check and the signal; EPERM: not ours to signal — the re-check decides.
      this.crumb(entry, `${signal} → ${target} failed: ${String(error)}`);
    }
  }

  /** `true` unless the child is now proven dead; an `unverifiable` answer counts as still there. */
  private stillThere(entry: ChildEntry, phase: string): boolean {
    const liveness = this.deps.processAlive(entry.pid, entry.procStartMs);
    if (liveness === "dead") {
      this.crumb(entry, `exited ${phase}`);
      return false;
    }
    this.crumb(entry, `${liveness} ${phase}`);
    return true;
  }

  private crumb(entry: ChildEntry, detail: string): void {
    this.deps.breadcrumbs.record("authority", { tabId: entry.tabId, detail: `ledger ${entry.kind} pid=${entry.pid}: ${detail}` });
  }

  private persist(): void {
    const doc: LedgerFileV1 = { schemaVersion: 1, entries: this.list };
    writeTextDurably(this.file, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
  }
}

function readLedger(file: string): ChildEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`children ledger ${file} is not JSON`, { cause: error });
  }
  if (!isLedgerFileV1(parsed)) throw new Error(`children ledger ${file} has an unknown shape or schema version`);
  return parsed.entries;
}

function isLedgerFileV1(v: unknown): v is LedgerFileV1 {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>; // shape checked field by field below
  return r.schemaVersion === 1 && Array.isArray(r.entries) && r.entries.every(isChildEntry);
}

function isChildEntry(v: unknown): v is ChildEntry {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>; // shape checked field by field below
  return (
    typeof r.pid === "number" &&
    Number.isInteger(r.pid) &&
    typeof r.pgid === "number" &&
    Number.isInteger(r.pgid) &&
    typeof r.bootId === "string" &&
    typeof r.procStartMs === "number" &&
    Number.isFinite(r.procStartMs) &&
    typeof r.executable === "string" &&
    (r.kind === "pty" || r.kind === "rpc-ui" || r.kind === "shell") &&
    typeof r.tabId === "string" &&
    typeof r.lineageDir === "string"
  );
}
