import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROUTINE_INSTRUCTIONS_MAX,
  ROUTINE_NAME_MAX,
  isRoutineRecord,
  isRoutineRunRow,
  isSessionRoutine,
  parseRoutineAgentCreateArgs,
  parseRoutineFocusUri,
  parseRoutineInput,
  parseRoutinePatch,
  routineFocusUri,
  routineInputFromAgentCreate,
  routinePrompt,
  routineRunTitle,
  type RoutineInput,
  type RoutineRecord,
  type RoutineRunRow,
  type SessionRoutine,
} from "./routine";
import { RoutineRunHistory, RoutineStore } from "./routine-store";

const VALID_ID = "AbCdEfGhIjKlMnOpQrStUv";

function sampleInput(): RoutineInput {
  return {
    name: "  Morning triage  ",
    instructions: "Review open PRs and summarize blockers.",
    schedule: { kind: "cron", expr: "@daily" },
    timeZone: "America/New_York",
    destination: { projectCwd: "/home/dev/repo", workspace: "worktree" },
    mode: "plan",
    model: null,
    thinkingLevel: null,
    spend: { warnUsd: null, maxUsd: 5 },
    toolPolicy: {
      allow: ["read", "grep", "read"],
      deny: ["bash"],
      lastReviewedAt: "2026-11-20T12:00:00.000Z",
      reviewedCatalog: ["read", "grep", "bash"],
    },
    enabled: true,
  };
}

function sampleRecord(id = VALID_ID): RoutineRecord {
  const parsed = parseRoutineInput(sampleInput());
  return {
    id,
    ...parsed,
    createdAt: "2026-11-20T12:00:00.000Z",
    nextRunAtMs: Date.parse("2026-11-21T05:00:00.000Z"),
    lastRunAtMs: null,
    lastRunTabId: null,
    notices: [],
  };
}

function sampleRunRow(overrides: Partial<RoutineRunRow> = {}): RoutineRunRow {
  return {
    id: "run-1",
    routineId: VALID_ID,
    routineName: "Morning triage",
    firedAtMs: Date.parse("2026-11-21T05:00:00.000Z"),
    scheduledForMs: Date.parse("2026-11-21T05:00:00.000Z"),
    trigger: "clock",
    outcome: "on-time",
    tabId: "tab-1",
    reasonCode: null,
    missed: 0,
    pruned: false,
    staleCatalog: false,
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseRoutineInput & parseRoutinePatch (U1)", () => {
  it("normalizes @macros, trims name, dedupes tool keys, and accepts empty allow list", () => {
    const parsed = parseRoutineInput(sampleInput());
    expect(parsed.name).toBe("Morning triage");
    expect(parsed.schedule).toEqual({ kind: "cron", expr: "0 0 * * *" });
    expect(parsed.toolPolicy.allow).toEqual(["read", "grep"]);

    const emptyAllow = parseRoutineInput({
      ...sampleInput(),
      toolPolicy: {
        allow: [],
        deny: [],
        lastReviewedAt: "2026-11-20T12:00:00.000Z",
        reviewedCatalog: [],
      },
    });
    expect(emptyAllow.toolPolicy.allow).toEqual([]);
  });

  it("rejects unknown keys, remote machineKey/chat destinations, overlap in allow/deny, and invalid bounds", () => {
    expect(() => parseRoutineInput({ ...sampleInput(), stray: 1 })).toThrow(/unknown/);
    expect(() =>
      parseRoutineInput({
        ...sampleInput(),
        destination: { projectCwd: "/repo", workspace: "worktree", machineKey: "remote-1" },
      }),
    ).toThrow(/unknown destination field/);
    expect(() =>
      parseRoutineInput({
        ...sampleInput(),
        destination: { projectCwd: "/repo", workspace: "chat" },
      }),
    ).toThrow(/workspace/);
    expect(() =>
      parseRoutineInput({
        ...sampleInput(),
        name: "a".repeat(ROUTINE_NAME_MAX + 1),
      }),
    ).toThrow(/name/);
    expect(() =>
      parseRoutineInput({
        ...sampleInput(),
        instructions: "x".repeat(ROUTINE_INSTRUCTIONS_MAX + 1),
      }),
    ).toThrow(/instructions/);
    expect(() =>
      parseRoutineInput({
        ...sampleInput(),
        schedule: { kind: "cron", expr: "@reboot" },
      }),
    ).toThrow(/cron/);
    expect(() =>
      parseRoutineInput({
        ...sampleInput(),
        toolPolicy: {
          allow: ["bash"],
          deny: ["bash"],
          lastReviewedAt: "2026-11-20T12:00:00.000Z",
          reviewedCatalog: ["bash"],
        },
      }),
    ).toThrow(/both allow and deny/);
    expect(() =>
      parseRoutineInput({
        ...sampleInput(),
        spend: { warnUsd: -1, maxUsd: 5 },
      }),
    ).toThrow(/warnUsd/);
  });

  it("validates partial patches strictly", () => {
    const patch = parseRoutinePatch({ enabled: false, schedule: { kind: "cron", expr: "@hourly" } });
    expect(patch).toEqual({ enabled: false, schedule: { kind: "cron", expr: "0 * * * *" } });
    expect(() => parseRoutinePatch({ unknownKey: true })).toThrow(/unknown/);
  });
});

describe("isRoutineRecord, isRoutineRunRow & isSessionRoutine (U1)", () => {
  it("validates well-formed records and rejects malformed or free-text reason codes", () => {
    expect(isRoutineRecord(sampleRecord())).toBe(true);
    expect(isRoutineRecord({ ...sampleRecord(), id: "too-short" })).toBe(false);

    expect(isRoutineRunRow(sampleRunRow())).toBe(true);
    expect(isRoutineRunRow({ ...sampleRunRow(), reasonCode: "raw model output" })).toBe(false);

    const sr: SessionRoutine = {
      id: VALID_ID,
      name: "Morning triage",
      approvalEntries: { read: "allow", bash: "deny" },
      deniedBuiltins: ["bash"],
      warnCostUsd: 2,
      maxCostUsd: 5,
    };
    expect(isSessionRoutine(sr)).toBe(true);
    expect(isSessionRoutine({ ...sr, approvalEntries: { read: "yolo" } })).toBe(false);
  });
});

describe("routineRunTitle & routinePrompt (U2)", () => {
  it("formats fixed ASCII digits in the routine's IANA timeZone", () => {
    // 2026-01-15T14:05:00Z = 09:05 in America/New_York (EST, UTC-5)
    const ms = Date.parse("2026-01-15T14:05:00.000Z");
    expect(routineRunTitle("Morning triage", ms, "America/New_York")).toBe(
      "Morning triage · 2026-01-15 09:05",
    );
    // Midnight UTC = 00:00 (never 24:00)
    expect(routineRunTitle("Midnight", Date.parse("2026-06-01T00:00:00.000Z"), "UTC")).toBe(
      "Midnight · 2026-06-01 00:00",
    );
  });

  it("appends standing untrusted-content clause without mutating instructions", () => {
    const instructions = "Check inbox for $100 invoices and {{template}} tags.\n\n";
    const built = routinePrompt(instructions, "Inbox triage");
    expect(built.startsWith("Check inbox for $100 invoices and {{template}} tags.\n\n---\n")).toBe(true);
    expect(built).toContain('omp-ui routine "Inbox triage"');
    expect(built).toContain("untrusted data");
  });
});

describe("RoutineStore & RoutineRunHistory (U1)", () => {
  it("persists routines atomically with 0600 permissions and drops malformed records on load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-routine-store-"));
    dirs.push(dir);
    const file = path.join(dir, "routines.json");

    const store = new RoutineStore(file);
    store.add(sampleRecord());
    expect(store.list()).toHaveLength(1);

    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }

    // Inject a malformed record beside the valid one
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { schemaVersion: 1; routines: unknown[] };
    raw.routines.push({ id: "bad", name: "" });
    fs.writeFileSync(file, JSON.stringify(raw), "utf8");

    const reloaded = new RoutineStore(file);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.get(VALID_ID)?.name).toBe("Morning triage");
  });

  it("transitions running and waiting-approval rows to failed/interrupted on load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-routine-history-"));
    dirs.push(dir);
    const file = path.join(dir, "routine-runs.json");

    const history = new RoutineRunHistory(file);
    history.record(sampleRunRow({ id: "r1", outcome: "running", tabId: "t1" }));
    history.record(sampleRunRow({ id: "r2", outcome: "waiting-approval", tabId: "t2" }));
    history.record(sampleRunRow({ id: "r3", outcome: "on-time", tabId: "t3" }));

    const reloaded = new RoutineRunHistory(file);
    const rows = reloaded.list();
    expect(rows.find((r) => r.id === "r1")).toMatchObject({ outcome: "failed", reasonCode: "interrupted" });
    expect(rows.find((r) => r.id === "r2")).toMatchObject({ outcome: "failed", reasonCode: "interrupted" });
    expect(rows.find((r) => r.id === "r3")).toMatchObject({ outcome: "on-time", reasonCode: null });
  });
});

describe("routineFocusUri & parseRoutineFocusUri (ADR-0100 amendment)", () => {
  it("round-trips a valid id and rejects malformed hrefs", () => {
    expect(parseRoutineFocusUri(routineFocusUri(VALID_ID))).toBe(VALID_ID);
    expect(routineFocusUri(VALID_ID)).toBe(`omp-ui://routine/${VALID_ID}`);
    expect(() => routineFocusUri("short")).toThrow();
    expect(parseRoutineFocusUri("omp-ui://routine/short")).toBeNull();
    expect(parseRoutineFocusUri(`omp-ui://routine/${VALID_ID}x`)).toBeNull();
    expect(parseRoutineFocusUri(`omp-ui://routine/${VALID_ID}?x=1`)).toBeNull();
    expect(parseRoutineFocusUri(`omp-ui://routine/${VALID_ID}#f`)).toBeNull();
    expect(parseRoutineFocusUri(`omp-ui://routine/${VALID_ID.slice(0, 16)} ${VALID_ID.slice(17)}`)).toBeNull();
    expect(parseRoutineFocusUri(`https://x/routine/${VALID_ID}`)).toBeNull();
    expect(parseRoutineFocusUri("omp-ui://routine")).toBeNull();
    expect(parseRoutineFocusUri(`OMP-UI://routine/${VALID_ID}`)).toBeNull();
    expect(parseRoutineFocusUri(`omp-ui://routine/${"a".repeat(21)}!`)).toBeNull();
  });
});

describe("parseRoutineAgentCreateArgs & routineInputFromAgentCreate (ADR-0100 amendment)", () => {
  const GOOD = {
    name: "Gmail triage",
    instructions: "Summarize unread mail.",
    schedule: { kind: "cron", expr: "@daily" },
    timeZone: "America/New_York",
    projectCwd: "/home/dev/repo",
    mode: "build",
    allow: ["read", "grep"],
  };

  it("accepts the narrow shape and defaults spend to inherit", () => {
    const args = parseRoutineAgentCreateArgs(GOOD);
    expect(args.warnUsd).toBeNull();
    expect(args.maxUsd).toBeNull();
    const input = routineInputFromAgentCreate(args, "2026-11-22T12:00:00.000Z");
    // The guardrail: an agent-created routine is always a disabled draft.
    expect(input.enabled).toBe(false);
    expect(input.destination).toEqual({ projectCwd: "/home/dev/repo", workspace: "worktree" });
    expect(input.toolPolicy).toEqual({ allow: ["read", "grep"], deny: [], lastReviewedAt: "2026-11-22T12:00:00.000Z", reviewedCatalog: [] });
    expect(() => parseRoutineInput(input)).not.toThrow();
  });

  it("refuses keys the schema cannot express and bad values", () => {
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, enabled: true })).toThrow(/enabled/);
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, toolPolicy: GOOD.allow })).toThrow();
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, schedule: { kind: "once", atMs: 1 } })).toThrow(/cron/);
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, timeZone: "Mars/Olympus" })).toThrow(/time zone/);
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, projectCwd: "  " })).toThrow();
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, mode: "yolo" })).toThrow();
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, maxUsd: 1e9 })).toThrow();
    expect(parseRoutineAgentCreateArgs({ ...GOOD, model: null, thinkingLevel: null }).model).toBeNull();
  });
});
