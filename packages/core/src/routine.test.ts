import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTINE_NOTIFICATIONS,
  ROUTINE_DEFAULT_TIMEOUT_MINUTES,
  ROUTINE_INSTRUCTIONS_MAX,
  ROUTINE_NAME_MAX,
  ROUTINE_NOTIFY_TOOL_KEY,
  ROUTINE_SCRIPT_MAX,
  ROUTINE_TIMEOUT_MAX_MINUTES,
  compileRoutineToolPolicy,
  isRoutineRecord,
  isRoutineRunRow,
  isSessionRoutine,
  parseRoutineAgentCreateArgs,
  parseRoutineAgentUpdateArgs,
  parseRoutineAgentListArgs,
  parseRoutineAgentIdArgs,
  parseRoutineAgentDryRunArgs,
  parseRoutineFocusUri,
  parseRoutineInput,
  parseRoutinePatch,
  parseRoutineTestScriptRequest,
  routineAllowsAgentNotification,
  routineFocusUri,
  routineInputFromAgentCreate,
  resolveRoutineTimeoutMinutes,
  resolveRoutineWallClockMs,
  routinePatchFromAgentUpdate,
  routinePrompt,
  routineRunTitle,
  routineToolKeyFromApprovalName,
  type RoutineCatalogSnapshot,
  type RoutineInput,
  type RoutineRecord,
  type RoutineRunRow,
  type SessionRoutine,
} from "./routine";
import { RoutineRunHistory, RoutineStore } from "./routine-store";
import { ARTIFACT_CAPTURE_TOOL_NAME } from "./html-artifact";
import { WATCHDOG_KNOWN_TOOLS } from "./watchdog";

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
    scripts: { pre: "", post: "" },
    timeoutMinutes: null,
    notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
    artifact: null,
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

describe("scripts hooks (#1283)", () => {
  it("defaults an omitted scripts key and accepts multi-line hooks with tabs", () => {
    const legacy = { ...sampleInput() } as Partial<RoutineInput>;
    delete legacy.scripts;
    expect(parseRoutineInput(legacy).scripts).toEqual({ pre: "", post: "" });

    const hook = "set -eu\n\tcd \"${OMP_UI_ROUTINE_RUN_CWD}\" && npm test";
    const parsed = parseRoutineInput({ ...sampleInput(), scripts: { pre: "", post: hook } });
    expect(parsed.scripts.post).toBe(hook);
  });

  it("caps length, rejects control chars other than tab/LF, and rejects malformed shapes", () => {
    expect(() =>
      parseRoutineInput({ ...sampleInput(), scripts: { pre: "x".repeat(ROUTINE_SCRIPT_MAX + 1), post: "" } }),
    ).toThrow(/pre exceeds/);
    expect(() => parseRoutineInput({ ...sampleInput(), scripts: { pre: "echo\rhi", post: "" } })).toThrow(
      /control characters/,
    );
    expect(() => parseRoutineInput({ ...sampleInput(), scripts: { pre: "echo\u0007hi", post: "" } })).toThrow(
      /control characters/,
    );
    expect(() => parseRoutineInput({ ...sampleInput(), scripts: null })).toThrow(/scripts must be an object/);
    expect(() => parseRoutineInput({ ...sampleInput(), scripts: { pre: 1, post: "" } })).toThrow(
      /scripts\.pre must be a string/,
    );
    expect(() => parseRoutineInput({ ...sampleInput(), scripts: { pre: "", extra: "x" } })).toThrow(
      /unknown scripts field/,
    );
  });

  it("validates scripts in patches and rejects non-string phases", () => {
    expect(parseRoutinePatch({ scripts: { pre: "", post: "echo done" } }).scripts).toEqual({
      pre: "",
      post: "echo done",
    });
    expect(() => parseRoutinePatch({ scripts: { pre: null, post: "" } })).toThrow(/must be a string/);
  });

  it("rejects malformed scripts on a stored record but tolerates absence", () => {
    expect(isRoutineRecord(sampleRecord())).toBe(true);
    expect(isRoutineRecord({ ...sampleRecord(), scripts: null })).toBe(false);
    expect(isRoutineRecord({ ...sampleRecord(), scripts: { pre: null, post: "" } })).toBe(false);
    const legacy = { ...sampleRecord() } as Partial<RoutineRecord>;
    delete legacy.scripts;
    expect(isRoutineRecord(legacy)).toBe(true);
  });

  it("accepts scripts on the agent create tool (ADR-0100 amendment 2)", () => {
    const agentArgs = {
      name: "Nightly",
      instructions: "x",
      schedule: { kind: "cron", expr: "@daily" } as const,
      timeZone: "UTC",
      projectCwd: "/repo",
      mode: "build" as const,
      model: null,
      thinkingLevel: null,
      allow: ["read"],
      warnUsd: null,
      maxUsd: null,
      timeoutMinutes: null,
    };
    // Absent defaults to no hooks; a present hook carries through to the input.
    expect(routineInputFromAgentCreate(parseRoutineAgentCreateArgs(agentArgs), "2026-11-22T00:00:00.000Z").scripts)
      .toEqual({ pre: "", post: "" });
    const withHooks = parseRoutineAgentCreateArgs({ ...agentArgs, scripts: { pre: "git pull", post: "echo done\t" } });
    expect(routineInputFromAgentCreate(withHooks, "2026-11-22T00:00:00.000Z").scripts).toEqual({
      pre: "git pull",
      post: "echo done\t",
    });
    expect(() => parseRoutineAgentCreateArgs({ ...agentArgs, scripts: { pre: "x".repeat(ROUTINE_SCRIPT_MAX + 1) } }))
      .toThrow(new RegExp(`scripts\\.pre exceeds ${ROUTINE_SCRIPT_MAX}`));
    expect(() => parseRoutineAgentCreateArgs({ ...agentArgs, scripts: { pre: "echo\rhi" } })).toThrow(/control/);
    expect(() => parseRoutineAgentCreateArgs({ ...agentArgs, scripts: { enabled: true } })).toThrow(/unknown scripts/);
    // Host-owned fields stay unexpressible.
    expect(() => parseRoutineAgentCreateArgs({ ...agentArgs, enabled: true })).toThrow(/unknown/);
  });

  it("accepts new reason codes and postScript statuses on rows, rejects bogus ones", () => {
    expect(isRoutineRunRow(sampleRunRow({ reasonCode: "pre-script" }))).toBe(true);
    expect(isRoutineRunRow(sampleRunRow({ reasonCode: "pre-script-skip" }))).toBe(true);
    expect(isRoutineRunRow(sampleRunRow({ postScript: "ok" }))).toBe(true);
    expect(isRoutineRunRow(sampleRunRow({ postScript: "timeout" }))).toBe(true);
    expect(isRoutineRunRow({ ...sampleRunRow(), postScript: "ran fine" })).toBe(false);
    expect(isRoutineRunRow({ ...sampleRunRow(), postScript: null })).toBe(false);
  });
});

describe("timeoutMinutes (#1290)", () => {
  it("accepts null, omitted on create, 0 (unlimited), and integers 1..1440", () => {
    const legacy = { ...sampleInput() } as Partial<RoutineInput>;
    delete legacy.timeoutMinutes;
    expect(parseRoutineInput(legacy).timeoutMinutes).toBeNull();
    expect(parseRoutineInput({ ...sampleInput(), timeoutMinutes: null }).timeoutMinutes).toBeNull();
    expect(parseRoutineInput({ ...sampleInput(), timeoutMinutes: 0 }).timeoutMinutes).toBe(0);
    expect(parseRoutineInput({ ...sampleInput(), timeoutMinutes: 1 }).timeoutMinutes).toBe(1);
    expect(parseRoutineInput({ ...sampleInput(), timeoutMinutes: ROUTINE_TIMEOUT_MAX_MINUTES }).timeoutMinutes).toBe(
      ROUTINE_TIMEOUT_MAX_MINUTES,
    );
  });

  it("rejects out-of-range, non-integer, and wrong-type values on input, patch, and record", () => {
    for (const bad of [-1, 1.5, ROUTINE_TIMEOUT_MAX_MINUTES + 1, Number.NaN, Number.POSITIVE_INFINITY, "30", false]) {
      expect(() => parseRoutineInput({ ...sampleInput(), timeoutMinutes: bad })).toThrow(/timeoutMinutes/);
      expect(() => parseRoutinePatch({ timeoutMinutes: bad })).toThrow(/timeoutMinutes/);
      expect(isRoutineRecord({ ...sampleRecord(), timeoutMinutes: bad })).toBe(false);
    }
    // Explicit undefined in patch is rejected (mirrors spend/model strictness).
    expect(() => parseRoutinePatch({ timeoutMinutes: undefined })).toThrow(/timeoutMinutes/);
    expect(parseRoutinePatch({ timeoutMinutes: null })).toEqual({ timeoutMinutes: null });
    expect(parseRoutinePatch({ timeoutMinutes: 0 })).toEqual({ timeoutMinutes: 0 });
    expect(parseRoutinePatch({ timeoutMinutes: 90 })).toEqual({ timeoutMinutes: 90 });

    // Absent timeoutMinutes on stored legacy record stays valid for load backfill.
    const legacy = { ...sampleRecord() } as Partial<RoutineRecord>;
    delete legacy.timeoutMinutes;
    expect(isRoutineRecord(legacy)).toBe(true);
  });

  it("resolves effective minutes and wallClockMs", () => {
    expect(resolveRoutineTimeoutMinutes(undefined)).toBe(ROUTINE_DEFAULT_TIMEOUT_MINUTES);
    expect(resolveRoutineTimeoutMinutes(null)).toBe(ROUTINE_DEFAULT_TIMEOUT_MINUTES);
    expect(resolveRoutineTimeoutMinutes(0)).toBe(0);
    expect(resolveRoutineTimeoutMinutes(90)).toBe(90);

    expect(resolveRoutineWallClockMs(undefined)).toBe(30 * 60 * 1000);
    expect(resolveRoutineWallClockMs(null)).toBe(30 * 60 * 1000);
    expect(resolveRoutineWallClockMs(0)).toBeNull();
    expect(resolveRoutineWallClockMs(90)).toBe(90 * 60 * 1000);
  });

  it("parses and forwards timeoutMinutes in parseRoutineAgentCreateArgs and routineInputFromAgentCreate", () => {
    const base = {
      name: "Deep audit",
      instructions: "Audit repository.",
      schedule: { kind: "cron", expr: "@daily" },
      timeZone: "UTC",
      projectCwd: "/repo",
      mode: "build",
      allow: ["read"],
    };
    const omitted = parseRoutineAgentCreateArgs(base);
    expect(omitted.timeoutMinutes).toBeNull();
    expect(routineInputFromAgentCreate(omitted, "2026-11-22T00:00:00.000Z").timeoutMinutes).toBeNull();

    const unlimited = parseRoutineAgentCreateArgs({ ...base, timeoutMinutes: 0 });
    expect(unlimited.timeoutMinutes).toBe(0);
    expect(routineInputFromAgentCreate(unlimited, "2026-11-22T00:00:00.000Z").timeoutMinutes).toBe(0);

    const custom = parseRoutineAgentCreateArgs({ ...base, timeoutMinutes: 90 });
    expect(custom.timeoutMinutes).toBe(90);
    expect(routineInputFromAgentCreate(custom, "2026-11-22T00:00:00.000Z").timeoutMinutes).toBe(90);

    expect(() => parseRoutineAgentCreateArgs({ ...base, timeoutMinutes: -5 })).toThrow(/timeoutMinutes/);
    expect(() => parseRoutineAgentCreateArgs({ ...base, timeoutMinutes: 2000 })).toThrow(/timeoutMinutes/);
  });
});

describe("parseRoutineTestScriptRequest (#1283)", () => {
  it("accepts a well-formed request and rejects blanks, control chars, unknown keys, missing path", () => {
    expect(parseRoutineTestScriptRequest({ projectCwd: "/repo", command: "echo hello" })).toEqual({
      projectCwd: "/repo",
      command: "echo hello",
    });
    expect(() => parseRoutineTestScriptRequest({ projectCwd: "/repo", command: "   " })).toThrow(/nothing to test/);
    expect(() => parseRoutineTestScriptRequest({ projectCwd: "/repo", command: "echo\u0007" })).toThrow(/control/);
    expect(() => parseRoutineTestScriptRequest({ projectCwd: "/repo", command: "true", stray: 1 })).toThrow(/unknown/);
    expect(() => parseRoutineTestScriptRequest({ command: "true" })).toThrow(/projectCwd/);
    expect(() => parseRoutineTestScriptRequest({ projectCwd: "", command: "true" })).toThrow(/projectCwd/);
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

  it("accepts workspace, deny and artifact; create still lands disabled (#1311)", () => {
    const binding = {
      artifactId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      datasetIds: ["rows", "meta"],
      autoApply: true,
    };
    const args = parseRoutineAgentCreateArgs({ ...GOOD, workspace: "checkout", deny: ["bash"], artifact: binding });
    expect(args.workspace).toBe("checkout");
    expect(args.deny).toEqual(["bash"]);
    expect(args.artifact).toEqual(binding);
    const input = routineInputFromAgentCreate(args, "2026-11-22T12:00:00.000Z");
    // The create-always-disabled invariant survives every new field.
    expect(input.enabled).toBe(false);
    expect(input.destination).toEqual({ projectCwd: "/home/dev/repo", workspace: "checkout" });
    expect(input.toolPolicy.deny).toEqual(["bash"]);
    expect(input.artifact).toEqual(binding);
    expect(() => parseRoutineInput(input)).not.toThrow();
    // Defaults stay the isolated, unbound shape.
    const plain = routineInputFromAgentCreate(parseRoutineAgentCreateArgs(GOOD), "2026-11-22T12:00:00.000Z");
    expect(plain.destination.workspace).toBe("worktree");
    expect(plain.toolPolicy.deny).toEqual([]);
    expect(plain.artifact).toBeNull();
  });

  it("refuses malformed workspace, deny and artifact shapes (#1311)", () => {
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, workspace: "cloud" })).toThrow(/workspace/);
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, deny: "bash" })).toThrow(/deny/);
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, artifact: { artifactId: "nope", datasetIds: ["rows"], autoApply: true } }))
      .toThrow(/artifact/);
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, artifact: { artifactId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", datasetIds: [], autoApply: false } }))
      .toThrow(/datasetIds/);
    expect(() => parseRoutineAgentCreateArgs({ ...GOOD, artifact: { artifactId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", datasetIds: ["rows"], autoApply: "yes" } }))
      .toThrow(/autoApply/);
  });
});

describe("agent args for the read/manage/list endpoint tools (#1311)", () => {
  it("parseRoutineAgentListArgs accepts nothing or one valid id", () => {
    expect(parseRoutineAgentListArgs({})).toEqual({});
    expect(parseRoutineAgentListArgs({ id: VALID_ID })).toEqual({ id: VALID_ID });
    expect(() => parseRoutineAgentListArgs({ id: "short" })).toThrow(/id/);
    expect(() => parseRoutineAgentListArgs({ extra: 1 })).toThrow(/unknown/);
    expect(() => parseRoutineAgentListArgs("x")).toThrow(/object/);
  });

  it("parseRoutineAgentIdArgs takes exactly one valid routine id", () => {
    expect(parseRoutineAgentIdArgs({ id: VALID_ID }, "remove")).toBe(VALID_ID);
    expect(() => parseRoutineAgentIdArgs({}, "remove")).toThrow(/id/);
    expect(() => parseRoutineAgentIdArgs({ id: VALID_ID, extra: 1 }, "runNow")).toThrow(/runNow/);
    expect(() => parseRoutineAgentIdArgs(null, "remove")).toThrow(/remove/);
  });

  it("parseRoutineAgentDryRunArgs splits saved by id and validates drafts through parseRoutineInput", () => {
    expect(parseRoutineAgentDryRunArgs({ kind: "saved", id: VALID_ID })).toEqual({ kind: "saved", id: VALID_ID });
    expect(() => parseRoutineAgentDryRunArgs({ kind: "saved", id: "short" })).toThrow(/id/);
    expect(() => parseRoutineAgentDryRunArgs({ kind: "once" })).toThrow(/saved|draft/);
    const draft = routineInputFromAgentCreate(
      parseRoutineAgentCreateArgs({
        name: "Draft",
        instructions: "Do the thing.",
        schedule: { kind: "cron", expr: "@daily" },
        timeZone: "America/New_York",
        projectCwd: "/home/dev/repo",
        mode: "plan",
        allow: ["read"],
      }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(parseRoutineAgentDryRunArgs({ kind: "draft", input: draft })).toEqual({ kind: "draft", input: draft });
    expect(() => parseRoutineAgentDryRunArgs({ kind: "draft", input: { name: 1 } })).toThrow();
  });
});

describe("parseRoutineAgentUpdateArgs & routinePatchFromAgentUpdate (ADR-0100 amendment 2)", () => {
  function currentRecord(): RoutineRecord {
    return {
      ...sampleRecord(),
      enabled: true,
      spend: { warnUsd: 2, maxUsd: 5 },
      scripts: { pre: "git pull", post: "echo done" },
      destination: { projectCwd: "/home/dev/repo", workspace: "checkout" },
      toolPolicy: {
        allow: ["read", "grep"],
        deny: ["bash", "eval"],
        lastReviewedAt: "2026-11-20T12:00:00.000Z",
        reviewedCatalog: ["read", "grep", "bash"],
      },
    };
  }

  it("forces enabled:false and carries untouched leaves from the stored record", () => {
    const current = currentRecord();
    const args = parseRoutineAgentUpdateArgs({ id: VALID_ID, name: "Renamed" });
    const patch = routinePatchFromAgentUpdate(current, args, "2026-11-23T00:00:00.000Z");
    expect(patch).toEqual({ enabled: false, name: "Renamed" });
    // An omitted maxUsd keeps the stored spend; no scripts/spend/toolPolicy key means untouched.
    expect(patch.spend).toBeUndefined();
    expect(patch.scripts).toBeUndefined();
    expect(patch.toolPolicy).toBeUndefined();
  });

  it("refuses an id-only call, unknown keys, whole-object policy, and a bad id (#1311)", () => {
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID })).toThrow(/at least one field/);
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, toolPolicy: { allow: [], deny: ["bash"] } })).toThrow(/unknown/);
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, destination: { projectCwd: "/x", workspace: "checkout" } })).toThrow(/unknown/);
    expect(() => parseRoutineAgentUpdateArgs({ id: "too-short" })).toThrow(/id/);
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, mode: "yolo" })).toThrow();
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, timeZone: "Mars/Olympus" })).toThrow(/time zone/);
    // #1311: enabled/deny/workspace/artifact became expressible — wrong types still refuse.
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, enabled: "yes" })).toThrow(/enabled/);
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, deny: ["" ] })).toThrow();
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, workspace: "cloud" })).toThrow(/workspace/);
  });

  it("distinguishes present-with-null from absent on nullable leaves", () => {
    const parsed = parseRoutineAgentUpdateArgs({ id: VALID_ID, model: null, warnUsd: null });
    expect(parsed.model).toBeNull();
    expect(parsed.warnUsd).toBeNull();
    expect("thinkingLevel" in parsed).toBe(false);
    expect("maxUsd" in parsed).toBe(false);
    const current = currentRecord();
    const patch = routinePatchFromAgentUpdate(current, parsed, "2026-11-23T00:00:00.000Z");
    // warnUsd resets to inherit while the omitted maxUsd keeps its stored cap.
    expect(patch.spend).toEqual({ warnUsd: null, maxUsd: 5 });
    expect(patch.model).toBeNull();
    expect("thinkingLevel" in patch).toBe(false);
  });

  it("merges hook leaves per phase: omitted inherits, empty string clears", () => {
    const current = currentRecord();
    const onlyPre = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, scripts: { pre: "" } }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(onlyPre.scripts).toEqual({ pre: "", post: "echo done" });
    const both = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, scripts: { pre: "fetch", post: "notify" } }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(both.scripts).toEqual({ pre: "fetch", post: "notify" });
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, scripts: { pre: "echo\rhi" } })).toThrow(/control/);
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, scripts: { post: 1 } })).toThrow(/must be a string/);
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, scripts: { pre: "x".repeat(ROUTINE_SCRIPT_MAX + 1) } }))
      .toThrow(new RegExp(`scripts\\.pre exceeds ${ROUTINE_SCRIPT_MAX}`));
  });

  it("replaces allow but preserves deny verbatim and restamps the review", () => {
    const current = currentRecord();
    const patch = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, allow: ["read", "web_search"] }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(patch.toolPolicy).toEqual({
      allow: ["read", "web_search"],
      deny: ["bash", "eval"],
      lastReviewedAt: "2026-11-23T00:00:00.000Z",
      reviewedCatalog: [],
    });
  });

  it("keeps the stored workspace when projectCwd changes", () => {
    const current = currentRecord();
    const patch = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, projectCwd: "/home/dev/other" }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(patch.destination).toEqual({ projectCwd: "/home/dev/other", workspace: "checkout" });
  });

  it("updates and resets timeoutMinutes (null = default, 0 = unlimited, custom integer, omit = unchanged)", () => {
    const current = { ...currentRecord(), timeoutMinutes: 45 };
    const untouched = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, name: "Same timeout" }),
      "2026-11-23T00:00:00.000Z",
    );
    expect("timeoutMinutes" in untouched).toBe(false);

    const unlimited = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, timeoutMinutes: 0 }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(unlimited.timeoutMinutes).toBe(0);

    const reset = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, timeoutMinutes: null }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(reset.timeoutMinutes).toBeNull();
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, timeoutMinutes: -1 })).toThrow(/timeoutMinutes/);
  });

  it("arms only on an explicit enabled:true; any other edit still lands disabled (#1311)", () => {
    const current = currentRecord();
    const armed = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, enabled: true }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(armed.enabled).toBe(true);
    const disarmed = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, enabled: false, name: "Renamed" }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(disarmed.enabled).toBe(false);
    expect(disarmed.name).toBe("Renamed");
  });

  it("replaces deny and keeps allow, or replaces both together, restamping the review (#1311)", () => {
    const current = currentRecord();
    const denyOnly = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, deny: ["web_search"] }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(denyOnly.toolPolicy).toEqual({
      allow: ["read", "grep"],
      deny: ["web_search"],
      lastReviewedAt: "2026-11-23T00:00:00.000Z",
      reviewedCatalog: [],
    });
    const cleared = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, allow: ["read"], deny: [] }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(cleared.toolPolicy).toMatchObject({ allow: ["read"], deny: [] });
  });

  it("restates workspace alone or together with projectCwd (#1311)", () => {
    const current = currentRecord();
    const workspaceOnly = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, workspace: "worktree" }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(workspaceOnly.destination).toEqual({ projectCwd: "/home/dev/repo", workspace: "worktree" });
  });

  it("patches an artifact binding and clears it with explicit null (#1311)", () => {
    const current = currentRecord();
    const binding = {
      artifactId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      datasetIds: ["rows"],
      autoApply: false,
    };
    const bound = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, artifact: binding }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(bound.artifact).toEqual(binding);
    const cleared = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, artifact: null }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(cleared.artifact).toBeNull();
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, artifact: { artifactId: "nope", datasetIds: [], autoApply: true } }))
      .toThrow(/artifact/);
  });
});

describe("routineToolKeyFromApprovalName (#1276)", () => {
  it("normalizes PascalCase built-ins to snake_case and keeps mcp__ keys verbatim", () => {
    expect(routineToolKeyFromApprovalName("Bash")).toBe("bash");
    expect(routineToolKeyFromApprovalName("WebSearch")).toBe("web_search");
    expect(routineToolKeyFromApprovalName("AstEdit")).toBe("ast_edit");
    expect(routineToolKeyFromApprovalName("  Read  ")).toBe("read");
    expect(routineToolKeyFromApprovalName("mcp__github_create_issue")).toBe("mcp__github_create_issue");
    expect(routineToolKeyFromApprovalName("mcp__MyServer_DoThing")).toBe("mcp__MyServer_DoThing");
    for (const key of WATCHDOG_KNOWN_TOOLS) {
      const pascal = key
        .split("_")
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join("");
      expect(routineToolKeyFromApprovalName(pascal)).toBe(key);
    }
  });

  it("returns empty string for blank or control-character names", () => {
    expect(routineToolKeyFromApprovalName("")).toBe("");
    expect(routineToolKeyFromApprovalName("   ")).toBe("");
    expect(routineToolKeyFromApprovalName("ba\nsh")).toBe("");
    expect(routineToolKeyFromApprovalName("read\x00")).toBe("");
  });
});

describe("routine notifications (#1294)", () => {
  const catalog: RoutineCatalogSnapshot = {
    tools: [
      { key: "read", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "" },
      { key: "bash", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "" },
    ],
    staleServers: [],
    enumerationError: null,
    capturedAt: "2026-11-23T00:00:00.000Z",
  };

  it("defaults omitted notifications on create input and agent create, and validates patches and leaves strictly", () => {
    const legacy = { ...sampleInput() } as Partial<RoutineInput>;
    delete legacy.notifications;
    expect(parseRoutineInput(legacy).notifications).toEqual(DEFAULT_ROUTINE_NOTIFICATIONS);

    const parsed = parseRoutineInput({
      ...sampleInput(),
      notifications: { onStart: true, onComplete: true, agentMessage: true },
    });
    expect(parsed.notifications).toEqual({
      onStart: true,
      onComplete: true,
      onFail: false,
      onApproval: false,
      agentMessage: true,
    });

    expect(() => parseRoutineInput({ ...sampleInput(), notifications: null })).toThrow(/notifications must be an object/);
    expect(() => parseRoutineInput({ ...sampleInput(), notifications: { onStart: "yes" } })).toThrow(
      /notifications\.onStart must be a boolean/,
    );
    expect(() => parseRoutineInput({ ...sampleInput(), notifications: { extra: true } })).toThrow(
      /unknown notifications field/,
    );

    expect(parseRoutinePatch({ notifications: { onFail: true } }).notifications).toEqual({
      ...DEFAULT_ROUTINE_NOTIFICATIONS,
      onFail: true,
    });
    expect(() => parseRoutinePatch({ notifications: { onApproval: 1 } })).toThrow(
      /notifications\.onApproval must be a boolean/,
    );

    const agentArgs = parseRoutineAgentCreateArgs({
      name: "Nightly",
      instructions: "Check CI",
      schedule: { kind: "cron", expr: "@daily" },
      timeZone: "UTC",
      projectCwd: "/repo",
      mode: "build",
      allow: ["read"],
      notifications: { onFail: true },
    });
    expect(routineInputFromAgentCreate(agentArgs, "2026-11-23T00:00:00.000Z").notifications).toEqual({
      ...DEFAULT_ROUTINE_NOTIFICATIONS,
      onFail: true,
    });
  });

  it("merges notifications leaf-by-leaf on agent update and rejects empty/malformed notifications", () => {
    const current = {
      ...sampleRecord(),
      notifications: {
        onStart: true,
        onComplete: true,
        onFail: false,
        onApproval: false,
        agentMessage: false,
      },
    };
    const patch = routinePatchFromAgentUpdate(
      current,
      parseRoutineAgentUpdateArgs({ id: VALID_ID, notifications: { onFail: true, agentMessage: true } }),
      "2026-11-23T00:00:00.000Z",
    );
    expect(patch.enabled).toBe(false);
    expect(patch.notifications).toEqual({
      onStart: true,
      onComplete: true,
      onFail: true,
      onApproval: false,
      agentMessage: true,
    });
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, notifications: {} })).toThrow(/at least one field/);
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, notifications: { onStart: 1 } })).toThrow(
      /notifications\.onStart must be a boolean/,
    );
    expect(() => parseRoutineAgentUpdateArgs({ id: VALID_ID, notifications: { bogus: true } })).toThrow(
      /unknown notifications field/,
    );
  });

  it("tolerates missing notifications on legacy stored records but rejects malformed ones", () => {
    const legacy = { ...sampleRecord() } as Partial<RoutineRecord>;
    delete legacy.notifications;
    expect(isRoutineRecord(legacy)).toBe(true);
    expect(isRoutineRecord({ ...sampleRecord(), notifications: null })).toBe(false);
    expect(isRoutineRecord({ ...sampleRecord(), notifications: { onStart: "true" } })).toBe(false);
    expect(isRoutineRecord({ ...sampleRecord(), notifications: { unknown: true } })).toBe(false);
  });

  it("compiles omp-ui_notify allow and appends prompt clause iff allowAgentNotify/agentNotification is true", () => {
    expect(routineAllowsAgentNotification({ ...DEFAULT_ROUTINE_NOTIFICATIONS, agentMessage: true })).toBe(false);
    expect(
      routineAllowsAgentNotification({ ...DEFAULT_ROUTINE_NOTIFICATIONS, onComplete: true, agentMessage: true }),
    ).toBe(true);

    const policy = sampleInput().toolPolicy;
    const without = compileRoutineToolPolicy(policy, catalog);
    expect(without.overlayEntries[ROUTINE_NOTIFY_TOOL_KEY]).toBeUndefined();

    const withNotify = compileRoutineToolPolicy(policy, catalog, { allowAgentNotify: true });
    expect(withNotify.overlayEntries[ROUTINE_NOTIFY_TOOL_KEY]).toBe("allow");
    expect(withNotify.overlayYamlPreview).toContain(`"${ROUTINE_NOTIFY_TOOL_KEY}": allow`);

    const deniedPolicy = { ...policy, deny: [...policy.deny, ROUTINE_NOTIFY_TOOL_KEY] };
    const denied = compileRoutineToolPolicy(deniedPolicy, catalog, { allowAgentNotify: true });
    expect(denied.overlayEntries[ROUTINE_NOTIFY_TOOL_KEY]).toBe("deny");

    const plainPrompt = routinePrompt("Check status", "Daily");
    expect(plainPrompt).not.toContain("omp-ui_notify");
    const agentPrompt = routinePrompt("Check status", "Daily", { agentNotification: true });
    expect(agentPrompt).toContain("omp-ui_notify");
    expect(agentPrompt.indexOf("untrusted data")).toBeLessThan(agentPrompt.indexOf("omp-ui_notify"));
  });
});

describe("scheduled artifact refresh (ADR-0101)", () => {
  const catalog: RoutineCatalogSnapshot = {
    tools: [
      { key: "read", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "" },
      { key: "bash", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "" },
    ],
    staleServers: [],
    enumerationError: null,
    capturedAt: "2026-11-23T00:00:00.000Z",
  };
  const ARTIFACT_ID = "0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b";
  const binding = { artifactId: ARTIFACT_ID, datasetIds: ["scores", "roster"], autoApply: true };

  it("parses a binding on input and patch, defaults omitted to null, and rejects malformed shapes", () => {
    expect(parseRoutineInput({ ...sampleInput(), artifact: binding }).artifact).toEqual(binding);
    expect(parseRoutineInput(sampleInput()).artifact).toBeNull();
    expect(parseRoutinePatch({ artifact: binding }).artifact).toEqual(binding);
    expect(parseRoutinePatch({ artifact: null }).artifact).toBeNull();
    expect(() => parseRoutineInput({ ...sampleInput(), artifact: { ...binding, artifactId: "nope" } })).toThrow(
      /artifactId must be a UUID/,
    );
    expect(() => parseRoutineInput({ ...sampleInput(), artifact: { ...binding, datasetIds: [] } })).toThrow(
      /datasetIds must be a non-empty array/,
    );
    expect(() => parseRoutineInput({ ...sampleInput(), artifact: { ...binding, datasetIds: ["ok", "ok"] } })).toThrow(
      /datasetIds must be unique/,
    );
    expect(() =>
      parseRoutineInput({ ...sampleInput(), artifact: { ...binding, datasetIds: ["ok".repeat(40)] } }),
    ).toThrow(/Invalid dataset key/);
    expect(() => parseRoutineInput({ ...sampleInput(), artifact: { ...binding, autoApply: "yes" } })).toThrow(
      /autoApply must be a boolean/,
    );
    expect(() => parseRoutineInput({ ...sampleInput(), artifact: { ...binding, extra: 1 } })).toThrow(
      /unknown artifact field/,
    );
  });

  it("rejects malformed artifact on stored records and SessionRoutine but tolerates absence", () => {
    expect(isRoutineRecord(sampleRecord())).toBe(true);
    expect(isRoutineRecord({ ...sampleRecord(), artifact: binding })).toBe(true);
    expect(isRoutineRecord({ ...sampleRecord(), artifact: { ...binding, datasetIds: "x" } })).toBe(false);
    const legacy = { ...sampleRecord() } as Partial<RoutineRecord>;
    delete legacy.artifact;
    expect(isRoutineRecord(legacy)).toBe(true);

    const session: SessionRoutine = {
      id: VALID_ID,
      name: "Nightly",
      approvalEntries: {},
      deniedBuiltins: [],
      warnCostUsd: 2,
      maxCostUsd: 5,
    };
    expect(isSessionRoutine(session)).toBe(true);
    expect(isSessionRoutine({ ...session, artifact: binding })).toBe(true);
    expect(isSessionRoutine({ ...session, artifact: { ...binding, autoApply: false } })).toBe(true);
    expect(isSessionRoutine({ ...session, artifact: { ...binding, autoApply: 1 } })).toBe(false);
  });

  it("defaults the agent create/patch surfaces to unbound and refuses malformed bindings (#1311 amends ADR-0101 §1)", () => {
    expect(routineInputFromAgentCreate(
      parseRoutineAgentCreateArgs({
        name: "Nightly",
        instructions: "x",
        schedule: { kind: "cron", expr: "@daily" },
        timeZone: "UTC",
        projectCwd: "/repo",
        mode: "build",
        allow: ["read"],
      }),
      "2026-11-23T00:00:00.000Z",
    ).artifact).toBeNull();
    expect(routinePatchFromAgentUpdate(
      { ...sampleRecord(), artifact: binding },
      parseRoutineAgentUpdateArgs({ id: VALID_ID, name: "Rename keeps binding out of the patch" }),
      "2026-11-23T00:00:00.000Z",
    ).artifact).toBeUndefined();
    // #1311: the key became expressible — a malformed binding still refuses.
    expect(() =>
      parseRoutineAgentCreateArgs({
        name: "Nightly",
        instructions: "x",
        schedule: { kind: "cron", expr: "@daily" },
        timeZone: "UTC",
        projectCwd: "/repo",
        mode: "build",
        allow: ["read"],
        artifact: { ...binding, datasetIds: [] },
      }),
    ).toThrow(/datasetIds/);
    expect(() =>
      parseRoutineAgentUpdateArgs({ id: VALID_ID, artifact: { ...binding, autoApply: "yes" } }),
    ).toThrow(/autoApply/);
  });

  it("force-allows omp-ui_artifact_capture when bound and lets deny win", () => {
    const policy = sampleInput().toolPolicy;
    expect(compileRoutineToolPolicy(policy, catalog).overlayEntries[ARTIFACT_CAPTURE_TOOL_NAME]).toBeUndefined();
    const bound = compileRoutineToolPolicy(policy, catalog, { allowArtifactCapture: true });
    expect(bound.overlayEntries[ARTIFACT_CAPTURE_TOOL_NAME]).toBe("allow");
    expect(bound.overlayYamlPreview).toContain(`"${ARTIFACT_CAPTURE_TOOL_NAME}": allow`);
    const deniedPolicy = { ...policy, deny: [...policy.deny, ARTIFACT_CAPTURE_TOOL_NAME] };
    expect(
      compileRoutineToolPolicy(deniedPolicy, catalog, { allowArtifactCapture: true }).overlayEntries[ARTIFACT_CAPTURE_TOOL_NAME],
    ).toBe("deny");
  });

  it("accepts the artifact-missing reason code on run rows", () => {
    const row: RoutineRunRow = {
      id: "r1",
      routineId: VALID_ID,
      routineName: "Nightly",
      firedAtMs: 1,
      scheduledForMs: null,
      trigger: "clock",
      outcome: "failed",
      tabId: null,
      reasonCode: "artifact-missing",
      missed: 0,
      pruned: false,
      staleCatalog: false,
    };
    expect(isRoutineRunRow(row)).toBe(true);
  });
});
