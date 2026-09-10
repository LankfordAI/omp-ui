import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationConflict, MigrationJournal, migrationJournalPath, type ItemEvidence } from "./journal";

const dirs: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-journal-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const evidence: ItemEvidence = {
  name: "registry.json",
  source: "/old/registry.json",
  destination: "/new/registry.json",
  mode: 0o100600,
  size: 12,
  mtimeMs: 1_000,
  dev: 1,
  ino: 2,
  status: "pending",
};

describe("MigrationJournal", () => {
  it("starts empty when no journal exists and persists every mutation", () => {
    const root = tmpRoot();
    let clock = 100;
    const journal = MigrationJournal.open(root, { now: () => clock });
    expect(journal.step("relocate-authority-stores-v1")).toBeNull();

    const step = journal.begin("relocate-authority-stores-v1");
    expect(step).toMatchObject({ status: "open", items: [], startedAtMs: 100, committedAtMs: null });
    journal.updateItem("relocate-authority-stores-v1", evidence);
    journal.updateItem("relocate-authority-stores-v1", { ...evidence, status: "done" });
    clock = 250;
    journal.commit("relocate-authority-stores-v1");

    const reopened = MigrationJournal.open(root, { now: () => 999 });
    expect(reopened.step("relocate-authority-stores-v1")).toEqual({
      id: "relocate-authority-stores-v1",
      status: "committed",
      items: [{ ...evidence, status: "done" }],
      startedAtMs: 100,
      committedAtMs: 250,
    });
    expect(fs.statSync(migrationJournalPath(root)).mode & 0o777).toBe(0o600);
  });

  it("resumes an open step across processes instead of restarting it", () => {
    const root = tmpRoot();
    const first = MigrationJournal.open(root, { now: () => 1 });
    first.begin("credential-handoff-v1");
    first.updateItem("credential-handoff-v1", evidence);

    const second = MigrationJournal.open(root, { now: () => 2 });
    expect(second.begin("credential-handoff-v1")).toMatchObject({ startedAtMs: 1, items: [evidence] });
  });

  it("refuses mutations on steps that were never begun or already committed", () => {
    const root = tmpRoot();
    const journal = MigrationJournal.open(root, { now: () => 1 });
    expect(() => journal.updateItem("credential-handoff-v1", evidence)).toThrow(MigrationConflict);
    expect(() => journal.commit("credential-handoff-v1")).toThrow(MigrationConflict);

    journal.begin("credential-handoff-v1");
    journal.commit("credential-handoff-v1");
    expect(() => journal.begin("credential-handoff-v1")).toThrow(MigrationConflict);
    expect(() => journal.updateItem("credential-handoff-v1", evidence)).toThrow(MigrationConflict);
    expect(() => journal.commit("credential-handoff-v1")).toThrow(MigrationConflict);
  });

  it("returns copies, so callers cannot mutate the journal behind its back", () => {
    const root = tmpRoot();
    const journal = MigrationJournal.open(root, { now: () => 1 });
    const step = journal.begin("credential-handoff-v1");
    step.items.push(evidence);
    expect(journal.step("credential-handoff-v1")?.items).toEqual([]);
  });

  it("throws MigrationConflict on an unknown schemaVersion or unreadable JSON", () => {
    const root = tmpRoot();
    fs.writeFileSync(migrationJournalPath(root), JSON.stringify({ schemaVersion: 2, steps: [] }));
    expect(() => MigrationJournal.open(root, { now: () => 1 })).toThrow(MigrationConflict);

    fs.writeFileSync(migrationJournalPath(root), "{ not json");
    expect(() => MigrationJournal.open(root, { now: () => 1 })).toThrow(MigrationConflict);

    fs.writeFileSync(migrationJournalPath(root), JSON.stringify({ schemaVersion: 1, steps: [{ id: "bogus" }] }));
    expect(() => MigrationJournal.open(root, { now: () => 1 })).toThrow(MigrationConflict);
  });
});
