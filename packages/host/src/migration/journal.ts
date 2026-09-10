import * as fs from "node:fs";
import * as path from "node:path";
import { writeTextDurably } from "@omp-ui/core";

/**
 * Crash-safe record of the one-shot Electron → host migration (issue #442,
 * WP7 §10.2). Every step writes its evidence BEFORE it mutates the file
 * system, so a replay after a crash can tell "never started" from "moved but
 * unrecorded" by comparing the evidence against what is on disk. Every
 * mutation rewrites `<dataRoot>/migration.json` durably.
 */

export type JournalStepId = "relocate-authority-stores-v1" | "credential-handoff-v1";

export type ItemStatus = "pending" | "moved" | "verified" | "done" | "skipped";

/** What was known about one relocated item when the step touched it. */
export interface ItemEvidence {
  name: string;
  source: string;
  destination: string;
  /** Source stat at the time the item was first recorded — identity for dedupe. */
  mode: number;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  status: ItemStatus;
}

export interface JournalStep {
  id: JournalStepId;
  status: "open" | "committed";
  items: ItemEvidence[];
  startedAtMs: number;
  committedAtMs: number | null;
}

interface JournalFile {
  schemaVersion: 1;
  steps: JournalStep[];
}

const STEP_IDS: readonly string[] = ["relocate-authority-stores-v1", "credential-handoff-v1"];
const ITEM_STATUSES: readonly string[] = ["pending", "moved", "verified", "done", "skipped"];

/**
 * The migration cannot proceed without a human: the journal is unreadable, a
 * step is used out of order, or the file system disagrees with the evidence.
 */
export class MigrationConflict extends Error {
  override readonly name = "MigrationConflict";
}

export function migrationJournalPath(dataRoot: string): string {
  return path.join(dataRoot, "migration.json");
}

function isEvidence(value: unknown): value is ItemEvidence {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.source === "string" &&
    typeof v.destination === "string" &&
    typeof v.mode === "number" &&
    typeof v.size === "number" &&
    typeof v.mtimeMs === "number" &&
    typeof v.dev === "number" &&
    typeof v.ino === "number" &&
    typeof v.status === "string" &&
    ITEM_STATUSES.includes(v.status)
  );
}

function isStep(value: unknown): value is JournalStep {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    STEP_IDS.includes(v.id) &&
    (v.status === "open" || v.status === "committed") &&
    Array.isArray(v.items) &&
    v.items.every(isEvidence) &&
    typeof v.startedAtMs === "number" &&
    (v.committedAtMs === null || typeof v.committedAtMs === "number")
  );
}

function parseJournal(file: string): JournalFile {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, steps: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MigrationConflict(`migration journal ${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new MigrationConflict(`migration journal ${file} is not an object`);
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== 1) {
    throw new MigrationConflict(
      `migration journal ${file} has unknown schemaVersion ${JSON.stringify(raw.schemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.steps) || !raw.steps.every(isStep)) {
    throw new MigrationConflict(`migration journal ${file} has malformed steps`);
  }
  return { schemaVersion: 1, steps: raw.steps };
}

export class MigrationJournal {
  private constructor(
    private readonly file: string,
    private readonly data: JournalFile,
    private readonly now: () => number,
  ) {}

  static open(dataRoot: string, deps: { now: () => number }): MigrationJournal {
    const file = migrationJournalPath(dataRoot);
    return new MigrationJournal(file, parseJournal(file), deps.now);
  }

  /** A copy of the step's current state, or null when it was never begun. */
  step(id: JournalStepId): JournalStep | null {
    const found = this.data.steps.find((s) => s.id === id);
    return found ? structuredClone(found) : null;
  }

  /** Starts a step, or resumes it when a previous run left it open. */
  begin(id: JournalStepId): JournalStep {
    const existing = this.data.steps.find((s) => s.id === id);
    if (existing) {
      if (existing.status === "committed") {
        throw new MigrationConflict(`migration step ${id} is already committed`);
      }
      return structuredClone(existing);
    }
    const step: JournalStep = {
      id,
      status: "open",
      items: [],
      startedAtMs: this.now(),
      committedAtMs: null,
    };
    this.data.steps.push(step);
    this.save();
    return structuredClone(step);
  }

  /** Upserts one item's evidence (keyed by `name`) on an open step. */
  updateItem(id: JournalStepId, evidence: ItemEvidence): void {
    const step = this.openStep(id);
    const index = step.items.findIndex((item) => item.name === evidence.name);
    const stored = structuredClone(evidence);
    if (index === -1) step.items.push(stored);
    else step.items[index] = stored;
    this.save();
  }

  commit(id: JournalStepId): void {
    const step = this.openStep(id);
    step.status = "committed";
    step.committedAtMs = this.now();
    this.save();
  }

  private openStep(id: JournalStepId): JournalStep {
    const step = this.data.steps.find((s) => s.id === id);
    if (!step) throw new MigrationConflict(`migration step ${id} was never begun`);
    if (step.status === "committed") throw new MigrationConflict(`migration step ${id} is already committed`);
    return step;
  }

  private save(): void {
    writeTextDurably(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 0o600);
  }
}
