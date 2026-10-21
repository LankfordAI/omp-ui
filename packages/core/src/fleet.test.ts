import { describe, expect, it } from "vitest";
import {
  choosePlacement,
  FLEET_COMMAND_MAX,
  FLEET_PROMPT_MAX,
  FLEET_TOOLS,
  fleetMemberAddress,
  formatFleetMachines,
  LOCAL_MACHINE_KEY,
  parseFleetDispatchRequest,
  parseFleetExecRequest,
  parseFleetGrants,
  parseFleetProjectManageRequest,
  parseFleetProjectRoots,
  parseFleetSpawnSpec,
  parseFleetToolArguments,
  placementScore,
  validateFleetCommand,
  type FleetHostReport,
  type FleetMachine,
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
    user: "austin",
    projectRoots: [],
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

describe("fleet exec ladder contracts (issue #901)", () => {
  const requester = { instanceId: "inst-a", label: "studio", kind: "agent", sourceTabId: "tab-1" } as const;

  it("exposes the five agent tools in registration order", () => {
    expect(FLEET_TOOLS).toEqual(["omp-ui_fleet_machines", "omp-ui_fleet_dispatch", "omp-ui_fleet_status", "omp-ui_fleet_exec", "omp-ui_fleet_project"]);
  });

  it("allows newline (LF or CRLF) and tab in a command but no other control character", () => {
    expect(validateFleetCommand("ls\n\tpwd")).toBe("ls\n\tpwd");
    expect(validateFleetCommand("dir\r\nver")).toBe("dir\r\nver");
    for (const bad of ["", "   ", "echo \u0000", "printf \u001b[2J", "a\u007fb", "x".repeat(FLEET_COMMAND_MAX + 1)]) {
      expect(() => validateFleetCommand(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("parses an exec request strictly: no extra keys, no env, numeric timeout", () => {
    expect(parseFleetExecRequest({ requester, command: "uname", cwd: null, timeoutMs: 500 })).toEqual({ requester, command: "uname", cwd: null, timeoutMs: 500 });
    expect(() => parseFleetExecRequest({ requester, command: "uname", env: { PATH: "/tmp" } })).toThrow();
    expect(() => parseFleetExecRequest({ requester, command: "uname", timeoutMs: "5" })).toThrow();
    expect(() => parseFleetExecRequest({ requester, command: "uname", cwd: "" })).toThrow();
    expect(() => parseFleetExecRequest({ command: "uname" })).toThrow();
  });

  it("parses project manage with exactly the verb-matched field", () => {
    expect(parseFleetProjectManageRequest({ requester, verb: "clone", repositoryUrl: " https://github.com/acme/app " })).toEqual({
      requester,
      verb: "clone",
      repositoryUrl: "https://github.com/acme/app",
    });
    expect(parseFleetProjectManageRequest({ requester, verb: "register", path: "/srv/app" })).toEqual({ requester, verb: "register", path: "/srv/app" });
    expect(() => parseFleetProjectManageRequest({ requester, verb: "clone", path: "/srv/app" })).toThrow();
    expect(() => parseFleetProjectManageRequest({ requester, verb: "register", repositoryUrl: "https://x/y", path: "/srv/app" })).toThrow();
    expect(() => parseFleetProjectManageRequest({ requester, verb: "delete", path: "/srv/app" })).toThrow();
  });

  it("keeps only well-formed grant records, a missing rung included", () => {
    const grants = parseFleetGrants({
      good: { rung: "manage", label: "studio", updatedAt: "t" },
      named: { label: "laptop", updatedAt: "t" },
      badRung: { rung: "root", label: "x", updatedAt: "t" },
      extraKey: { rung: "full", label: "x", updatedAt: "t", credential: "secret" },
      noLabel: { rung: "full", updatedAt: "t" },
      scalar: "full",
      ["k".repeat(200)]: { rung: "full", label: "x", updatedAt: "t" },
    });
    expect(grants).toEqual({ good: { rung: "manage", label: "studio", updatedAt: "t" }, named: { label: "laptop", updatedAt: "t" } });
    expect(parseFleetGrants([1, 2])).toEqual({});
  });

  it("keeps only absolute project roots", () => {
    expect(parseFleetProjectRoots(["/srv/repos", "C:\\repos", "D:/code", "\\\\nas\\share", "relative/dir", "/", "", 3, "/bad\u0000root"])).toEqual([
      "/srv/repos",
      "C:\\repos",
      "D:/code",
      "\\\\nas\\share",
    ]);
    expect(parseFleetProjectRoots("not an array")).toEqual([]);
  });

  it("parses the exec and project tool arguments with plain refusals", () => {
    expect(parseFleetToolArguments("omp-ui_fleet_exec", { machine: " studio ", command: "uname", timeoutMs: 500 })).toEqual({
      ok: true,
      tool: "exec",
      args: { machine: "studio", command: "uname", cwd: null, timeoutMs: 500 },
    });
    expect(parseFleetToolArguments("omp-ui_fleet_exec", { machine: "studio", command: "ls", env: {} })).toEqual({ ok: false, reason: 'unknown argument "env"' });
    expect(parseFleetToolArguments("omp-ui_fleet_exec", { machine: "studio", command: "ls", timeoutMs: 0 })).toEqual({ ok: false, reason: "timeoutMs must be positive" });
    expect(parseFleetToolArguments("omp-ui_fleet_project", { machine: "studio", verb: "clone", path: "/x" })).toEqual({
      ok: false,
      reason: "clone needs repositoryUrl",
    });
    expect(parseFleetToolArguments("omp-ui_fleet_project", { machine: "studio", verb: "register", path: "/srv/app" })).toEqual({
      ok: true,
      tool: "project",
      args: { machine: "studio", verb: "register", repositoryUrl: null, path: "/srv/app" },
    });
  });

  it("reports a member's rung in the machines answer, never this computer's", () => {
    const machine = (key: string, nickname: string | null, grantRung: FleetMachine["grantRung"]): FleetMachine => ({
      key,
      nickname,
      status: "ready",
      error: null,
      preference: "normal",
      receivedAt: NOW,
      grantRung,
      report: report(),
      address: key === LOCAL_MACHINE_KEY ? null : "10.0.0.5",
      sshReachable: null,
    });
    const text = formatFleetMachines([machine(LOCAL_MACHINE_KEY, null, "full"), machine("r1", "studio", "manage"), machine("r2", "old", null)]);
    const [local, studio, old] = text.split("\n").filter((line) => line.startsWith("- "));
    expect(local).not.toContain("access");
    expect(studio).toMatch(/; access manage$/);
    expect(old).not.toContain("access");
  });
});

describe("member address and ssh line (issue #904)", () => {
  it("takes the join URL's hostname, IPv6 brackets stripped", () => {
    expect(fleetMemberAddress("http://box.tailnet:4677")).toBe("box.tailnet");
    expect(fleetMemberAddress("https://[fe80::1]:4677")).toBe("fe80::1");
    expect(fleetMemberAddress("not a url")).toBeNull();
  });

  const machine = (patch: Partial<FleetMachine>, reportPatch: Partial<FleetHostReport> = {}): FleetMachine => ({
    key: "r1",
    nickname: "studio",
    status: "ready",
    error: null,
    preference: "normal",
    receivedAt: NOW,
    grantRung: null,
    report: report({
      projects: [{ path: "/srv/repos/app", name: "app", repositoryKey: null, headCommit: null, providerReady: true, advisor: false, advisorModel: null }],
      ...reportPatch,
    }),
    address: "10.0.0.5",
    sshReachable: true,
    ...patch,
  });

  it("prints the ssh target, probe, platform, and roots right after the member's machine line", () => {
    const lines = formatFleetMachines([
      machine({ key: LOCAL_MACHINE_KEY, nickname: null, address: null, sshReachable: null }),
      machine({}, { user: "austin", projectRoots: ["/srv/repos"] }),
      machine({ key: "r2", nickname: "two", address: "10.0.0.6", sshReachable: false }, { user: null, projectRoots: [] }),
      machine({ key: "r3", nickname: "three", address: "10.0.0.8", sshReachable: null }, { projectRoots: null }),
      machine({ key: "r4", nickname: "four", address: "10.0.0.7", status: "unreachable", error: null, report: null, sshReachable: null }),
    ]).split("\n");
    expect(lines[0]).toMatch(/^- this computer: ready/);
    expect(lines[1]).toBe("  - /srv/repos/app (no repository key)");
    expect(lines[2]).toMatch(/^- studio: ready/);
    expect(lines[3]).toBe("  ssh: austin@10.0.0.5 (port 22 open); platform linux x64; project roots: /srv/repos");
    expect(lines[4]).toBe("  - /srv/repos/app (no repository key)");
    expect(lines[5]).toMatch(/^- two: ready/);
    expect(lines[6]).toBe("  ssh: 10.0.0.6 (port 22 closed); platform linux x64; project roots: none declared");
    expect(lines[8]).toMatch(/^- three: ready/);
    expect(lines[9]).toBe("  ssh: austin@10.0.0.8 (port 22 not checked); platform linux x64; project roots: not reported");
    expect(lines[11]).toBe("- four: unreachable; preference normal");
    expect(lines[12]).toBe("  address: 10.0.0.7 (not connected)");
    expect(lines).toHaveLength(13);
  });
});
