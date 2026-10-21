import { describe, expect, it } from "vitest";
import {
  choosePlacement,
  FLEET_COMMAND_MAX,
  FLEET_EXEC_POLL_WAIT_MAX_MS,
  FLEET_PROMPT_MAX,
  FLEET_TOOLS,
  FLEET_VERSION_PATTERN,
  fleetAppUpdateAvailable,
  fleetMemberAddress,
  fleetOsLabel,
  fleetToolExecPollRequest,
  fleetToolExecRequest,
  fleetToolUpdateRequest,
  fleetVersionsLine,
  formatFleetMachines,
  LOCAL_MACHINE_KEY,
  parseFleetDetachedExecRequest,
  parseFleetDispatchRequest,
  parseFleetExecPollRequest,
  parseFleetExecRequest,
  parseFleetGrants,
  parseFleetHostOs,
  parseFleetPackageManagers,
  parseFleetProjectManageRequest,
  parseFleetProjectRoots,
  parseFleetProviderKeysRequest,
  parseFleetSpawnSpec,
  parseFleetToolArguments,
  parseFleetUpdateFacts,
  parseFleetUpdateMemberRequest,
  parseFleetUpdatePollRequest,
  parseFleetUpdateRequest,
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
    os: { name: "Fedora Linux 44 (Workstation Edition)", version: "44" },
    packageManagers: [
      { name: "dnf", path: "/usr/bin/dnf", onPath: true },
      { name: "flatpak", path: "/usr/bin/flatpak", onPath: true },
      { name: "brew", path: "/home/linuxbrew/.linuxbrew/bin/brew", onPath: false },
    ],
    ompVersion: null,
    ompPath: null,
    ompPinned: false,
    ompBelowMinimum: false,
    packageFormat: null,
    appLatestVersion: null,
    appUpdateStaged: false,
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

  it("exposes the seven agent tools in registration order", () => {
    expect(FLEET_TOOLS).toEqual([
      "omp-ui_fleet_machines",
      "omp-ui_fleet_dispatch",
      "omp-ui_fleet_status",
      "omp-ui_fleet_exec",
      "omp-ui_fleet_project",
      "omp-ui_fleet_exec_poll",
      "omp-ui_fleet_update",
    ]);
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
      args: { machine: "studio", command: "uname", cwd: null, timeoutMs: 500, detach: false },
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
      maintenance: null,
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
    maintenance: null,
    ...patch,
  });

  it("prints the ssh and system lines right after the member's machine line", () => {
    const lines = formatFleetMachines([
      machine({ key: LOCAL_MACHINE_KEY, nickname: null, address: null, sshReachable: null }),
      machine({}, { user: "austin", projectRoots: ["/srv/repos"] }),
      machine({ key: "r2", nickname: "two", address: "10.0.0.6", sshReachable: false }, { user: null, projectRoots: [], packageManagers: [] }),
      machine({ key: "r3", nickname: "three", address: "10.0.0.8", sshReachable: null }, { projectRoots: null, os: null, packageManagers: null }),
      machine({ key: "r4", nickname: "four", address: "10.0.0.7", status: "unreachable", error: null, report: null, sshReachable: null }),
    ]).split("\n");
    expect(lines[0]).toMatch(/^- this computer: ready/);
    expect(lines[1]).toBe("  versions: omp-ui 0.30.0, omp not reported");
    expect(lines[2]).toBe("  - /srv/repos/app (no repository key)");
    expect(lines[3]).toMatch(/^- studio: ready/);
    expect(lines[4]).toBe("  versions: omp-ui 0.30.0, omp not reported");
    expect(lines[5]).toBe("  ssh: austin@10.0.0.5 (port 22 open); platform linux x64; project roots: /srv/repos");
    expect(lines[6]).toBe(
      "  system: Fedora Linux 44 (Workstation Edition); package managers: dnf, flatpak, brew at /home/linuxbrew/.linuxbrew/bin/brew",
    );
    expect(lines[7]).toBe("  - /srv/repos/app (no repository key)");
    expect(lines[8]).toMatch(/^- two: ready/);
    expect(lines[9]).toBe("  versions: omp-ui 0.30.0, omp not reported");
    expect(lines[10]).toBe("  ssh: 10.0.0.6 (port 22 closed); platform linux x64; project roots: none declared");
    expect(lines[11]).toBe("  system: Fedora Linux 44 (Workstation Edition); package managers: none found");
    expect(lines[13]).toMatch(/^- three: ready/);
    expect(lines[14]).toBe("  versions: omp-ui 0.30.0, omp not reported");
    expect(lines[15]).toBe("  ssh: austin@10.0.0.8 (port 22 not checked); platform linux x64; project roots: not reported");
    expect(lines[16]).toBe("  system: not reported; package managers: not reported");
    expect(lines[18]).toBe("- four: unreachable; preference normal");
    expect(lines[19]).toBe("  address: 10.0.0.7 (not connected)");
    expect(lines).toHaveLength(20);
  });

  it("prints the system line for a ready member without an address (no ssh line)", () => {
    const lines = formatFleetMachines([machine({ address: null, sshReachable: null }, { os: { name: "macOS", version: "15.1" } })]).split("\n");
    expect(lines).toEqual([
      expect.stringMatching(/^- studio: ready/),
      "  versions: omp-ui 0.30.0, omp not reported",
      "  system: macOS 15.1; package managers: dnf, flatpak, brew at /home/linuxbrew/.linuxbrew/bin/brew",
      "  - /srv/repos/app (no repository key)",
    ]);
  });
});

describe("member OS and package managers (issue #905)", () => {
  it("appends the version to the OS label only when the name lacks it", () => {
    expect(fleetOsLabel({ name: "Fedora Linux 44 (Workstation Edition)", version: "44" })).toBe("Fedora Linux 44 (Workstation Edition)");
    expect(fleetOsLabel({ name: "macOS", version: "15.1" })).toBe("macOS 15.1");
    expect(fleetOsLabel({ name: "Windows 11 Pro", version: null })).toBe("Windows 11 Pro");
  });

  it("shape-checks a remote report's os", () => {
    expect(parseFleetHostOs({ name: "macOS", version: "15.1" })).toEqual({ name: "macOS", version: "15.1" });
    expect(parseFleetHostOs({ name: "Linux", version: null })).toEqual({ name: "Linux", version: null });
    expect(parseFleetHostOs(undefined)).toBeNull();
    expect(parseFleetHostOs({ name: "", version: null })).toBeNull();
    expect(parseFleetHostOs({ name: "x".repeat(129), version: null })).toBeNull();
    expect(parseFleetHostOs({ name: "bad\u0007name", version: null })).toBeNull();
    expect(parseFleetHostOs({ name: "Linux", version: "1".repeat(65) })).toBeNull();
    expect(parseFleetHostOs({ name: "Linux", version: 44 })).toBeNull();
  });

  it("drops invalid package-manager entries and keeps at most 16", () => {
    const good = { name: "dnf", path: "/usr/bin/dnf", onPath: true };
    expect(
      parseFleetPackageManagers([
        good,
        { name: "Brew", path: "/opt/homebrew/bin/brew", onPath: false },
        { name: "brew", path: "", onPath: false },
        { name: "brew", path: "/bad\u0000path", onPath: false },
        { name: "brew", path: "/opt/homebrew/bin/brew", onPath: "no" },
        null,
        "dnf",
        { name: "port", path: "/opt/local/bin/port", onPath: false },
      ]),
    ).toEqual([good, { name: "port", path: "/opt/local/bin/port", onPath: false }]);
    expect(parseFleetPackageManagers(Array.from({ length: 20 }, () => good))).toHaveLength(16);
    expect(parseFleetPackageManagers({ dnf: true })).toBeNull();
    expect(parseFleetPackageManagers(null)).toBeNull();
  });
});

describe("detached exec and Provider key rollout contracts (issue #905)", () => {
  const requester = { instanceId: "inst-a", label: "studio", kind: "user", sourceTabId: null } as const;
  const SECRET = "sk-test-SECRET-value-1234";

  it("parses a detached exec start with the exec request's rules", () => {
    const req = { requester, command: "dnf -y install ripgrep", cwd: null, timeoutMs: null };
    expect(parseFleetDetachedExecRequest(req)).toEqual(req);
    expect(() => parseFleetDetachedExecRequest({ ...req, detach: true })).toThrow("detached exec request contains unknown field detach");
    expect(() => parseFleetDetachedExecRequest({ ...req, command: " " })).toThrow("command must not be blank");
  });

  it("parses a poll strictly", () => {
    const req = { requester, execId: "e-1", waitMs: 25_000, cancel: false };
    expect(parseFleetExecPollRequest(req)).toEqual(req);
    expect(() => parseFleetExecPollRequest({ ...req, execId: "" })).toThrow("exec poll request.execId must be a non-empty id");
    expect(() => parseFleetExecPollRequest({ ...req, execId: "x".repeat(129) })).toThrow("execId");
    expect(() => parseFleetExecPollRequest({ ...req, waitMs: Number.NaN })).toThrow("exec poll request.waitMs must be a number");
    expect(() => parseFleetExecPollRequest({ ...req, cancel: "yes" })).toThrow("exec poll request.cancel must be true or false");
  });

  it("parses a Provider key rollout and never echoes a value", () => {
    const req = { requester, keys: [{ envName: "ANTHROPIC_API_KEY", value: SECRET }] };
    expect(parseFleetProviderKeysRequest(req)).toEqual(req);
    const refusals = [
      { requester, keys: [] },
      { requester, keys: [{ envName: SECRET, value: SECRET }] },
      { requester, keys: [{ envName: "NOT_A_PROVIDER", value: SECRET }] },
      {
        requester,
        keys: [
          { envName: "ANTHROPIC_API_KEY", value: SECRET },
          { envName: "ANTHROPIC_API_KEY", value: SECRET },
        ],
      },
      { requester, keys: [{ envName: "ANTHROPIC_API_KEY", value: "" }] },
      { requester, keys: [{ envName: "ANTHROPIC_API_KEY", value: `${SECRET}${"x".repeat(8_192)}` }] },
      { requester, keys: [{ envName: "ANTHROPIC_API_KEY", value: SECRET, extra: SECRET }] },
    ];
    const messages = refusals.map((r) => {
      try {
        parseFleetProviderKeysRequest(r);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected a refusal");
    });
    for (const message of messages) expect(message).not.toContain(SECRET);
    expect(messages[1]).toBe("provider keys request.keys[0].envName is not a known provider variable");
    expect(messages[2]).toBe("provider keys request.keys[0].envName is not a known provider variable");
    expect(messages[3]).toBe("provider keys request.keys[1]: ANTHROPIC_API_KEY appears more than once");
    expect(messages[4]).toContain("the value for ANTHROPIC_API_KEY must be a non-empty string");
  });

  it("parses the detach flag and the poll tool's bounds", () => {
    expect(parseFleetToolArguments("omp-ui_fleet_exec", { machine: "studio", command: "make", detach: true })).toEqual({
      ok: true,
      tool: "exec",
      args: { machine: "studio", command: "make", cwd: null, timeoutMs: null, detach: true },
    });
    expect(parseFleetToolArguments("omp-ui_fleet_exec", { machine: "studio", command: "make", detach: "yes" })).toEqual({
      ok: false,
      reason: "detach must be true or false",
    });
    expect(parseFleetToolArguments("omp-ui_fleet_exec_poll", { machine: " studio ", execId: " e-1 " })).toEqual({
      ok: true,
      tool: "execPoll",
      args: { machine: "studio", execId: "e-1", cancel: false, waitMs: null },
    });
    expect(parseFleetToolArguments("omp-ui_fleet_exec_poll", { machine: "studio", execId: "e-1", cancel: true, waitMs: 0 })).toEqual({
      ok: true,
      tool: "execPoll",
      args: { machine: "studio", execId: "e-1", cancel: true, waitMs: 0 },
    });
    const refusal = (args: unknown) => parseFleetToolArguments("omp-ui_fleet_exec_poll", args);
    expect(refusal({ machine: "", execId: "e-1" })).toEqual({ ok: false, reason: "machine must be a non-empty string" });
    expect(refusal({ machine: "studio", execId: " " })).toEqual({ ok: false, reason: "execId must be a non-empty string" });
    expect(refusal({ machine: "studio", execId: "e-1", cancel: 1 })).toEqual({ ok: false, reason: "cancel must be true or false" });
    for (const waitMs of [-1, 25_001, 1.5, "100"]) {
      expect(refusal({ machine: "studio", execId: "e-1", waitMs })).toEqual({ ok: false, reason: "waitMs must be a whole number from 0 to 25000" });
    }
    expect(refusal({ machine: "studio", execId: "e-1", command: "ls" })).toEqual({ ok: false, reason: 'unknown argument "command"' });
  });

  it("translates the tool arguments into requests, the poll defaulting to the longest wait", () => {
    const machines: FleetMachine[] = [
      {
        key: "r1",
        nickname: "studio",
        status: "ready",
        error: null,
        preference: "normal",
        receivedAt: NOW,
        grantRung: "full",
        report: report(),
        address: "10.0.0.5",
        sshReachable: true,
        maintenance: null,
      },
    ];
    expect(fleetToolExecRequest({ machine: "Studio", command: "make", cwd: null, timeoutMs: null, detach: true }, machines)).toEqual({
      ok: true,
      machineKey: "r1",
      detach: true,
      request: { command: "make", cwd: null, timeoutMs: null },
    });
    expect(fleetToolExecPollRequest({ machine: "studio", execId: "e-1", cancel: false, waitMs: null }, machines)).toEqual({
      ok: true,
      machineKey: "r1",
      request: { execId: "e-1", waitMs: FLEET_EXEC_POLL_WAIT_MAX_MS, cancel: false },
    });
    expect(fleetToolExecPollRequest({ machine: "nope", execId: "e-1", cancel: false, waitMs: 5 }, machines).ok).toBe(false);
  });
});

describe("fleet remote version update rules", () => {
  it("accepts a plain version and a bounded prerelease, refuses everything else", () => {
    for (const good of ["1.2.3", "0.0.0", "18.13.1-rc.1", "1.2.3-" + "a".repeat(60)]) {
      expect(FLEET_VERSION_PATTERN.test(good), good).toBe(true);
    }
    for (const bad of ["", "1.2", "1.2.3.4", "v1.2.3", "1.2.3 ", "latest", "1.2.3-", "1.2.3-rc\u0007", "1.2.3-" + "a".repeat(61)]) {
      expect(FLEET_VERSION_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("answers all-null/false for an old peer's report and keeps the valid facts of a new one", () => {
    const blank = {
      ompVersion: null,
      ompPath: null,
      ompPinned: false,
      ompBelowMinimum: false,
      packageFormat: null,
      appLatestVersion: null,
      appUpdateStaged: false,
    };
    expect(parseFleetUpdateFacts({})).toEqual(blank);
    expect(parseFleetUpdateFacts(undefined)).toEqual(blank);
    expect(parseFleetUpdateFacts(null)).toEqual(blank);
    const fresh = {
      ompVersion: "18.13.1",
      ompPath: "/home/austin/.omp/bin/omp",
      ompPinned: true,
      ompBelowMinimum: true,
      packageFormat: "appimage" as const,
      appLatestVersion: "0.31.0",
      appUpdateStaged: true,
    };
    expect(parseFleetUpdateFacts(fresh)).toEqual(fresh);
  });

  it("drops garbage update facts instead of trusting the peer", () => {
    const blank = parseFleetUpdateFacts({});
    expect(
      parseFleetUpdateFacts({
        ompVersion: "latest",
        ompPath: "/bad\u0007path",
        ompPinned: "yes",
        ompBelowMinimum: 1,
        packageFormat: "snap",
        appLatestVersion: 31,
        appUpdateStaged: "true",
      }),
    ).toEqual(blank);
    expect(parseFleetUpdateFacts({ ompPath: "x".repeat(4_097) }).ompPath).toBeNull();
    expect(parseFleetUpdateFacts({ ompVersion: "1.2.3", packageFormat: "nsis" })).toEqual({
      ...blank,
      ompVersion: "1.2.3",
      packageFormat: "nsis",
    });
  });

  it("calls the app update available only when latest outranks current", () => {
    expect(fleetAppUpdateAvailable("0.30.0", "0.31.0")).toBe(true);
    expect(fleetAppUpdateAvailable("0.30.0", "0.30.0")).toBe(false);
    expect(fleetAppUpdateAvailable("0.31.0", "0.30.0")).toBe(false);
    expect(fleetAppUpdateAvailable("0.30.0", null)).toBe(false);
  });

  it("prints the versions line with parentheticals only when a fact is true", () => {
    expect(fleetVersionsLine(report())).toBe("versions: omp-ui 0.30.0, omp not reported");
    expect(fleetVersionsLine(report({ ompVersion: "18.13.1" }))).toBe("versions: omp-ui 0.30.0, omp 18.13.1");
    expect(fleetVersionsLine(report({ appLatestVersion: "0.31.0" }))).toBe(
      "versions: omp-ui 0.30.0 (update available: 0.31.0), omp not reported",
    );
    expect(fleetVersionsLine(report({ appLatestVersion: "0.31.0", appUpdateStaged: true }))).toBe(
      "versions: omp-ui 0.30.0 (update staged), omp not reported",
    );
    expect(fleetVersionsLine(report({ version: "0.31.0", appLatestVersion: "0.31.0" }))).toBe(
      "versions: omp-ui 0.31.0, omp not reported",
    );
    expect(fleetVersionsLine(report({ ompVersion: "18.9.0", ompPinned: true, ompBelowMinimum: true }))).toBe(
      "versions: omp-ui 0.30.0, omp 18.9.0 (below the harness floor | pinned)",
    );
    expect(fleetVersionsLine(report({ appLatestVersion: "0.31.0", ompPinned: true }))).toBe(
      "versions: omp-ui 0.30.0 (update available: 0.31.0), omp not reported (pinned)",
    );
  });
});

describe("fleet update request parsers", () => {
  const requester = { instanceId: "inst-a", label: "studio", kind: "agent", sourceTabId: "tab-1" } as const;

  it("accepts the full local shape and defaults version and allowLiveSessions", () => {
    expect(parseFleetUpdateRequest({ target: "app", action: "check", version: null, allowLiveSessions: true }, "req")).toEqual({
      target: "app",
      action: "check",
      version: null,
      allowLiveSessions: true,
    });
    expect(parseFleetUpdateRequest({ target: "omp", action: "stage" }, "req")).toEqual({
      target: "omp",
      action: "stage",
      version: null,
      allowLiveSessions: false,
    });
    expect(parseFleetUpdateRequest({ target: "app", action: "stage", version: "18.13.1-rc.1" }, "req").version).toBe("18.13.1-rc.1");
  });

  it.each([
    ["an unknown key", { target: "app", action: "check", extra: 1 }],
    ["a bad target", { target: "firmware", action: "check" }],
    ["a bad action", { target: "app", action: "reboot" }],
    ["omp plus apply", { target: "omp", action: "apply" }],
    ["a version on a check", { target: "app", action: "check", version: "1.2.3" }],
    ["a garbage version", { target: "app", action: "stage", version: "latest" }],
    ["a non-string version", { target: "app", action: "stage", version: 3 }],
    ["a non-boolean allowLiveSessions", { target: "app", action: "apply", allowLiveSessions: "yes" }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseFleetUpdateRequest(raw, "fleet update request")).toThrow();
  });

  it("names the exact rule it broke", () => {
    expect(() => parseFleetUpdateRequest({ target: "omp", action: "apply" }, "req")).toThrow(
      "the omp binary installs as it downloads; there is no separate apply for it",
    );
    expect(() => parseFleetUpdateRequest({ target: "app", action: "check", version: "1.2.3" }, "req")).toThrow(
      "a version belongs on stage, not on a check",
    );
    expect(() => parseFleetUpdateRequest({ target: "app", action: "stage", version: "nope" }, "req")).toThrow(
      "req.version must be a version like 18.13.1",
    );
    expect(() => parseFleetUpdateRequest("app", "req")).toThrow("req must be an object");
  });

  it("parses the member request: the requester rides beside the body", () => {
    const raw = { requester, target: "app", action: "apply", version: null, allowLiveSessions: true };
    expect(parseFleetUpdateMemberRequest(raw)).toEqual(raw);
    expect(() => parseFleetUpdateMemberRequest({ ...raw, extra: 1 })).toThrow("fleet update request contains unknown field extra");
    expect(() => parseFleetUpdateMemberRequest({ ...raw, requester: { ...requester, kind: "robot" } })).toThrow(
      "fleet update request.requester.kind must be user or agent",
    );
    expect(() => parseFleetUpdateMemberRequest({ target: "app", action: "check" })).toThrow("fleet update request.requester must be an object");
  });

  it("parses the maintenance poll strictly", () => {
    const raw = { requester, jobId: "job-1", waitMs: 25_000 };
    expect(parseFleetUpdatePollRequest(raw)).toEqual(raw);
    expect(() => parseFleetUpdatePollRequest({ ...raw, cancel: false })).toThrow(
      "fleet update poll request contains unknown field cancel",
    );
    expect(() => parseFleetUpdatePollRequest({ ...raw, jobId: "" })).toThrow("fleet update poll request.jobId must be a non-empty id");
    expect(() => parseFleetUpdatePollRequest({ ...raw, waitMs: "soon" })).toThrow("fleet update poll request.waitMs must be a number");
    expect(() => parseFleetUpdatePollRequest({ ...raw, waitMs: Number.NaN })).toThrow("fleet update poll request.waitMs must be a number");
  });
});

describe("omp-ui_fleet_update tool arguments", () => {
  it("accepts the full shape and defaults version to null", () => {
    expect(parseFleetToolArguments("omp-ui_fleet_update", { machine: " studio ", target: "app", action: "check" })).toEqual({
      ok: true,
      tool: "update",
      args: { machine: "studio", target: "app", action: "check", version: null },
    });
    expect(parseFleetToolArguments("omp-ui_fleet_update", { machine: "studio", target: "omp", action: "update", version: "18.13.1" })).toEqual({
      ok: true,
      tool: "update",
      args: { machine: "studio", target: "omp", action: "update", version: "18.13.1" },
    });
  });

  it("requires machine and refuses unknown arguments", () => {
    expect(parseFleetToolArguments("omp-ui_fleet_update", { target: "app", action: "check" })).toEqual({
      ok: false,
      reason: "machine must be a non-empty string",
    });
    expect(parseFleetToolArguments("omp-ui_fleet_update", { machine: " ", target: "app", action: "check" })).toEqual({
      ok: false,
      reason: "machine must be a non-empty string",
    });
    expect(parseFleetToolArguments("omp-ui_fleet_update", { machine: "studio", target: "app", action: "check", force: true })).toEqual({
      ok: false,
      reason: 'unknown argument "force"',
    });
  });

  it("keeps target and action inside their enums", () => {
    expect(parseFleetToolArguments("omp-ui_fleet_update", { machine: "studio", target: "kernel", action: "check" })).toEqual({
      ok: false,
      reason: "target must be omp or app",
    });
    expect(parseFleetToolArguments("omp-ui_fleet_update", { machine: "studio", target: "app", action: "restart" })).toEqual({
      ok: false,
      reason: "action must be check, update, or apply",
    });
  });

  it("refuses a version that does not look like a version", () => {
    expect(parseFleetToolArguments("omp-ui_fleet_update", { machine: "studio", target: "app", action: "update", version: "latest" })).toEqual({
      ok: false,
      reason: "version must look like 18.13.1",
    });
    expect(parseFleetToolArguments("omp-ui_fleet_update", { machine: "studio", target: "app", action: "check", version: "1.2.3" })).toEqual({
      ok: false,
      reason: "a version belongs on action update, not check",
    });
    expect(parseFleetToolArguments("omp-ui_fleet_update", { machine: "studio", target: "app", action: "apply", version: "1.2.3" })).toEqual({
      ok: false,
      reason: "a version belongs on action update, not apply",
    });
  });

  it("refuses to apply the omp binary", () => {
    expect(parseFleetToolArguments("omp-ui_fleet_update", { machine: "studio", target: "omp", action: "apply" })).toEqual({
      ok: false,
      reason: "the omp binary installs as it downloads; use action update",
    });
  });

  it("translates the agent action into the wire request, live sessions never allowed", () => {
    const machines: FleetMachine[] = [
      {
        key: LOCAL_MACHINE_KEY,
        nickname: null,
        status: "ready",
        error: null,
        preference: "normal",
        receivedAt: NOW,
        grantRung: null,
        report: report(),
        address: null,
        sshReachable: null,
        maintenance: null,
      },
      {
        key: "r1",
        nickname: "studio",
        status: "ready",
        error: null,
        preference: "normal",
        receivedAt: NOW,
        grantRung: "full",
        report: report(),
        address: "10.0.0.5",
        sshReachable: true,
        maintenance: null,
      },
    ];
    expect(fleetToolUpdateRequest({ machine: "This Computer", target: "app", action: "apply", version: null }, machines)).toEqual({
      ok: true,
      machineKey: LOCAL_MACHINE_KEY,
      request: { target: "app", action: "apply", version: null, allowLiveSessions: false },
    });
    expect(fleetToolUpdateRequest({ machine: "Studio", target: "omp", action: "update", version: "18.13.1" }, machines)).toEqual({
      ok: true,
      machineKey: "r1",
      request: { target: "omp", action: "stage", version: "18.13.1", allowLiveSessions: false },
    });
    expect(fleetToolUpdateRequest({ machine: "nope", target: "app", action: "check", version: null }, machines).ok).toBe(false);
  });
});
