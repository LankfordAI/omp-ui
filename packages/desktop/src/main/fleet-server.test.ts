import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLEET_EXEC_OUTPUT_MAX, FLEET_RUNGS, Registry, type FleetRequester, type FleetRung } from "@omp-ui/core";
import { hashRemotePassword, passwordSessionCredential } from "@omp-ui/server";
import { FleetServer, runFleetCommand } from "./fleet-server";

const posix = process.platform === "win32" ? describe.skip : describe;

const A: FleetRequester = { instanceId: "inst-a", label: "studio", kind: "agent", sourceTabId: "tab-1" };

let base: string;
let registry: Registry;
let broadcasts: number;
let installProviderKey: (envName: string, value: string) => void;
let live: FleetServer[];

function server(
  execGit?: ConstructorParameters<typeof FleetServer>[0]["execGit"],
  addProject?: ConstructorParameters<typeof FleetServer>[0]["addProject"],
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
    ...(execGit === undefined ? {} : { execGit }),
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
    const s = new FleetServer({
      registry,
      logDir: path.join(base, "logs"),
      broadcast: () => {},
      addProject: async () => {},
      installProviderKey: () => {},
      commandDeps: { spawnFn },
    });
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
