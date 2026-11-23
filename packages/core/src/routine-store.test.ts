import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoutineRecord, RoutineRunRow } from "./routine";
import { RoutineRunHistory, RoutineStore } from "./routine-store";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-ui-${name}-`));
  dirs.push(dir);
  return path.join(dir, `${name}.json`);
}

const VALID_ID = "AbCdEfGhIjKlMnOpQrStUv";

function record(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: VALID_ID,
    name: "Morning triage",
    instructions: "Summarize the inbox.",
    schedule: { kind: "cron", expr: "0 8 * * *" },
    timeZone: "UTC",
    destination: { projectCwd: "/repo", workspace: "worktree" },
    mode: "build",
    model: null,
    thinkingLevel: null,
    spend: { warnUsd: null, maxUsd: 5 },
    toolPolicy: {
      allow: ["read"],
      deny: [],
      lastReviewedAt: "2026-11-20T12:00:00.000Z",
      reviewedCatalog: ["read"],
    },
    scripts: { pre: "", post: "" },
    enabled: true,
    createdAt: "2026-11-20T12:00:00.000Z",
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastRunTabId: null,
    notices: [],
    ...overrides,
  };
}

function runRow(overrides: Partial<RoutineRunRow> = {}): RoutineRunRow {
  return {
    id: "run-1",
    routineId: VALID_ID,
    routineName: "Morning triage",
    firedAtMs: 1_700_000_000_000,
    scheduledForMs: null,
    trigger: "manual",
    outcome: "on-time",
    tabId: null,
    reasonCode: null,
    missed: 0,
    pruned: false,
    staleCatalog: false,
    ...overrides,
  };
}

describe("RoutineStore scripts normalization (#1283)", () => {
  it("keeps a legacy record without scripts, defaults it once, and round-trips it", () => {
    const file = tempFile("routines");
    const legacy = { ...record() } as Partial<RoutineRecord>;
    delete legacy.scripts;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, routines: [legacy] }), "utf8");

    const store = new RoutineStore(file);
    expect(store.get(VALID_ID)?.scripts).toEqual({ pre: "", post: "" });
    // The default was written back to disk exactly once.
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { routines: Array<Record<string, unknown>> };
    expect(onDisk.routines[0]!.scripts).toEqual({ pre: "", post: "" });

    const reloaded = new RoutineStore(file);
    expect(reloaded.get(VALID_ID)?.scripts).toEqual({ pre: "", post: "" });
  });

  it("preserves configured hooks across save/load", () => {
    const file = tempFile("routines");
    const store = new RoutineStore(file);
    store.add(record({ scripts: { pre: "git fetch --all", post: "echo done" } }));
    const reloaded = new RoutineStore(file);
    expect(reloaded.get(VALID_ID)?.scripts).toEqual({ pre: "git fetch --all", post: "echo done" });
  });

  it("drops a record whose scripts key is present but malformed instead of half-repairing", () => {
    const file = tempFile("routines");
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        routines: [
          { ...record(), id: VALID_ID },
          { ...record({ id: "b".repeat(22) } as RoutineRecord), scripts: null },
          { ...record({ id: "c".repeat(22) } as RoutineRecord), scripts: { pre: null, post: "" } },
        ],
      }),
      "utf8",
    );
    const store = new RoutineStore(file);
    expect(store.list().map((r) => r.id)).toEqual([VALID_ID]);
  });
});

describe("RoutineRunHistory postScript round trip (#1283)", () => {
  it("keeps a row without postScript untouched (no null rewrite)", () => {
    const file = tempFile("routine-runs");
    const history = new RoutineRunHistory(file);
    history.record(runRow());
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { runs: Array<Record<string, unknown>> };
    expect("postScript" in onDisk.runs[0]!).toBe(false);

    const reloaded = new RoutineRunHistory(file);
    expect(reloaded.list()[0]).toEqual(runRow());
  });

  it("round-trips postScript statuses and the new pre-script reason codes", () => {
    const file = tempFile("routine-runs");
    const history = new RoutineRunHistory(file);
    history.record(runRow({ id: "r1", outcome: "failed", reasonCode: "pre-script" }));
    history.record(runRow({ id: "r2", outcome: "skipped", reasonCode: "pre-script-skip" }));
    history.record(runRow({ id: "r3", postScript: "ok" }));
    history.record(runRow({ id: "r4", postScript: "interrupted" }));

    const reloaded = new RoutineRunHistory(file);
    const byId = new Map(reloaded.list().map((r) => [r.id, r]));
    expect(byId.get("r1")).toMatchObject({ outcome: "failed", reasonCode: "pre-script" });
    expect(byId.get("r2")).toMatchObject({ outcome: "skipped", reasonCode: "pre-script-skip" });
    expect(byId.get("r3")?.postScript).toBe("ok");
    expect(byId.get("r4")?.postScript).toBe("interrupted");
  });

  it("drops a row with a bogus postScript value on load", () => {
    const file = tempFile("routine-runs");
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        runs: [runRow(), { ...runRow({ id: "bad" }), postScript: "ran fine" }],
      }),
      "utf8",
    );
    const history = new RoutineRunHistory(file);
    expect(history.list().map((r) => r.id)).toEqual(["run-1"]);
  });
});
