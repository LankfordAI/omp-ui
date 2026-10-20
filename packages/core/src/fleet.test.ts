import { describe, expect, it } from "vitest";
import {
  choosePlacement,
  FLEET_PROMPT_MAX,
  parseFleetDispatchRequest,
  parseFleetSpawnSpec,
  placementScore,
  type FleetHostReport,
  type PlacementCandidate,
} from "./fleet";

const NOW = 1_000_000;

function report(patch: Partial<FleetHostReport> = {}): FleetHostReport {
  return {
    instanceId: "instance-a",
    label: "box",
    version: "0.30.0",
    platform: "linux",
    arch: "x64",
    cpuCount: 8,
    cpuUtilization: 0.5,
    totalMemoryBytes: 1_000,
    availableMemoryBytes: 500,
    liveSessions: 0,
    runningTurns: 0,
    sampledAt: NOW,
    projects: [],
    ...patch,
  };
}

function candidate(machineKey: string, patch: Partial<PlacementCandidate> = {}, reportPatch: Partial<FleetHostReport> = {}): PlacementCandidate {
  return { machineKey, projectCwd: `/${machineKey}/proj`, weight: 50, report: report(reportPatch), receivedAt: NOW, ...patch };
}

describe("placementScore", () => {
  it("scores an eligible report as weight * cores * idle CPU * free memory", () => {
    expect(placementScore(candidate("a"), NOW)).toBe(50 * 8 * 0.5 * 0.5);
  });

  it.each([
    ["a report 15001 ms old", candidate("a", { receivedAt: NOW - 15_001 })],
    ["a report 5001 ms in the future", candidate("a", { receivedAt: NOW + 5_001 })],
    ["CPU at 0.95", candidate("a", {}, { cpuUtilization: 0.95 })],
    ["memory exactly 5% free", candidate("a", {}, { availableMemoryBytes: 50 })],
    ["weight 0", candidate("a", { weight: 0 })],
    ["unknown CPU", candidate("a", {}, { cpuUtilization: null })],
    ["zero cores", candidate("a", {}, { cpuCount: 0 })],
    ["no report", candidate("a", { report: null })],
  ])("is 0 for %s", (_label, c) => {
    expect(placementScore(c, NOW)).toBe(0);
  });

  it.each([
    ["a report exactly 15000 ms old", candidate("a", { receivedAt: NOW - 15_000 })],
    ["a report exactly 5000 ms in the future", candidate("a", { receivedAt: NOW + 5_000 })],
    ["CPU just under 0.95", candidate("a", {}, { cpuUtilization: 0.949 })],
    ["memory just over 5% free", candidate("a", {}, { availableMemoryBytes: 51 })],
  ])("stays above 0 at %s", (_label, c) => {
    expect(placementScore(c, NOW)).toBeGreaterThan(0);
  });
});

describe("choosePlacement", () => {
  it("puts the higher score first", () => {
    const busy = candidate("busy", {}, { cpuUtilization: 0.9 });
    const idle = candidate("idle", {}, { cpuUtilization: 0.1 });
    expect(choosePlacement([busy, idle], NOW, 2).map((c) => c.machineKey)).toEqual(["idle", "busy"]);
  });

  it("keeps input order on a tie", () => {
    expect(choosePlacement([candidate("b"), candidate("a")], NOW, 2).map((c) => c.machineKey)).toEqual(["b", "a"]);
  });

  it("picks distinct machines, the best project of each", () => {
    const best = candidate("a", { projectCwd: "/a/best", weight: 100 });
    const worse = candidate("a", { projectCwd: "/a/worse" });
    const other = candidate("b");
    expect(choosePlacement([worse, other, best], NOW, 2).map((c) => [c.machineKey, c.projectCwd])).toEqual([
      ["a", "/a/best"],
      ["b", "/b/proj"],
    ]);
  });

  it("returns [] when fewer eligible machines than copies remain", () => {
    const cands = [candidate("a"), candidate("a", { projectCwd: "/a/other" }), candidate("b", { weight: 0 })];
    expect(choosePlacement(cands, NOW, 2)).toEqual([]);
  });
});

const spec = {
  dispatchId: "dispatch-1",
  batchId: "batch-1",
  title: "Fix the login bug",
  prompt: "Fix the login bug.",
  requestedBy: { instanceId: "instance-a", label: "laptop", kind: "agent", sourceTabId: "tab-src" },
};

describe("parseFleetSpawnSpec", () => {
  it("returns a well-shaped spec unchanged", () => {
    expect(parseFleetSpawnSpec(spec)).toEqual(spec);
  });

  it.each([
    ["an unknown key", { ...spec, extra: 1 }],
    ["a blank prompt", { ...spec, prompt: " \n " }],
    ["a prompt over the limit", { ...spec, prompt: "x".repeat(FLEET_PROMPT_MAX + 1) }],
    ["a title with control characters", { ...spec, title: "Fix\u0007bug" }],
    ["a bad requester kind", { ...spec, requestedBy: { ...spec.requestedBy, kind: "robot" } }],
    ["an extra requestedBy key", { ...spec, requestedBy: { ...spec.requestedBy, prompt: "x" } }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseFleetSpawnSpec(raw)).toThrow(/spawn request\.fleet/);
  });
});

const pick = (machineKey: string, projectCwd = "/proj") => ({ machineKey, projectCwd });
const request = {
  targets: { kind: "explicit", picks: [pick("local")] },
  prompt: "Fix the login bug.",
  title: null,
  workspace: "worktree",
  planMode: false,
};

describe("parseFleetDispatchRequest", () => {
  it("accepts several copies on one machine in new worktrees", () => {
    const raw = { ...request, targets: { kind: "explicit", picks: [pick("local"), pick("local")] } };
    expect(parseFleetDispatchRequest(raw)).toEqual(raw);
  });

  it("accepts a retry of one explicit pick", () => {
    const raw = { ...request, retryOf: { dispatchId: "dispatch-1", batchId: null } };
    expect(parseFleetDispatchRequest(raw)).toEqual(raw);
  });

  it.each([
    [
      "two checkout picks on one machine and project",
      { ...request, workspace: "checkout", targets: { kind: "explicit", picks: [pick("local"), pick("local")] } },
    ],
    [
      "several auto copies in the checkout",
      { ...request, workspace: "checkout", targets: { kind: "auto", reference: pick("local"), count: 2 } },
    ],
    [
      "a retry of an auto target",
      { ...request, targets: { kind: "auto", reference: pick("local"), count: 1 }, retryOf: { dispatchId: "d", batchId: null } },
    ],
    [
      "a retry of two explicit picks",
      { ...request, targets: { kind: "explicit", picks: [pick("local"), pick("remote-1")] }, retryOf: { dispatchId: "d", batchId: "b" } },
    ],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseFleetDispatchRequest(raw)).toThrow();
  });
});
