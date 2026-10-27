import { describe, expect, it } from "vitest";
import {
  asyncJobsArmMessage,
  asyncJobsKillMessage,
  ASYNC_JOBS_SNAPSHOT_VERSION,
  buildAsyncJobRows,
  parseAsyncJobsSnapshot,
  type AsyncJob,
  type AsyncJobAgent,
  type AsyncJobsSnapshot,
} from "./async-jobs";

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bg_1",
    type: "bash",
    status: "running",
    label: "sleep 30",
    command: "sleep 30",
    cwd: "/tmp/scratch",
    startTime: 1_761_000_000_000,
    endTime: null,
    agentId: null,
    ownerId: null,
    pids: [4242],
    exitCode: null,
    outputTail: "",
    outputTruncated: false,
    widget: null,
    completionPercent: null,
    stage: null,
    ...overrides,
  };
}

/** A pre-#954 (v1/v2) wire job: no live-widget keys at all (the hybrid rule). */
function legacyJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const bare: Record<string, unknown> = job();
  delete bare.widget;
  delete bare.completionPercent;
  delete bare.stage;
  return { ...bare, ...overrides };
}

/** A finished legacy job for the recent list. */
function legacyRecent(): Record<string, unknown> {
  return legacyJob({ id: "bg_2", status: "completed", endTime: 1_761_000_010_000, pids: [], exitCode: 0, outputTail: "done" });
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: ASYNC_JOBS_SNAPSHOT_VERSION,
    processKey: "omp-ui-mc0abcd-xyz",
    revision: 3,
    available: true,
    unavailable: null,
    canInspect: true,
    canCancel: true,
    running: [job()],
    recent: [
      job({
        id: "bg_2",
        status: "completed",
        endTime: 1_761_000_010_000,
        pids: [],
        exitCode: 0,
        outputTail: "done",
      }),
    ],
    rootId: null,
    agents: [],
    result: null,
    ...overrides,
  };
}

function publish(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(snapshot(overrides));
}

/** The #868 envelope shape: version 2, tree keys, legacy jobs. */
function snapshotV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return snapshot({ version: 2, running: [legacyJob()], recent: [legacyRecent()], ...overrides });
}

/** The pre-#868 envelope shape: version 1, no tree keys at all. */
function snapshotV1(): Record<string, unknown> {
  const { rootId: _rootId, agents: _agents, ...flat } = snapshotV2();
  return { ...flat, version: 1 };
}

/** Every widget block kind, valid per the v3 parser. */
const allBlocksWidget = {
  title: "Migration",
  headline: { text: "412", label: "files", trend: { text: "+12", tone: "success" } },
  stage: "migrating schema",
  blocks: [
    { kind: "spark", label: "rate", values: [1, 3, 2], min: 0, max: 5, last: "2/s", marks: [{ value: 4, label: "goal", tone: "accent" }], tone: null },
    { kind: "bars", label: "by dir", items: [{ label: "src", value: 3, text: "3", tone: "info" }], max: 10 },
    { kind: "meter", label: "done", value: 0.5, text: "50%", tone: "pending" },
    { kind: "stat", items: [{ label: "errors", text: "0", trend: null }, { label: "warn", text: "2", trend: { text: "-1", tone: "warning" } }] },
  ],
  updatedAt: 1_761_000_005_000,
};
const textGridWidget = {
  title: "Scan",
  headline: null,
  stage: null,
  blocks: [
    { kind: "grid", label: "hosts", items: [{ label: "a", text: "up", tone: "success" }] },
    { kind: "text", text: "scanning" },
  ],
  updatedAt: 1_761_000_006_000,
};

describe("parseAsyncJobsSnapshot", () => {
  it("parses running, recent, and a kill result to an equal object", () => {
    const text = publish({
      result: { requestId: "req-1", ok: true, cancelled: ["bg_1"], text: "Cancelled background job bg_1." },
    });
    const parsed = parseAsyncJobsSnapshot(text);
    expect(parsed).not.toBeNull();
    expect(parsed as AsyncJobsSnapshot).toEqual(JSON.parse(text));
  });

  it("maps a legacy v1 envelope to a flat v3 snapshot", () => {
    const parsed = parseAsyncJobsSnapshot(JSON.stringify(snapshotV1()));
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(ASYNC_JOBS_SNAPSHOT_VERSION);
    expect(parsed!.rootId).toBeNull();
    expect(parsed!.agents).toEqual([]);
    expect(parsed!.running).toHaveLength(1);
    expect(parsed!.running[0]!.widget).toBeNull();
  });

  it("parses a v3 job's live widget, completion estimate, and stage", () => {
    const text = publish({
      running: [
        job({ type: "task", agentId: "A", widget: allBlocksWidget, completionPercent: 42, stage: "writing tests" }),
        job({ id: "bg_3", widget: textGridWidget }),
      ],
    });
    const parsed = parseAsyncJobsSnapshot(text);
    expect(parsed).not.toBeNull();
    expect(parsed as AsyncJobsSnapshot).toEqual(JSON.parse(text));
    expect(parsed!.running[0]!.completionPercent).toBe(42);
    expect(parsed!.running[0]!.widget!.blocks.map((block) => block.kind)).toEqual(["spark", "bars", "meter", "stat"]);
    expect(parsed!.running[1]!.widget!.blocks.map((block) => block.kind)).toEqual(["grid", "text"]);
  });

  it("a v2 job parses with null live fields; a v2 job carrying a v3 key is malformed", () => {
    const parsed = parseAsyncJobsSnapshot(JSON.stringify(snapshotV2({ rootId: "root" })));
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(ASYNC_JOBS_SNAPSHOT_VERSION);
    expect(parsed!.rootId).toBe("root");
    expect(parsed!.running[0]).toMatchObject({ widget: null, completionPercent: null, stage: null });
    expect(parsed!.recent[0]).toMatchObject({ widget: null, completionPercent: null, stage: null });
    expect(parseAsyncJobsSnapshot(JSON.stringify(snapshotV2({ running: [legacyJob({ stage: null })] })))).toBeNull();
    expect(parseAsyncJobsSnapshot(JSON.stringify(snapshotV2({ running: [legacyJob({ completionPercent: 5 })] })))).toBeNull();
  });

  it.each([
    ["a missing widget key", (() => { const bare = job(); delete bare.widget; return bare; })()],
    ["an unknown tone", job({ widget: { ...textGridWidget, blocks: [{ kind: "grid", label: "h", items: [{ label: "a", text: "up", tone: "loud" }] }] } })],
    ["a meter value of 1.5", job({ widget: { ...textGridWidget, blocks: [{ kind: "meter", label: "m", value: 1.5, text: "150%", tone: null }] } })],
    ["a spark with max <= min", job({ widget: { ...textGridWidget, blocks: [{ kind: "spark", label: "s", values: [1], min: 5, max: 5, last: "1", marks: [], tone: null }] } })],
    ["a spark with empty values", job({ widget: { ...textGridWidget, blocks: [{ kind: "spark", label: "s", values: [], min: 0, max: 5, last: "", marks: [], tone: null }] } })],
    ["a block of kind pie", job({ widget: { ...textGridWidget, blocks: [{ kind: "pie", label: "p" }] } })],
    ["five blocks", job({ widget: { ...textGridWidget, blocks: Array.from({ length: 5 }, () => ({ kind: "text", text: "x" })) } })],
    ["a title over 200 chars", job({ widget: { ...textGridWidget, title: "t".repeat(201) } })],
    ["completionPercent 12.5", job({ completionPercent: 12.5 })],
    ["completionPercent 101", job({ completionPercent: 101 })],
    ["completionPercent -1", job({ completionPercent: -1 })],
    ["an empty stage", job({ stage: "" })],
    ["an empty widget", job({ widget: { title: "Empty", headline: null, stage: null, blocks: [], updatedAt: 1 } })],
  ])("rejects a malformed v3 job: %s", (_name, running) => {
    expect(parseAsyncJobsSnapshot(publish({ running: [running] }))).toBeNull();
  });

  it("reads ownerId, treating an absent key (omp's undefined) as null", () => {
    const bare = job();
    delete bare.ownerId;
    const parsed = parseAsyncJobsSnapshot(publish({ running: [bare, job({ id: "bg_9", ownerId: "agent-1" })] }));
    expect(parsed!.running.map((entry) => entry.ownerId)).toEqual([null, "agent-1"]);
  });

  it("parses the agent roster with its parent edges", () => {
    const parsed = parseAsyncJobsSnapshot(
      publish({ rootId: "root", agents: [{ id: "a-1", parentId: "root" }, { id: "a-2", parentId: null }] }),
    );
    expect(parsed!.rootId).toBe("root");
    expect(parsed!.agents).toEqual([
      { id: "a-1", parentId: "root" },
      { id: "a-2", parentId: null },
    ]);
  });

  it.each([
    ["an unknown status", publish({ running: [job({ status: "paused" })] })],
    ["an empty id", publish({ running: [job({ id: "" })] })],
    ["a non-integer pid", publish({ running: [job({ pids: [1.5] })] })],
    ["revision 0", publish({ revision: 0 })],
    ["a missing canCancel", publish({ canCancel: undefined })],
    ["a result without requestId", publish({ result: { ok: true, cancelled: [], text: "x" } })],
    ["an ownerId of the wrong type", publish({ running: [job({ ownerId: 7 })] })],
    ["agents that is not an array", publish({ agents: { id: "a" } })],
    ["an agent without a parentId key", publish({ agents: [{ id: "a-1" }] })],
    ["an agent with a numeric parentId", publish({ agents: [{ id: "a-1", parentId: 2 }] })],
    ["an agent with an empty id", publish({ agents: [{ id: "", parentId: null }] })],
    ["a v1 hybrid carrying v2 tree keys", JSON.stringify({ ...snapshotV2(), version: 1 })],
    ["version 4", publish({ version: 4 })],
    ["invalid JSON", "{not json"],
    ["undefined", undefined as unknown as string],
  ])("rejects %s", (_name, text) => {
    expect(parseAsyncJobsSnapshot(text)).toBeNull();
  });
});

/** Layout tests read id/status/startTime/agentId/ownerId only. */
function rowJob(id: string, overrides: Partial<AsyncJob> = {}): AsyncJob {
  return {
    id,
    type: "bash",
    status: "running",
    label: "",
    command: null,
    cwd: null,
    startTime: 1_761_000_000_000,
    endTime: null,
    agentId: null,
    ownerId: null,
    pids: [],
    exitCode: null,
    outputTail: "",
    outputTruncated: false,
    widget: null,
    completionPercent: null,
    stage: null,
    ...overrides,
  };
}

function agent(id: string, parentId: string | null): AsyncJobAgent {
  return { id, parentId };
}

describe("buildAsyncJobRows", () => {
  it("nests a subagent's job under its task job", () => {
    const task = rowJob("t1", { type: "task", agentId: "a-1" });
    const child = rowJob("bg_7", { ownerId: "a-1" });
    expect(buildAsyncJobRows([task, child], [], [agent("a-1", "root")], "root")).toEqual([
      { job: task, depth: 0 },
      { job: child, depth: 1 },
    ]);
  });

  it("renders an empty roster flat in omp order (the v1 shape)", () => {
    const a = rowJob("r1");
    const b = rowJob("f1", { status: "completed" });
    expect(buildAsyncJobRows([a], [b], [], null)).toEqual([
      { job: a, depth: 0 },
      { job: b, depth: 0 },
    ]);
  });

  it("features running jobs and prefers newer non-running features", () => {
    const olderDone = rowJob("t-old", { type: "task", agentId: "a-1", status: "completed", startTime: 5 });
    const newerRunning = rowJob("t-new", { type: "task", agentId: "a-1", status: "running", startTime: 9 });
    const child = rowJob("bg_1", { ownerId: "a-1" });
    const rows = buildAsyncJobRows([olderDone, newerRunning, child], [], [agent("a-1", "root")], "root");
    // The node features the running job; the evicted-style older sibling hangs top-level.
    expect(rows).toEqual([
      { job: newerRunning, depth: 0 },
      { job: child, depth: 1 },
      { job: olderDone, depth: 0 },
    ]);
  });

  it("sorts siblings branchiest-first, then running, then oldest start", () => {
    // Branchiest-first: a-big owns a child node, so it sorts before the
    // smaller leaf branch even though it started later. (mP leaves the top
    // list in wire order, so the sort is asserted at depth 1.)
    const small = rowJob("t-small", { type: "task", agentId: "a-small", startTime: 1 });
    const bigParent = rowJob("t-big", { type: "task", agentId: "a-big", startTime: 50 });
    const deepLeaf = rowJob("bg-leaf", { ownerId: "a-deep" });
    const midBranch = rowJob("t-mid", { type: "task", agentId: "a-deep", ownerId: "a-big", startTime: 60 });
    // a-older is running and started before a-deep's subtree, but its branch
    // is smaller: size must outrank the running/startTime keys.
    const olderLeaf = rowJob("t-older", { type: "task", agentId: "a-older", ownerId: "a-big", startTime: 51 });
    const rows = buildAsyncJobRows(
      [small, bigParent, deepLeaf, midBranch, olderLeaf],
      [],
      [agent("a-big", "root"), agent("a-small", "root"), agent("a-deep", "a-big"), agent("a-older", "a-big")],
      "root",
    );
    expect(rows.map((entry) => [entry.job.id, entry.depth])).toEqual([
      // Top list keeps mP's insertion order (roster nodes first); the sort
      // fires on a-big's children: a-deep's branch (size 1) before the
      // running-but-leaf a-older.
      ["t-big", 0],
      ["t-mid", 1],
      ["bg-leaf", 2],
      ["t-older", 1],
      ["t-small", 0],
    ]);
  });

  it("hangs jobs with unknown owners at depth 0", () => {
    const ghost = rowJob("bg_3", { ownerId: "gone" });
    expect(buildAsyncJobRows([ghost], [], [agent("a-1", "root")], "root")).toEqual([
      { job: ghost, depth: 0 },
    ]);
  });

  it("falls back to the flat list when the agent roster cycles", () => {
    const a = rowJob("t1", { type: "task", agentId: "x" });
    const b = rowJob("bg_2", { ownerId: "y" });
    expect(buildAsyncJobRows([a], [b], [agent("x", "y"), agent("y", "x")], "root")).toEqual([
      { job: a, depth: 0 },
      { job: b, depth: 0 },
    ]);
  });

  it("passes depth through an agent node whose task job was evicted", () => {
    const child = rowJob("bg_9", { ownerId: "a-1" });
    // No featured job on a-1's node: omp prints the bare agent row; the pane
    // has no agent rows, so its children render at the parent's depth.
    expect(buildAsyncJobRows([child], [], [agent("a-1", "root")], "root")).toEqual([
      { job: child, depth: 0 },
    ]);
  });
});

describe("wire messages", () => {
  it("arms with the bare hidden command", () => {
    expect(asyncJobsArmMessage()).toBe("/omp-ui-async-jobs");
  });

  it("sends a kill as the command with the JSON request", () => {
    const message = asyncJobsKillMessage({
      requestId: "req-9",
      processKey: "omp-ui-a-b",
      jobId: "bg_1",
      startTime: 123,
    });
    expect(message).toBe(
      '/omp-ui-async-jobs kill {"requestId":"req-9","processKey":"omp-ui-a-b","jobId":"bg_1","startTime":123}',
    );
  });
});
