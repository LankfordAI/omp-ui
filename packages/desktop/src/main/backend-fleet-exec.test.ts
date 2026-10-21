import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, type BackendState, type FleetAuditEntry, type FleetRequester } from "@omp-ui/core";
import { MainBackend } from "./backend";
import { seedRegistry } from "./test/fixtures";

// The real MainBackend imports electron; stub the surfaces it touches (backend-remote-instances.test.ts's pattern).
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_stub",
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
  },
}));

const win = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, isCrashed: () => false, send: () => {} },
};

const TOKEN = "member-join-token-0123456789";
const MANAGER: FleetRequester = { instanceId: "manager-1", label: "desk", kind: "agent", sourceTabId: "tab-9" };

let base: string;
let registryFile: string;
const backends: MainBackend[] = [];

function boot(): MainBackend {
  handlers.clear();
  const be = new MainBackend(win as never, registryFile, { appVersion: "1.2.3" });
  be.registerIpc();
  backends.push(be);
  return be;
}

function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(fn(null, ...args)) as Promise<T>;
}

const exec = (command: string) => invoke<{ status: string; reason?: string; exitCode?: number; stdout?: string }>(CH.fleetExec, { requester: MANAGER, command, cwd: null, timeoutMs: 2_000 });

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-backend-fleet-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, { settings: { remoteToken: TOKEN } });
});

afterEach(() => {
  for (const be of backends.splice(0)) be.killAll();
  fs.rmSync(base, { recursive: true, force: true });
});

// The proxied fleet channels land on these handlers on the owning instance;
// every decision below is the member's own.
describe.skipIf(process.platform === "win32")("fleet exec ladder wiring (issue #901)", () => {
  it("keeps exec unreachable by default and reports the default rung", async () => {
    boot();
    expect(await invoke(CH.fleetGrantRung, MANAGER)).toEqual({ rung: "dispatch", ceiling: "dispatch", execEnabled: false });
    expect(await exec("echo hi")).toMatchObject({ status: "refused" });
    const state = await invoke<BackendState>(CH.getState);
    expect(state).toMatchObject({ fleetExecEnabled: false, fleetExecCeiling: "dispatch", fleetProjectRoots: [] });
    // First sight names the dispatcher without granting anything.
    expect(state.fleetGrants[MANAGER.instanceId]).toMatchObject({ label: "desk" });
    expect(state.fleetGrants[MANAGER.instanceId]?.rung).toBeUndefined();
  });

  it("runs only once the master switch, the ceiling, and the grant all allow it", async () => {
    boot();
    await invoke(CH.setFleetExecEnabled, true);
    await invoke(CH.setFleetExecCeiling, "full");
    expect(await exec("echo hi")).toMatchObject({ status: "refused" }); // default grant is dispatch
    await invoke(CH.fleetGrantSet, MANAGER.instanceId, "full");
    expect(await exec("echo hi")).toMatchObject({ status: "accepted", exitCode: 0, stdout: "hi\n" });
    await invoke(CH.setFleetExecEnabled, false); // the switch lands on the next request
    expect(await exec("echo hi")).toMatchObject({ status: "refused", reason: expect.stringContaining("fleet exec is off") });

    const audit = await invoke<FleetAuditEntry[]>(CH.fleetAudit);
    expect(audit.filter((e) => e.action === "exec").map((e) => e.accepted)).toEqual([false, true, false]);
    expect(audit.find((e) => e.accepted && e.action === "exec")).toMatchObject({ dispatcherLabel: "desk", rung: "full", exitCode: 0 });
  });

  it("raises a grant only with this machine's token, clamped by the ceiling", async () => {
    boot();
    await invoke(CH.setFleetExecEnabled, true);
    await invoke(CH.setFleetExecCeiling, "full");
    expect(await invoke(CH.fleetGrantRaise, { requester: MANAGER, targetRung: "full", credential: "wrong" })).toMatchObject({ ok: false });
    expect(await exec("echo hi")).toMatchObject({ status: "refused" });
    expect(await invoke(CH.fleetGrantRaise, { requester: MANAGER, targetRung: "full", credential: TOKEN })).toEqual({ ok: true, rung: "full" });
    expect(await exec("echo hi")).toMatchObject({ status: "accepted" });

    // Lowering the ceiling caps the stored grant without touching it.
    await invoke(CH.setFleetExecCeiling, "manage");
    expect(await invoke(CH.fleetGrantRung, MANAGER)).toMatchObject({ rung: "manage" });
    expect(await exec("echo hi")).toMatchObject({ status: "refused" });
  });

  it("refuses a foreign fleet spawn below dispatch before any session starts", async () => {
    boot();
    await invoke(CH.fleetGrantSet, MANAGER.instanceId, "observe");
    const spawn = invoke(CH.spawnSession, {
      origin: "new",
      projectCwd: path.join(base, "proj"),
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
      worktree: null,
      planMode: false,
      fleet: { dispatchId: "d-1", batchId: null, title: "Fix the flake", prompt: "go", requestedBy: { ...MANAGER, kind: "user", sourceTabId: null } },
    });
    await expect(spawn).rejects.toThrow(/^fleet access refused — desk holds fleet access "observe"/);
    expect((await invoke<BackendState>(CH.getState)).projects.flatMap((g) => g.sessions)).toEqual([]);
  });

  it("sanitizes declared roots to absolute paths", async () => {
    boot();
    await invoke(CH.setFleetProjectRoots, ["/srv/repos", "relative", "C:\\code"]);
    expect((await invoke<BackendState>(CH.getState)).fleetProjectRoots).toEqual(["/srv/repos", "C:\\code"]);
  });

  // #906: a fleet register lands on the same add path as the user's project:add.
  it("registers a fleet checkout through the shared add path, key and all", async () => {
    boot();
    const root = path.join(base, "roots");
    const checkout = path.join(root, "app");
    fs.mkdirSync(checkout, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: checkout });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], { cwd: checkout });
    await invoke(CH.setFleetProjectRoots, [root]);
    await invoke(CH.setFleetExecCeiling, "manage");
    await invoke(CH.fleetGrantSet, MANAGER.instanceId, "manage");
    expect(await invoke(CH.fleetProjectManage, { requester: MANAGER, verb: "register", path: checkout })).toMatchObject({ status: "accepted" });
    const real = fs.realpathSync(checkout);
    await vi.waitFor(async () => {
      const project = (await invoke<BackendState>(CH.getState)).projects.find((g) => g.project.path === real)?.project;
      expect(project?.repositoryKey).toBe("github.com/acme/app");
    });
  });
});
