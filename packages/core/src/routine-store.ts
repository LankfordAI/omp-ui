import * as fs from "node:fs";
import { writeTextAtomic } from "./atomic-write";
import {
  isRoutineRecord,
  isRoutineRunRow,
  type RoutineRecord,
  type RoutineRunRow,
} from "./routine";

interface RoutinesFile {
  schemaVersion: 1;
  routines: RoutineRecord[];
}

interface RoutineRunsFile {
  schemaVersion: 1;
  runs: RoutineRunRow[];
}

export type RoutineSchedulePatch = Partial<
  Pick<RoutineRecord, "nextRunAtMs" | "lastRunAtMs" | "lastRunTabId" | "notices">
>;

export class RoutineStore {
  private readonly records: RoutineRecord[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const routines = (parsed as Partial<RoutinesFile> | null)?.routines;
    if (!Array.isArray(routines)) return;
    const seen = new Set<string>();
    let mutated = false;
    for (const raw of routines) {
      if (!isRoutineRecord(raw)) continue;
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      const record = structuredClone(raw);
      // Legacy pre-#1283 record: default the hooks and write them back once,
      // so in-memory records always carry the required key. Checked through the
      // un-narrowed clone because the guard's type says the key is required.
      if (!("scripts" in (record as Partial<RoutineRecord>))) {
        record.scripts = { pre: "", post: "" };
        mutated = true;
      }
      this.records.push(record);
    }
    if (mutated) {
      this.save();
    }
  }

  private save(): void {
    const data: RoutinesFile = {
      schemaVersion: 1,
      routines: this.records,
    };
    writeTextAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
  }

  list(): RoutineRecord[] {
    return this.records.map((r) => structuredClone(r));
  }

  get(id: string): RoutineRecord | null {
    const found = this.records.find((r) => r.id === id);
    return found ? structuredClone(found) : null;
  }

  add(record: RoutineRecord): void {
    if (this.records.some((r) => r.id === record.id)) {
      throw new Error(`routine ${record.id} already exists`);
    }
    this.records.push(structuredClone(record));
    this.save();
  }

  update(id: string, patch: Partial<Omit<RoutineRecord, "id" | "createdAt">>): RoutineRecord {
    const index = this.records.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`unknown routine ${id}`);
    const next: RoutineRecord = structuredClone({ ...this.records[index]!, ...patch });
    this.records[index] = next;
    this.save();
    return structuredClone(next);
  }

  replaceScheduleState(id: string, patch: RoutineSchedulePatch): RoutineRecord {
    return this.update(id, patch);
  }

  remove(id: string): boolean {
    const index = this.records.findIndex((r) => r.id === id);
    if (index < 0) return false;
    this.records.splice(index, 1);
    this.save();
    return true;
  }
}

export class RoutineRunHistory {
  private readonly rows: RoutineRunRow[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const runs = (parsed as Partial<RoutineRunsFile> | null)?.runs;
    if (!Array.isArray(runs)) return;
    let mutated = false;
    const seen = new Set<string>();
    for (const raw of runs) {
      if (!isRoutineRunRow(raw)) continue;
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      const row = structuredClone(raw);
      if (row.outcome === "running" || row.outcome === "waiting-approval") {
        row.outcome = "failed";
        row.reasonCode = "interrupted";
        mutated = true;
      }
      this.rows.push(row);
    }
    if (mutated) {
      this.save();
    }
  }

  private save(): void {
    const data: RoutineRunsFile = {
      schemaVersion: 1,
      runs: this.rows,
    };
    writeTextAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
  }

  list(routineId?: string): RoutineRunRow[] {
    const filtered = routineId === undefined ? this.rows : this.rows.filter((r) => r.routineId === routineId);
    return filtered.map((r) => structuredClone(r));
  }

  record(row: RoutineRunRow): void {
    this.rows.unshift(structuredClone(row));
    this.save();
  }

  update(id: string, patch: Partial<Omit<RoutineRunRow, "id">>): RoutineRunRow | null {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index < 0) return null;
    const next: RoutineRunRow = structuredClone({ ...this.rows[index]!, ...patch });
    this.rows[index] = next;
    this.save();
    return structuredClone(next);
  }

  updateByTabId(tabId: string, patch: Partial<Omit<RoutineRunRow, "id">>): RoutineRunRow | null {
    const index = this.rows.findIndex((r) => r.tabId === tabId);
    if (index < 0) return null;
    const next: RoutineRunRow = structuredClone({ ...this.rows[index]!, ...patch });
    this.rows[index] = next;
    this.save();
    return structuredClone(next);
  }

  markPruned(tabId: string): boolean {
    const index = this.rows.findIndex((r) => r.tabId === tabId);
    if (index < 0) return false;
    if (this.rows[index]!.pruned) return false;
    this.rows[index]!.pruned = true;
    this.save();
    return true;
  }

  removeForRoutine(routineId: string): number {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]!.routineId === routineId) {
        this.rows.splice(i, 1);
      }
    }
    const removed = before - this.rows.length;
    if (removed > 0) this.save();
    return removed;
  }

  pruneOlderThan(cutoffMs: number): number {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]!.firedAtMs < cutoffMs) {
        this.rows.splice(i, 1);
      }
    }
    const removed = before - this.rows.length;
    if (removed > 0) this.save();
    return removed;
  }
}
