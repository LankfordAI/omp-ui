import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  FLEET_EXEC_OUTPUT_MAX,
  FLEET_RUNGS,
  Registry,
  type AppUpdateState,
  type FleetRequester,
  type FleetRung,
  type FleetUpdateMemberRequest,
} from "@omp-ui/core";
import { hashRemotePassword, passwordSessionCredential } from "@omp-ui/server";

// Fleet update verbs reach core's omp machinery only inside maintenance jobs;
// stub the network/install layer (precedent: diagnostics.test.ts) so no test
// ever touches npm or renames a binary. Everything else stays real core.
const updateStubs = vi.hoisted(() => ({
  checkOmpUpdate: vi.fn(),
  fetchLatestOmpVersion: vi.fn(),
  downloadOmp: vi.fn(),
  readInstalledOmpVersion: vi.fn(),
  managedOmpPath: vi.fn(() => "/managed/omp"),
}));
vi.mock("@omp-ui/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@omp-ui/core")>();
  return {
    ...core,
    checkOmpUpdate: updateStubs.checkOmpUpdate,
    fetchLatestOmpVersion: updateStubs.fetchLatestOmpVersion,
    downloadOmp: updateStubs.downloadOmp,
    readInstalledOmpVersion: updateStubs.readInstalledOmpVersion,
    managedOmpPath: updateStubs.managedOmpPath,
  };
});
// fleet-server pulls app-update.ts (isAutoUpdateFormat) which touches only electron's shell.
vi.mock("electron", () => ({ shell: { openExternal: async () => {}, openPath: async () => "", showItemInFolder: () => {} } }));
import { FleetServer, runFleetCommand } from "./fleet-server";

const posix = process.platform === "win32" ? describe.skip : describe;

const A: FleetRequester = { instanceId: "inst-a", label: "studio", kind: "agent", sourceTabId: "tab-1" };

let base: string;
let registry: Registry;
let broadcasts: number;
let installProviderKey: (envName: string, value: string) => void;
let live: FleetServer[];

// Fleet update seams: every dep is a mutable holder so each test flips only
// what it asserts; server() reads them through at call time.
function appStateOf(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: "idle",
    currentVersion: "0.31.0",
    latestVersion: null,
    releaseUrl: null,
    releaseName: null,
    format: "appimage",
    progress: null,
    downloadedPath: null,
    installOnQuit: false,
    error: null,
    ...over,
  };
}
let ompInstallPath: string | null;
let onOmpApplied: Mock;
let appState: AppUpdateState;
let stageAppUpdate: Mock;
let armAppUpdateOnQuit: Mock;
let liveSessions: number;
let pinned: boolean;

function server(
  execGit?: ConstructorParameters<typeof FleetServer>[0]["execGit"],
  addProject?: ConstructorParameters<typeof FleetServer>[0]["addProject"],
  commandDeps?: ConstructorParameters<typeof FleetServer>[0]["commandDeps"],
): FleetServer {
  const s = new FleetServer({
    registry,
    logDir: path.join(base, "logs"),
    broadcast: () => {
      broadcasts += 1;
    },
    addProject:
      addProject ??
      (async (dir) => {
        registry.addProject(dir);
        broadcasts += 1;
      }),
    installProviderKey: (envName, value) => installProviderKey(envName, value),
    ompInstallPath: () => ompInstallPath,
    onOmpApplied: (version) => onOmpApplied(version),
    appUpdateState: () => appState,
    stageAppUpdate: () => stageAppUpdate(),
    armAppUpdateOnQuit: () => armAppUpdateOnQuit(),
    liveSessions: () => liveSessions,
    pinned: () => pinned,
    ...(execGit === undefined ? {} : { execGit }),
    ...(commandDeps === undefined ? {} : { commandDeps }),
  });
  live.push(s);
  return s;
}

function grant(instanceId: string, rung: FleetRung): void {
  registry.setSetting("fleetGrants", { ...registry.getSetting("fleetGrants"), [instanceId]: { rung, label: "x", updatedAt: "t" } });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-server-"));
  registry = Registry.load(path.join(base, "registry.json"));
  broadcasts = 0;
  installProviderKey = () => {};
  live = [];
  ompInstallPath = null;
  onOmpApplied = vi.fn();
  appState = appStateOf();
  stageAppUpdate = vi.fn(async () => "staged" as const);
  armAppUpdateOnQuit = vi.fn(() => true);
  liveSessions = 0;
  pinned = false;
  updateStubs.checkOmpUpdate.mockReset().mockResolvedValue({
    installPath: null,
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    belowMinimum: false,
    error: null,
  });
  updateStubs.fetchLatestOmpVersion.mockReset().mockResolvedValue(null);
  updateStubs.downloadOmp.mockReset().mockResolvedValue(undefined);
  updateStubs.readInstalledOmpVersion.mockReset().mockResolvedValue(null);
  updateStubs.managedOmpPath.mockReset().mockReturnValue("/managed/omp");
});

afterEach(() => {
  for (const s of live) s.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("FleetServer ladder (issue #901)", () => {
  it("defaults an unknown dispatcher to dispatch and names it without granting anything", () => {
    const s = server();
    expect(s.grantRung(A)).toEqual({ rung: "dispatch", ceiling: "dispatch", execEnabled: false });
    expect(registry.getSetting("fleetGrants")["inst-a"]).toMatchObject({ label: "studio" });
    expect(registry.getSetting("fleetGrants")["inst-a"]?.rung).toBeUndefined();
    expect(s.check(A, "dispatch")).toEqual({ ok: true, rung: "dispatch" });
    expect(s.check(A, "manage").ok).toBe(false);
  });

  // Every grant × ceiling: the effective rung never exceeds the ceiling, and
  // rung 4 additionally needs the master switch.
  it.each(FLEET_RUNGS.flatMap((g) => FLEET_RUNGS.map((c) => [g, c] as const)))(
    "grant %s under ceiling %s",
    (granted, ceiling) => {
      registry.setSetting("fleetExecCeiling", ceiling);
      grant(A.instanceId, granted);
      const s = server();
      const rank = (r: FleetRung): number => FLEET_RUNGS.indexOf(r);
      const effective = FLEET_RUNGS[Math.min(rank(granted), rank(ceiling))]!;
      expect(s.grantRung(A).rung).toBe(effective);
      for (const need of FLEET_RUNGS) {
        const verdict = s.check(A, need);
        const allowed = rank(effective) >= rank(need) && need !== "full";
        if (need === "full") expect(verdict.ok).toBe(false); // master switch off
        else expect(verdict.ok).toBe(allowed);
      }
      registry.setSetting("fleetExecEnabled", true);
      expect(server().check(A, "full").ok).toBe(effective === "full");
    },
  );

  it("names the switch when only the master switch blocks exec", () => {
    registry.setSetting("fleetExecCeiling", "full");
    grant(A.instanceId, "full");
    const verdict = server().check(A, "full");
    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("fleet exec is off") });
  });
});

posix("FleetServer.exec", () => {
  it("refuses below the ladder without spawning and audits the refusal", async () => {
    const spawnFn = vi.fn();
    const s = server(undefined, undefined, { spawnFn });
    const outcome = await s.exec({ requester: A, command: "echo hi", cwd: null, timeoutMs: null });
    expect(outcome.status).toBe("refused");
    expect(spawnFn).not.toHaveBeenCalled();
    expect(s.auditEntries()).toEqual([
      expect.objectContaining({ action: "exec", rung: "full", accepted: false, detail: "echo hi", dispatcherId: "inst-a" }),
    ]);
  });

  it("runs once every gate is open and records the rung used", async () => {
    registry.setSetting("fleetExecEnabled", true);
    registry.setSetting("fleetExecCeiling", "full");
    grant(A.instanceId, "full");
    const s = server();
    const outcome = await s.exec({ requester: A, command: "echo hi; exit 3", cwd: base, timeoutMs: null });
    expect(outcome).toMatchObject({ status: "accepted", exitCode: 3, stdout: "hi\n", truncated: false, timedOut: false });
    expect(s.auditEntries().at(-1)).toMatchObject({ action: "exec", rung: "full", accepted: true, exitCode: 3 });
    const log = fs.readFileSync(path.join(base, "logs", "fleet-audit.log"), "utf8");
    expect(log).toContain('"action":"exec"');
  });

  it("caps the audit ring at 200, newest last", async () => {
    const s = server();
    for (let i = 0; i < 250; i += 1) await s.exec({ requester: A, command: `cmd ${i}`, cwd: null, timeoutMs: null });
    const entries = s.auditEntries();
    expect(entries).toHaveLength(200);
    expect(entries[0]!.detail).toBe("cmd 50");
    expect(entries.at(-1)!.detail).toBe("cmd 249");
  });
});

posix("runFleetCommand", () => {
  it("captures stdout, stderr, and the exit code", async () => {
    const outcome = await runFleetCommand({ command: "echo out; echo err >&2; exit 7", cwd: null, timeoutMs: null });
    expect(outcome).toEqual({ status: "accepted", exitCode: 7, stdout: "out\n", stderr: "err\n", truncated: false, timedOut: false });
  });

  it("refuses a missing cwd before spawning", async () => {
    const spawnFn = vi.fn();
    const outcome = await runFleetCommand({ command: "true", cwd: path.join(base, "nope"), timeoutMs: null }, { spawnFn });
    expect(outcome).toEqual({ status: "refused", reason: expect.stringContaining("is not a directory") });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("caps each stream by bytes, multibyte output included", async () => {
    // 3-byte "€" repeated past the cap: the cut lands mid-character at worst.
    const outcome = await runFleetCommand({ command: `yes € | head -c ${FLEET_EXEC_OUTPUT_MAX * 2}`, cwd: null, timeoutMs: null });
    expect(outcome.status).toBe("accepted");
    if (outcome.status !== "accepted") return;
    expect(outcome.truncated).toBe(true);
    // Decoding may expand one split tail into U+FFFD (3 bytes) — never more.
    expect(Buffer.byteLength(outcome.stdout)).toBeLessThanOrEqual(FLEET_EXEC_OUTPUT_MAX + 2);
    expect(outcome.stdout.length).toBeGreaterThan(0);
  });

  it("kills the whole process tree on timeout and keeps partial output", async () => {
    const pidFile = path.join(base, "child.pid");
    // A grandchild sleeper: only a group kill reaches it.
    const outcome = await runFleetCommand({
      command: `echo started; sleep 30 & echo $! > ${pidFile}; wait`,
      cwd: null,
      timeoutMs: 300,
    });
    expect(outcome).toMatchObject({ status: "accepted", timedOut: true, stdout: "started\n" });
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2_000 });
  });

  it("clamps a timeout below the floor up to 100 ms", async () => {
    const started = Date.now();
    const outcome = await runFleetCommand({ command: "sleep 5", cwd: null, timeoutMs: 1 });
    expect(outcome).toMatchObject({ status: "accepted", timedOut: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});

describe("FleetServer.grantRaise", () => {
  const TOKEN = "node-join-token-abcdef";

  beforeEach(() => {
    registry.setSetting("remoteToken", TOKEN);
    registry.setSetting("fleetExecCeiling", "manage");
  });

  it("refuses a wrong credential without writing a grant", () => {
    const s = server();
    expect(s.grantRaise({ requester: A, targetRung: "manage", credential: "guess" })).toEqual({ ok: false, reason: expect.any(String) });
    expect(registry.getSetting("fleetGrants")["inst-a"]).toBeUndefined();
    expect(s.auditEntries().at(-1)).toMatchObject({ action: "grant-raise", accepted: false });
    expect(JSON.stringify(s.auditEntries())).not.toContain("guess");
  });

  it("refuses an empty credential even when no token is configured", () => {
    registry.setSetting("remoteToken", "");
    expect(server().grantRaise({ requester: A, targetRung: "observe", credential: "" }).ok).toBe(false);
  });

  it("grants with the node's token", () => {
    const s = server();
    expect(s.grantRaise({ requester: A, targetRung: "manage", credential: TOKEN })).toEqual({ ok: true, rung: "manage" });
    expect(registry.getSetting("fleetGrants")["inst-a"]).toMatchObject({ rung: "manage", label: "studio" });
    expect(s.check(A, "manage")).toEqual({ ok: true, rung: "manage" });
    expect(broadcasts).toBe(1);
  });

  it("refuses a target above the ceiling even with the right credential", () => {
    const s = server();
    const outcome = s.grantRaise({ requester: A, targetRung: "full", credential: TOKEN });
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('"manage"') });
    expect(registry.getSetting("fleetGrants")["inst-a"]?.rung).toBeUndefined();
  });

  it("accepts the password and its session credential", () => {
    registry.setSetting("remoteToken", "");
    const { salt, hash } = hashRemotePassword("correct horse");
    registry.setSetting("remotePasswordSalt", salt);
    registry.setSetting("remotePasswordHash", hash);
    expect(server().grantRaise({ requester: A, targetRung: "manage", credential: "correct horse" }).ok).toBe(true);
    const B: FleetRequester = { ...A, instanceId: "inst-b" };
    expect(server().grantRaise({ requester: B, targetRung: "observe", credential: passwordSessionCredential(hash) }).ok).toBe(true);
    expect(server().grantRaise({ requester: B, targetRung: "manage", credential: "wrong horse" }).ok).toBe(false);
  });
});

describe("FleetServer.setGrant", () => {
  it("sets, keeps the first-sight label, and null resets to the default while keeping the named row", () => {
    const s = server();
    s.grantRung(A); // first sight records the label
    s.setGrant("inst-a", "observe");
    expect(registry.getSetting("fleetGrants")["inst-a"]).toMatchObject({ rung: "observe", label: "studio" });
    expect(s.check(A, "dispatch").ok).toBe(false);
    s.setGrant("inst-a", null);
    expect(registry.getSetting("fleetGrants")["inst-a"]).toEqual({ label: "studio", updatedAt: expect.any(String) });
    expect(s.check(A, "dispatch").ok).toBe(true);
    s.setGrant("inst-a", null); // already at the default: no write, no audit line
    expect(s.auditEntries().map((e) => e.detail)).toEqual(["set observe", "reset to default"]);
  });
});

describe("FleetServer.projectManage", () => {
  const execGit = vi.fn(async () => ({ stdout: Buffer.from("") }));

  beforeEach(() => {
    execGit.mockClear();
    registry.setSetting("fleetExecCeiling", "manage");
    grant(A.instanceId, "manage");
  });

  it("refuses below rung 3 without touching git", async () => {
    grant(A.instanceId, "dispatch");
    const outcome = await server(execGit).projectManage({ requester: A, verb: "clone", repositoryUrl: "https://github.com/acme/repo.git" });
    expect(outcome.status).toBe("refused");
    expect(execGit).not.toHaveBeenCalled();
  });

  it("refuses when no roots are declared", async () => {
    const outcome = await server(execGit).projectManage({ requester: A, verb: "clone", repositoryUrl: "https://github.com/acme/repo.git" });
    expect(outcome).toEqual({ status: "refused", reason: "no project roots are declared on this machine" });
  });

  it.each([
    ["http://github.com/acme/repo.git", "https URLs only"],
    ["ssh://git@github.com/acme/repo.git", "https URLs only"],
    ["https://user:pw@github.com/acme/repo.git", "must not carry credentials"],
    ["https://github.com/", "no usable repository name"],
    ["not a url", "valid URL"],
  ])("refuses clone of %s before git runs", async (repositoryUrl, reason) => {
    registry.setSetting("fleetProjectRoots", [base]);
    const outcome = await server(execGit).projectManage({ requester: A, verb: "clone", repositoryUrl });
    expect(outcome).toEqual({ status: "refused", reason: expect.stringContaining(reason) });
    expect(execGit).not.toHaveBeenCalled();
  });

  it("clones into the first free root under a sanitized name and registers it", async () => {
    const rootA = path.join(base, "a");
    const rootB = path.join(base, "b");
    fs.mkdirSync(path.join(rootA, "re24po"), { recursive: true }); // collision in the first root
    fs.mkdirSync(rootB);
    registry.setSetting("fleetProjectRoots", [rootA, rootB]);
    const outcome = await server(execGit).projectManage({ requester: A, verb: "clone", repositoryUrl: "https://github.com/acme/re%24po.git" });
    expect(outcome).toMatchObject({ status: "accepted", path: path.join(rootB, "re24po") });
    expect(execGit).toHaveBeenCalledWith("git", ["clone", "--", "https://github.com/acme/re%24po.git", path.join(rootB, "re24po")], expect.objectContaining({ cwd: rootB }));
    expect(registry.projects.map((p) => p.path)).toContain(path.join(rootB, "re24po"));
  });

  it("maps a git timeout to the long-running-setup hint", async () => {
    registry.setSetting("fleetProjectRoots", [base]);
    const failing = vi.fn(async () => {
      throw new Error("Command failed: timed out");
    });
    const outcome = await server(failing).projectManage({ requester: A, verb: "clone", repositoryUrl: "https://github.com/acme/repo" });
    expect(outcome).toEqual({ status: "refused", reason: "clone timed out — use fleet.exec for long-running setup" });
  });

  it("registers only an existing checkout under a declared root", async () => {
    const root = path.join(base, "root");
    const checkout = path.join(root, "app");
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "plain"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-outside-"));
    fs.mkdirSync(path.join(outside, ".git"));
    registry.setSetting("fleetProjectRoots", [root]);
    try {
      const s = server(execGit);
      expect(await s.projectManage({ requester: A, verb: "register", path: path.join(root, "plain") })).toEqual({
        status: "refused",
        reason: expect.stringContaining("no .git"),
      });
      expect(await s.projectManage({ requester: A, verb: "register", path: outside })).toEqual({
        status: "refused",
        reason: expect.stringContaining("not under a declared project root"),
      });
      // A symlink inside the root pointing outside it resolves out of bounds.
      fs.symlinkSync(outside, path.join(root, "escape"));
      expect((await s.projectManage({ requester: A, verb: "register", path: path.join(root, "escape") })).status).toBe("refused");
      expect(await s.projectManage({ requester: A, verb: "register", path: checkout })).toMatchObject({ status: "accepted", path: fs.realpathSync(checkout) });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses register when the shared add path rejects, after the checks pass", async () => {
    const root = path.join(base, "root");
    const checkout = path.join(root, "app");
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
    registry.setSetting("fleetProjectRoots", [root]);
    const rejecting = async (): Promise<void> => {
      throw new Error("omp-ui's chats folder can't be registered as a project");
    };
    const s = server(execGit, rejecting);
    expect(await s.projectManage({ requester: A, verb: "register", path: checkout })).toEqual({
      status: "refused",
      reason: "registration failed: omp-ui's chats folder can't be registered as a project",
    });
    expect(s.auditEntries().at(-1)).toMatchObject({ action: "manage", accepted: false });
  });
});

function openFull(instanceId: string): void {
  registry.setSetting("fleetExecEnabled", true);
  registry.setSetting("fleetExecCeiling", "full");
  grant(instanceId, "full");
}

posix("FleetServer detached exec (issue #905)", () => {
  it("follows the ladder: refused below Full control and with the master switch off", () => {
    registry.setSetting("fleetExecCeiling", "full");
    grant(A.instanceId, "manage");
    registry.setSetting("fleetExecEnabled", true);
    const s = server();
    expect(s.execDetach({ requester: A, command: "sleep 1", cwd: null, timeoutMs: null })).toEqual({
      status: "refused",
      reason: expect.stringContaining('this call needs "full"'),
    });
    grant(A.instanceId, "full");
    registry.setSetting("fleetExecEnabled", false);
    expect(s.execDetach({ requester: A, command: "sleep 2", cwd: null, timeoutMs: null })).toEqual({
      status: "refused",
      reason: expect.stringContaining("fleet exec is off"),
    });
    expect(s.auditEntries()).toEqual([
      expect.objectContaining({ action: "exec-detached", rung: "full", accepted: false, detail: "sleep 1" }),
      expect.objectContaining({ action: "exec-detached", rung: "full", accepted: false, detail: "sleep 2" }),
    ]);
  });

  it("starts, audits the start and the finish, and never audits a poll", async () => {
    openFull(A.instanceId);
    const s = server();
    const start = s.execDetach({ requester: A, command: "echo hi; exit 2", cwd: base, timeoutMs: null });
    if (start.status !== "accepted") throw new Error(start.reason);
    const id8 = start.execId.slice(0, 8);
    expect(s.auditEntries()).toEqual([
      expect.objectContaining({ action: "exec-detached", rung: "full", accepted: true, detail: `${id8} echo hi; exit 2`, exitCode: null }),
    ]);
    const outcome = await s.execPoll({ requester: A, execId: start.execId, waitMs: 5_000, cancel: false });
    expect(outcome).toMatchObject({ status: "accepted", state: "exited", exitCode: 2, stdout: "hi\n" });
    await s.execPoll({ requester: A, execId: start.execId, waitMs: 0, cancel: false });
    expect(s.auditEntries().map((e) => [e.action, e.detail, e.exitCode])).toEqual([
      ["exec-detached", `${id8} echo hi; exit 2`, null],
      ["exec-detached", `${id8} exited`, 2],
    ]);
    const log = fs.readFileSync(path.join(base, "logs", "fleet-audit.log"), "utf8");
    expect(log).toContain('"action":"exec-detached"');
  });

  it("revokes a running exec when setGrant lowers its starter below Full control", async () => {
    openFull(A.instanceId);
    const s = server();
    const start = s.execDetach({ requester: A, command: "sleep 30", cwd: null, timeoutMs: null });
    if (start.status !== "accepted") throw new Error(start.reason);
    s.setGrant(A.instanceId, "manage");
    expect(await s.execPoll({ requester: A, execId: start.execId, waitMs: 5_000, cancel: false })).toMatchObject({
      status: "accepted",
      state: "revoked",
      exitCode: null,
    });
    expect(s.auditEntries().at(-1)).toMatchObject({ action: "exec-detached", accepted: true, detail: `${start.execId.slice(0, 8)} revoked` });
  });
});

describe("FleetServer.providerKeys (issue #905)", () => {
  const OPENAI = "sk-openai-secret-value-0001";
  const ANTHROPIC = "sk-ant-secret-value-0002";
  const keys = [
    { envName: "OPENAI_API_KEY", value: OPENAI },
    { envName: "ANTHROPIC_API_KEY", value: ANTHROPIC },
  ];

  function expectNoValueLogged(s: FleetServer): void {
    const log = fs.readFileSync(path.join(base, "logs", "fleet-audit.log"), "utf8");
    for (const text of [log, JSON.stringify(s.auditEntries())]) {
      expect(text).not.toContain(OPENAI);
      expect(text).not.toContain(ANTHROPIC);
    }
  }

  it("refuses below Full control without installing and audits names only", () => {
    registry.setSetting("fleetExecEnabled", true);
    registry.setSetting("fleetExecCeiling", "full");
    grant(A.instanceId, "manage");
    const install = vi.fn();
    installProviderKey = install;
    const s = server();
    expect(s.providerKeys({ requester: A, keys })).toEqual({ status: "refused", reason: expect.stringContaining('this call needs "full"') });
    expect(install).not.toHaveBeenCalled();
    expect(s.auditEntries()).toEqual([
      expect.objectContaining({ action: "keys", rung: "full", accepted: false, detail: "OPENAI_API_KEY, ANTHROPIC_API_KEY" }),
    ]);
    expectNoValueLogged(s);
  });

  it("answers accepted with the failures when some installs throw, and never logs a value", () => {
    openFull(A.instanceId);
    const stored = new Map<string, string>();
    installProviderKey = (envName, value) => {
      if (envName === "ANTHROPIC_API_KEY") throw new Error("no OS credential store on this machine");
      stored.set(envName, value);
    };
    const s = server();
    expect(s.providerKeys({ requester: A, keys })).toEqual({
      status: "accepted",
      installed: ["OPENAI_API_KEY"],
      failed: [{ envName: "ANTHROPIC_API_KEY", reason: "no OS credential store on this machine" }],
    });
    expect(stored.get("OPENAI_API_KEY")).toBe(OPENAI);
    expect(s.auditEntries().at(-1)).toMatchObject({
      action: "keys",
      rung: "full",
      accepted: false,
      detail: "installed OPENAI_API_KEY; failed ANTHROPIC_API_KEY",
    });
    expectNoValueLogged(s);
  });
});

const B: FleetRequester = { instanceId: "inst-b", label: "lab", kind: "agent", sourceTabId: null };

function updateReq(over: Partial<Omit<FleetUpdateMemberRequest, "requester">> & { requester?: FleetRequester } = {}): FleetUpdateMemberRequest {
  return { requester: A, target: "omp", action: "check", version: null, allowLiveSessions: false, ...over };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

describe("FleetServer.updateMember (fleet remote version update)", () => {
  it("refuses below Full control with the exact ladder string and audits the verb", async () => {
    registry.setSetting("fleetExecCeiling", "full");
    registry.setSetting("fleetExecEnabled", true);
    grant(A.instanceId, "manage");
    const s = server();
    expect(await s.updateMember(updateReq())).toEqual({
      status: "refused",
      reason: 'studio holds fleet access "manage" on this machine; this call needs "full"',
    });
    expect(s.auditEntries()).toEqual([
      expect.objectContaining({ action: "update", dispatcherId: "inst-a", rung: "full", accepted: false, detail: "omp check" }),
    ]);
    expect(updateStubs.checkOmpUpdate).not.toHaveBeenCalled();
  });

  it("refuses with the master switch off even at a full grant, and on a manage ceiling", async () => {
    openFull(A.instanceId);
    registry.setSetting("fleetExecEnabled", false);
    const s = server();
    expect(await s.updateMember(updateReq({ target: "app", action: "stage" }))).toEqual({
      status: "refused",
      reason: "fleet exec is off on this machine (Settings → Remote instances → Fleet access)",
    });
    registry.setSetting("fleetExecEnabled", true);
    registry.setSetting("fleetExecCeiling", "manage");
    expect(await s.updateMember(updateReq({ target: "app", action: "apply" }))).toEqual({
      status: "refused",
      reason: 'studio holds fleet access "manage" on this machine; this call needs "full"',
    });
    expect(s.auditEntries().map((e) => [e.action, e.accepted, e.detail])).toEqual([
      ["update", false, "app stage"],
      ["update", false, "app apply"],
    ]);
  });

  it("answers omp/check from this machine's install facts and audits versions only", async () => {
    openFull(A.instanceId);
    ompInstallPath = "/opt/omp/bin/omp";
    updateStubs.checkOmpUpdate.mockResolvedValue({
      installPath: "/opt/omp/bin/omp",
      installedVersion: "18.12.0",
      latestVersion: "18.13.1",
      updateAvailable: true,
      belowMinimum: false,
      error: null,
    });
    pinned = true;
    const s = server();
    expect(await s.updateMember(updateReq())).toEqual({
      status: "accepted",
      check: {
        target: "omp",
        installedVersion: "18.12.0",
        installPath: "/opt/omp/bin/omp",
        latestVersion: "18.13.1",
        updateAvailable: true,
        belowMinimum: false,
        pinned: true,
      },
    });
    expect(updateStubs.checkOmpUpdate).toHaveBeenCalledWith({ installPath: "/opt/omp/bin/omp" });
    const entry = s.auditEntries().at(-1)!;
    expect(entry).toMatchObject({ action: "update", accepted: true, detail: "omp check 18.12.0→18.13.1" });
    expect(JSON.stringify(s.auditEntries())).not.toContain("/opt/omp");
  });

  it("refuses omp/stage on a pinned machine without naming any path", async () => {
    openFull(A.instanceId);
    ompInstallPath = "/home/dev/secretpin/omp";
    pinned = true;
    const s = server();
    const ack = await s.updateMember(updateReq({ action: "stage" }));
    expect(ack).toEqual({
      status: "refused",
      reason: "omp is pinned by OMP_UI_OMP_PATH on this machine; install into the managed path or clear the pin",
    });
    const text = JSON.stringify(ack) + JSON.stringify(s.auditEntries());
    expect(text).not.toContain("secretpin");
    expect(updateStubs.downloadOmp).not.toHaveBeenCalled();
    expect(s.auditEntries().at(-1)).toMatchObject({ action: "update", accepted: false, detail: "omp stage" });
  });

  it("refuses omp/stage when no release is available", async () => {
    openFull(A.instanceId);
    updateStubs.fetchLatestOmpVersion.mockResolvedValue(null);
    const s = server();
    expect(await s.updateMember(updateReq({ action: "stage" }))).toEqual({
      status: "refused",
      reason: "no omp release is available for this machine",
    });
    expect(s.auditEntries().at(-1)).toMatchObject({ action: "update", accepted: false, detail: "omp stage" });
  });

  it("starts an omp/stage job, reports progress, and applies the binary on success", async () => {
    openFull(A.instanceId);
    updateStubs.fetchLatestOmpVersion.mockResolvedValue("18.13.1");
    updateStubs.readInstalledOmpVersion.mockResolvedValue("18.12.0");
    const dl = deferred<void>();
    let onProgress: ((percent: number | null) => void) | null = null;
    updateStubs.downloadOmp.mockImplementation((opts: { onProgress?: (p: number | null) => void }) => {
      onProgress = opts.onProgress ?? null;
      return dl.promise;
    });
    const s = server();
    const ack = await s.updateMember(updateReq({ action: "stage" }));
    if (ack.status !== "accepted" || !("jobId" in ack)) throw new Error(JSON.stringify(ack));
    expect(s.auditEntries().at(-1)).toMatchObject({
      action: "update",
      rung: "full",
      accepted: true,
      detail: `omp → 18.13.1 (job ${ack.jobId.slice(0, 8)})`,
    });
    expect(updateStubs.downloadOmp).toHaveBeenCalledWith(
      expect.objectContaining({ version: "18.13.1", targetPath: "/managed/omp", shouldCommit: expect.any(Function) }),
    );
    onProgress!(null);
    expect(await s.updatePoll({ requester: A, jobId: ack.jobId, waitMs: 0 })).toMatchObject({
      status: "accepted",
      state: "running",
      progress: { percent: null, phase: "downloading" },
    });
    onProgress!(42);
    expect(await s.updatePoll({ requester: A, jobId: ack.jobId, waitMs: 0 })).toMatchObject({
      state: "running",
      progress: { percent: 42, phase: "downloading" },
    });
    dl.resolve();
    expect(await s.updatePoll({ requester: A, jobId: ack.jobId, waitMs: 5_000 })).toMatchObject({
      status: "accepted",
      state: "succeeded",
      detail: "omp 18.12.0 → 18.13.1 at /managed/omp",
    });
    expect(onOmpApplied).toHaveBeenCalledWith("18.13.1");
    expect(s.auditEntries().at(-1)).toMatchObject({ action: "update", accepted: true, detail: `omp succeeded: omp 18.12.0 → 18.13.1 at /managed/omp` });
  });

  it("installs an explicitly requested omp version without consulting npm", async () => {
    openFull(A.instanceId);
    updateStubs.downloadOmp.mockResolvedValue(undefined);
    const s = server();
    const ack = await s.updateMember(updateReq({ action: "stage", version: "18.13.1" }));
    if (ack.status !== "accepted" || !("jobId" in ack)) throw new Error(JSON.stringify(ack));
    expect(updateStubs.fetchLatestOmpVersion).not.toHaveBeenCalled();
    expect(updateStubs.downloadOmp).toHaveBeenCalledWith(expect.objectContaining({ version: "18.13.1" }));
    expect(await s.updatePoll({ requester: A, jobId: ack.jobId, waitMs: 5_000 })).toMatchObject({ state: "succeeded" });
    expect(onOmpApplied).toHaveBeenCalledWith("18.13.1");
  });

  it("answers app/check from the updater state without any network call", async () => {
    openFull(A.instanceId);
    appState = appStateOf({ status: "downloaded", latestVersion: "0.32.0", installOnQuit: true, format: "rpm" });
    liveSessions = 2;
    const s = server();
    expect(await s.updateMember(updateReq({ target: "app" }))).toEqual({
      status: "accepted",
      check: {
        target: "app",
        currentVersion: "0.31.0",
        latestVersion: "0.32.0",
        format: "rpm",
        staged: true,
        installOnQuit: true,
        liveSessions: 2,
      },
    });
    expect(updateStubs.checkOmpUpdate).not.toHaveBeenCalled();
    // The cheap verb stays cheap: an accepted app check writes no audit line.
    expect(s.auditEntries()).toEqual([]);
  });

  it("refuses app/stage when the updater is off or the format needs its package manager", async () => {
    openFull(A.instanceId);
    const s = server();
    appState = appStateOf({ status: "disabled" });
    expect(await s.updateMember(updateReq({ target: "app", action: "stage" }))).toEqual({
      status: "refused",
      reason: "omp-ui auto-update is off in this install (Settings → Updates)",
    });
    appState = appStateOf({ status: "available", latestVersion: "0.32.0", format: "deb" });
    expect(await s.updateMember(updateReq({ target: "app", action: "stage" }))).toEqual({
      status: "refused",
      reason: "this machine installs omp-ui as a deb package; update it with its package manager",
    });
    appState = appStateOf({ status: "available", format: "unknown" });
    expect(await s.updateMember(updateReq({ target: "app", action: "stage" }))).toEqual({
      status: "refused",
      reason: "omp-ui does not know how this machine's omp-ui was installed; update it manually",
    });
    expect(stageAppUpdate).not.toHaveBeenCalled();
    expect(s.auditEntries().map((e) => [e.action, e.accepted, e.detail])).toEqual([
      ["update", false, "app stage"],
      ["update", false, "app stage"],
      ["update", false, "app stage"],
    ]);
  });

  it("stages an app update and fails the job on a stale check instead of pretending", async () => {
    openFull(A.instanceId);
    appState = appStateOf({ status: "available", latestVersion: "0.32.0" });
    const st = deferred<"staged">();
    stageAppUpdate.mockReturnValue(st.promise);
    const s = server();
    const ack = await s.updateMember(updateReq({ target: "app", action: "stage" }));
    if (ack.status !== "accepted" || !("jobId" in ack)) throw new Error(JSON.stringify(ack));
    expect(await s.updatePoll({ requester: A, jobId: ack.jobId, waitMs: 0 })).toMatchObject({
      status: "accepted",
      state: "running",
      progress: { percent: null, phase: "staging" },
    });
    st.resolve("staged");
    expect(await s.updatePoll({ requester: A, jobId: ack.jobId, waitMs: 5_000 })).toMatchObject({
      state: "succeeded",
      detail: "app staged 0.32.0",
    });
    expect(s.auditEntries().at(-1)).toMatchObject({ action: "update", accepted: true, detail: "app succeeded: app staged 0.32.0" });
    expect(onOmpApplied).not.toHaveBeenCalled();

    stageAppUpdate = vi.fn(async () => "up-to-date" as const);
    const stale = await s.updateMember(updateReq({ target: "app", action: "stage" }));
    if (stale.status !== "accepted" || !("jobId" in stale)) throw new Error(JSON.stringify(stale));
    expect(await s.updatePoll({ requester: A, jobId: stale.jobId, waitMs: 5_000 })).toMatchObject({
      state: "failed",
      detail: "no omp-ui release is available for this machine's train",
    });

    stageAppUpdate = vi.fn(async () => "unavailable" as const);
    const off = await s.updateMember(updateReq({ target: "app", action: "stage" }));
    if (off.status !== "accepted" || !("jobId" in off)) throw new Error(JSON.stringify(off));
    expect(await s.updatePoll({ requester: A, jobId: off.jobId, waitMs: 5_000 })).toMatchObject({
      state: "failed",
      detail: "omp-ui auto-update is off in this install (Settings → Updates)",
    });

    stageAppUpdate = vi.fn(async () => "failed" as const);
    const bad = await s.updateMember(updateReq({ target: "app", action: "stage" }));
    if (bad.status !== "accepted" || !("jobId" in bad)) throw new Error(JSON.stringify(bad));
    expect(await s.updatePoll({ requester: A, jobId: bad.jobId, waitMs: 5_000 })).toMatchObject({
      state: "failed",
      detail: "the omp-ui update could not be staged on this machine",
    });
  });

  it("refuses app/apply on live sessions, nothing staged, and a declined arm — then arms on-quit", async () => {
    openFull(A.instanceId);
    const s = server();
    liveSessions = 3;
    appState = appStateOf({ status: "downloaded", latestVersion: "0.32.0" });
    expect(await s.updateMember(updateReq({ target: "app", action: "apply" }))).toEqual({
      status: "refused",
      reason: "3 live session(s) run on this machine; stop them or choose Install when I quit",
    });
    liveSessions = 0;
    appState = appStateOf({ status: "available", latestVersion: "0.32.0" });
    expect(await s.updateMember(updateReq({ target: "app", action: "apply" }))).toEqual({
      status: "refused",
      reason: "no omp-ui update is staged on this machine",
    });
    appState = appStateOf({ status: "downloaded", latestVersion: "0.32.0" });
    armAppUpdateOnQuit = vi.fn(() => false);
    expect(await s.updateMember(updateReq({ target: "app", action: "apply" }))).toEqual({
      status: "refused",
      reason: "this machine's updater declined to arm the install",
    });
    liveSessions = 1;
    armAppUpdateOnQuit = vi.fn(() => true);
    const ack = await s.updateMember(updateReq({ target: "app", action: "apply", allowLiveSessions: true }));
    expect(ack).toEqual({ status: "accepted", detail: "arm-on-quit" });
    expect(s.auditEntries().map((e) => [e.action, e.accepted, e.detail])).toEqual([
      ["update", false, "app apply"],
      ["update", false, "app apply"],
      ["update", false, "app apply"],
      ["update", true, "app apply arm-on-quit"],
    ]);
  });

  it("polls a job only for its starter, records first sight, and never audits a poll", async () => {
    openFull(A.instanceId);
    openFull(B.instanceId);
    updateStubs.downloadOmp.mockResolvedValue(undefined);
    const s = server();
    const ack = await s.updateMember(updateReq({ action: "stage", version: "18.13.1" }));
    if (ack.status !== "accepted" || !("jobId" in ack)) throw new Error(JSON.stringify(ack));
    expect(await s.updatePoll({ requester: B, jobId: ack.jobId, waitMs: 0 })).toEqual({
      status: "refused",
      reason: `no Fleet update job ${ack.jobId} from lab on this machine`,
    });
    const unknown = { instanceId: "inst-c", label: "stranger", kind: "agent" as const, sourceTabId: null };
    expect(await s.updatePoll({ requester: unknown, jobId: ack.jobId, waitMs: 0 })).toMatchObject({ status: "refused" });
    expect(registry.getSetting("fleetGrants")["inst-c"]).toMatchObject({ label: "stranger" });
    expect(registry.getSetting("fleetGrants")["inst-c"].rung).toBeUndefined();
    const before = s.auditEntries().length;
    await s.updatePoll({ requester: A, jobId: ack.jobId, waitMs: 100 });
    await s.updatePoll({ requester: B, jobId: ack.jobId, waitMs: 0 });
    expect(s.auditEntries().length).toBe(before);
  });

  it("revokes a running maintenance job when the ladder drops, and never applies late", async () => {
    openFull(A.instanceId);
    const dl = deferred<void>();
    updateStubs.downloadOmp.mockReturnValue(dl.promise);
    const s = server();
    const ack = await s.updateMember(updateReq({ action: "stage", version: "18.13.1" }));
    if (ack.status !== "accepted" || !("jobId" in ack)) throw new Error(JSON.stringify(ack));
    s.setGrant(A.instanceId, "manage");
    expect(await s.updatePoll({ requester: A, jobId: ack.jobId, waitMs: 0 })).toMatchObject({ state: "revoked" });
    dl.resolve();
    await Promise.resolve();
    expect(onOmpApplied).not.toHaveBeenCalled();
    expect(s.auditEntries().at(-1)).toMatchObject({ action: "update", accepted: true, detail: "omp revoked: revoked by this machine's owner" });
  });

  it("dispose revokes a running job without calling onOmpApplied and never installs at shutdown", async () => {
    openFull(A.instanceId);
    const dl = deferred<void>();
    updateStubs.downloadOmp.mockReturnValue(dl.promise);
    const s = server();
    const ack = await s.updateMember(updateReq({ action: "stage", version: "18.13.1" }));
    if (ack.status !== "accepted" || !("jobId" in ack)) throw new Error(JSON.stringify(ack));
    s.dispose();
    dl.resolve();
    await Promise.resolve();
    expect(onOmpApplied).not.toHaveBeenCalled();
    expect(s.auditEntries().at(-1)).toMatchObject({
      action: "update",
      detail: "omp revoked: the machine quit before the update finished",
    });
  });
});
