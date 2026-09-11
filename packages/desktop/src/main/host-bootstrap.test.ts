import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cutoverHandoffPath, type CutoverHandoffV1 } from "@omp-ui/core/cutover-handoff";
import { BCH, type HostBootstrapStatus } from "@omp-ui/core/host-bootstrap-channels";
import type { HostLaunchCommand } from "@omp-ui/core/host-launch";
import { writeHostRecord, type HostConnectionRecordV1 } from "@omp-ui/core/host-record";
import { InstanceConnectError, type InstanceClient } from "@omp-ui/server/client";
import {
  bindHostBootstrapIpc,
  HOST_POLL_INTERVAL_MS,
  HOST_START_TIMEOUT_MS,
  HostBootstrap,
  installEmbeddedHost,
  LEGACY_LAUNCHER_MARKER,
  placeStableCommand,
  type HostBootstrapDeps,
  type HostInstallLayout,
} from "./host-bootstrap";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

// host-bootstrap.ts touches only electron's ipcMain, for the preload binding.
const ipc = vi.hoisted(() => ({ handlers: new Map<string, IpcHandler>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ipc.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      ipc.handlers.delete(channel);
    },
  },
}));

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "omp-ui-bootstrap-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface FakeClient extends InstanceClient {
  requests: Array<{ channel: string; args: unknown[] }>;
  closed: number;
  emitClose(code: number, reason: string): void;
}

function fakeClient(respond: (channel: string) => Promise<unknown> = async () => undefined): FakeClient {
  const closeCbs: Array<(code: number, reason: string) => void> = [];
  const client: FakeClient = {
    hello: null,
    requests: [],
    closed: 0,
    async request<Result>(channel: string, args: unknown[]): Promise<Result> {
      client.requests.push({ channel, args });
      return (await respond(channel)) as Result;
    },
    notify() {},
    onEvent() {},
    onClose(cb) {
      closeCbs.push(cb);
    },
    close() {
      client.closed += 1;
    },
    emitClose(code, reason) {
      for (const cb of closeCbs) cb(code, reason);
    },
  };
  return client;
}

function record(dataRoot: string, over: Partial<HostConnectionRecordV1> = {}): HostConnectionRecordV1 {
  return {
    schemaVersion: 1,
    dataRoot,
    hostVersion: "2.0.0",
    hostProtocol: 2,
    protocolRange: { min: 2, max: 2 },
    endpoint: "http://127.0.0.1:41000",
    desktopCredential: "omp1.desk.secret",
    controlCredential: "omp1.ctl.secret",
    pid: 777,
    processStartMs: 1_000,
    startedAtMs: 2_000,
    incarnation: 1,
    ...over,
  };
}

const unreachable = (): never => {
  throw new InstanceConnectError({ kind: "unreachable", message: "ECONNREFUSED" });
};

/** A seed directory holding one embedded host `version`. */
function seed(version: string): string {
  const dir = mkTmp();
  fs.mkdirSync(join(dir, version, "bin"), { recursive: true });
  fs.mkdirSync(join(dir, version, "lib", "node-pty"), { recursive: true });
  fs.writeFileSync(join(dir, version, "bin", "omp-ui"), "#!/bin/sh\n", { mode: 0o644 });
  fs.writeFileSync(join(dir, version, "bin", "omp-ui.exe"), "MZ");
  fs.writeFileSync(join(dir, version, "lib", "node-pty", "pty.node"), "elf");
  return dir;
}

/** An already installed host at `current -> versions/<version>`. */
function installed(root: string, version: string): string {
  fs.mkdirSync(join(root, "versions", version, "bin"), { recursive: true });
  fs.writeFileSync(join(root, "versions", version, "bin", "omp-ui"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(join("versions", version), join(root, "current"), "dir");
  return join(root, "current", "bin", "omp-ui");
}

interface Harness {
  bootstrap: HostBootstrap;
  deps: HostBootstrapDeps;
  dataRoot: string;
  installRoot: string;
  legacy: string;
  home: string;
  statuses: HostBootstrapStatus[];
  runs: HostLaunchCommand[];
  now: () => number;
}

function harness(over: Partial<HostBootstrapDeps> = {}): Harness {
  const dataRoot = join(mkTmp(), "omp-ui");
  fs.mkdirSync(dataRoot);
  const installRoot = join(mkTmp(), "omp-ui-host");
  const legacy = mkTmp();
  const home = mkTmp();
  const statuses: HostBootstrapStatus[] = [];
  const runs: HostLaunchCommand[] = [];
  let clock = 1_000_000;
  const deps: HostBootstrapDeps = {
    flavor: "installed",
    dataRoot,
    packaged: true,
    platform: "linux",
    clientVersion: "1.2.3",
    clientLogDir: join(legacy, "logs"),
    legacyUserData: legacy,
    install: { root: installRoot, seedDir: null, stableCommand: join(home, ".local", "bin", "omp-ui") },
    pid: 4242,
    processStartMs: 999_000,
    probe: async () => unreachable(),
    control: async () => {
      throw new Error("control not expected");
    },
    run: async (command) => {
      runs.push(command);
      return { code: 0, stderr: "" };
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    nonce: () => "nonce-".padEnd(43, "x"),
    rollbackVersion: () => null,
    log: () => {},
    onStatus: (status) => statuses.push(status),
    ...over,
  };
  return {
    bootstrap: new HostBootstrap(deps),
    deps,
    dataRoot,
    installRoot,
    legacy,
    home,
    statuses,
    runs,
    now: () => clock,
  };
}

const phases = (h: Harness): string[] => h.statuses.map((s) => s.phase);

describe("HostBootstrap: a live host", () => {
  it("probes host.json, hands the client to main, and answers connection() with the record", async () => {
    const client = fakeClient();
    const h = harness({ probe: async () => client });
    writeHostRecord(record(h.dataRoot));
    const adopted: InstanceClient[] = [];
    h.bootstrap.onConnected((c) => adopted.push(c));

    const connection = h.bootstrap.connection();
    h.bootstrap.start();
    await expect(connection).resolves.toEqual({
      endpoint: "http://127.0.0.1:41000",
      desktopCredential: "omp1.desk.secret",
      clientVersion: "1.2.3",
      hostVersion: "2.0.0",
    });
    expect(adopted).toEqual([client]);
    expect(phases(h)).toEqual(["probing", "ready"]);
    expect(h.statuses.at(-1)).toMatchObject({ hostVersion: "2.0.0", hostPid: 777, supervisor: null });
    expect(h.runs).toEqual([]);
    // A later caller gets the same record without waiting.
    await expect(h.bootstrap.connection()).resolves.toMatchObject({ endpoint: "http://127.0.0.1:41000" });
  });

  it("fails with the host's verdict when the hello is incompatible, and never starts a second host", async () => {
    const h = harness({
      probe: async () => {
        throw new InstanceConnectError({
          kind: "incompatible",
          hostVersion: "9.0.0",
          protocolRange: { min: 5, max: 6 },
          reason: "client protocol 2 is below 5",
        });
      },
    });
    writeHostRecord(record(h.dataRoot));
    const connection = h.bootstrap.connection();
    h.bootstrap.start();
    await expect(connection).rejects.toThrow(/host 9\.0\.0 .* refused this client \(v1\.2\.3\): client protocol 2 is below 5/);
    expect(phases(h)).toEqual(["probing", "failed"]);
    expect(h.runs).toEqual([]);
    // Still failed: a fresh connection() call rejects immediately.
    await expect(h.bootstrap.connection()).rejects.toThrow(/refused this client/);
  });

  it("reconnects with backoff when main's connection drops, and reports the stop when it was asked for", async () => {
    let client = fakeClient();
    const h = harness({ probe: async () => client });
    writeHostRecord(record(h.dataRoot));
    h.bootstrap.start();
    await flush();
    expect(phases(h)).toEqual(["probing", "ready"]);

    const first = client;
    client = fakeClient();
    const before = h.now();
    first.emitClose(1006, "");
    expect(h.statuses.at(-1)).toMatchObject({ phase: "probing", message: expect.stringContaining("reconnecting in 1 s") });
    await flush();
    await flush();
    expect(h.now() - before).toBe(1_000);
    expect(h.statuses.at(-1)?.phase).toBe("ready");

    // A second quick loss doubles the wait.
    const second = client;
    client = fakeClient();
    const beforeSecond = h.now();
    second.emitClose(1006, "");
    await flush();
    await flush();
    expect(h.now() - beforeSecond).toBe(2_000);
    expect(h.statuses.at(-1)?.phase).toBe("ready");

    // stop(): the control request goes out; the resulting close is not a crash.
    const control = fakeClient();
    h.deps.control = async () => control;
    await h.bootstrap.stop();
    expect(control.requests).toEqual([{ channel: "host:stop", args: [] }]);
    expect(control.closed).toBe(1);
    client.emitClose(1000, "host stopping");
    await flush();
    expect(h.statuses.at(-1)).toMatchObject({ phase: "failed", message: expect.stringContaining("stopped from this client") });
    await expect(h.bootstrap.connection()).rejects.toThrow(/stopped from this client/);
  });

  it("stop() and rollback() reject by name when there is no record; a mid-request close counts as success", async () => {
    const h = harness();
    await expect(h.bootstrap.stop()).rejects.toThrow(`no host record at ${join(h.dataRoot, "host.json")}: there is no running host to stop`);
    await expect(h.bootstrap.rollback()).rejects.toThrow(/no running host to roll back/);

    writeHostRecord(record(h.dataRoot));
    const control = fakeClient(async () => {
      control.emitClose(1000, "bye");
      throw new Error("remote connection lost");
    });
    h.deps.control = async () => control;
    await expect(h.bootstrap.rollback()).resolves.toBeUndefined();
    expect(control.requests).toEqual([{ channel: "host-update:rollback", args: [] }]);

    const refusing = fakeClient(async () => {
      throw new Error("no previous version retained");
    });
    h.deps.control = async () => refusing;
    await expect(h.bootstrap.rollback()).rejects.toThrow("no previous version retained");
  });
});

describe("HostBootstrap: no live host", () => {
  it("in an unpackaged run, fails naming the dev-serve command for the flavor and the data root", async () => {
    const h = harness({ packaged: false, flavor: "dev-server" });
    const connection = h.bootstrap.connection();
    h.bootstrap.start();
    await expect(connection).rejects.toThrow(
      `no host is serving ${h.dataRoot}. Start one with \`npm run dev:serve -w @omp-ui/host -- --flavor dev-server\``,
    );
    expect(h.runs).toEqual([]);
  });

  it("submits the supervisor start for the installed host, polls the record, and adopts the host that appears", async () => {
    const client = fakeClient();
    const h = harness();
    const execPath = installed(h.installRoot, "1.0.0");
    let polls = 0;
    h.deps.sleep = async () => {
      polls += 1;
      if (polls === 3) writeHostRecord(record(h.dataRoot, { pid: 4321 }));
    };
    h.deps.probe = async (rec) => (rec.pid === 4321 ? client : unreachable());

    const connection = h.bootstrap.connection();
    h.bootstrap.start();
    await expect(connection).resolves.toMatchObject({ endpoint: "http://127.0.0.1:41000" });
    expect(h.runs).toEqual([
      {
        cmd: "systemd-run",
        args: [
          "--user",
          "--unit=omp-ui-host",
          "--property=Restart=no",
          "--collect",
          `--setenv=OMP_UI_DATA_DIR=${h.dataRoot}`,
          "--",
          execPath,
          "serve",
        ],
      },
    ]);
    expect(fs.existsSync(join(h.dataRoot, "logs"))).toBe(true);
    expect(polls).toBe(3);
    expect(phases(h)).toEqual(["probing", "starting", "ready"]);
    expect(h.statuses.at(-1)).toMatchObject({ supervisor: "systemd-user", hostPid: 4321 });
    // No legacy registry: no cutover note.
    expect(fs.existsSync(cutoverHandoffPath(h.dataRoot))).toBe(false);
  });

  it("leaves the cutover note before starting only while the legacy registry is unmigrated", async () => {
    const h = harness();
    installed(h.installRoot, "1.0.0");
    fs.writeFileSync(join(h.legacy, "registry.json"), "{}");
    let noteAtLaunch: CutoverHandoffV1 | null = null;
    h.deps.run = async () => {
      noteAtLaunch = JSON.parse(fs.readFileSync(cutoverHandoffPath(h.dataRoot), "utf8")) as CutoverHandoffV1;
      return { code: 0, stderr: "" };
    };
    h.bootstrap.start();
    await flush();
    expect(noteAtLaunch).toEqual({
      schemaVersion: 1,
      pid: 4242,
      processStartMs: 999_000,
      legacyUserData: h.legacy,
      targetDataRoot: h.dataRoot,
      nonce: "nonce-".padEnd(43, "x"),
      createdAtMs: 1_000_000,
    });
    if (process.platform !== "win32") expect(fs.statSync(cutoverHandoffPath(h.dataRoot)).mode & 0o777).toBe(0o600);
  });

  it("leaves no note once the data root has adopted a registry or journalled the relocation", async () => {
    const committed = JSON.stringify({
      schemaVersion: 1,
      steps: [{ id: "relocate-authority-stores-v1", status: "committed", items: [] }],
    });
    for (const [file, contents] of [
      ["registry.json", "{}"],
      ["migration.json", committed],
    ]) {
      const h = harness();
      installed(h.installRoot, "1.0.0");
      fs.writeFileSync(join(h.legacy, "registry.json"), "{}");
      fs.writeFileSync(join(h.dataRoot, file!), contents!);
      h.bootstrap.start();
      await flush();
      expect(h.runs).toHaveLength(1);
      expect(fs.existsSync(cutoverHandoffPath(h.dataRoot))).toBe(false);
    }
  });

  it.runIf(process.platform !== "win32")("installs the embedded seed when no host is installed, then starts it", async () => {
    const h = harness();
    h.deps.install.seedDir = seed("3.1.0");
    h.bootstrap.start();
    await flush();
    const execPath = join(h.installRoot, "current", "bin", "omp-ui");
    expect(phases(h).slice(0, 3)).toEqual(["probing", "installing", "starting"]);
    expect(fs.readlinkSync(join(h.installRoot, "current"))).toBe(join("versions", "3.1.0"));
    expect(fs.statSync(execPath).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(join(h.installRoot, "versions", "3.1.0", "lib", "node-pty", "pty.node"))).toBe(true);
    expect(fs.existsSync(join(h.installRoot, "versions", ".3.1.0.partial"))).toBe(false);
    expect(fs.readlinkSync(join(h.home, ".local", "bin", "omp-ui"))).toBe(execPath);
    expect(h.runs[0]?.args).toContain(execPath);
  });

  it("keeps polling after a non-zero supervisor exit and reports that exit when no host appears", async () => {
    const h = harness({
      run: async () => ({ code: 1, stderr: "Failed to start transient service unit: Unit omp-ui-host.service already exists.\n" }),
    });
    installed(h.installRoot, "1.0.0");
    const connection = h.bootstrap.connection();
    const start = h.now();
    h.bootstrap.start();
    await expect(connection).rejects.toThrow(
      "systemd-run --user exited 1: Failed to start transient service unit: Unit omp-ui-host.service already exists.; " +
        `no host came up within ${HOST_START_TIMEOUT_MS / 1000} s`,
    );
    expect(h.now() - start).toBeGreaterThanOrEqual(HOST_START_TIMEOUT_MS);
    expect(h.now() - start).toBeLessThan(HOST_START_TIMEOUT_MS + 2 * HOST_POLL_INTERVAL_MS);
    expect(h.statuses.some((s) => s.phase === "starting" && s.message?.includes("may already be starting"))).toBe(true);
  });

  it("times out naming the host log dir and `omp-ui status`", async () => {
    const h = harness();
    installed(h.installRoot, "1.0.0");
    const connection = h.bootstrap.connection();
    h.bootstrap.start();
    await expect(connection).rejects.toThrow(`did not come up within 30 s; check ${join(h.dataRoot, "logs")} or run \`omp-ui status\``);
  });

  it("retry() runs the pass again after a failure", async () => {
    const client = fakeClient();
    const h = harness();
    installed(h.installRoot, "1.0.0");
    h.bootstrap.start();
    await flush();
    expect(h.statuses.at(-1)?.phase).toBe("failed");

    writeHostRecord(record(h.dataRoot));
    h.deps.probe = async () => client;
    await h.bootstrap.retry();
    expect(h.statuses.at(-1)?.phase).toBe("ready");
    expect(h.runs).toHaveLength(1);
  });
});

describe("bindHostBootstrapIpc", () => {
  it("binds the five argless requests, rejects arguments, and unbinds", async () => {
    const client = fakeClient();
    const h = harness({ probe: async () => client });
    writeHostRecord(record(h.dataRoot));
    const unbind = bindHostBootstrapIpc(h.bootstrap);
    expect([...ipc.handlers.keys()].sort()).toEqual(
      [BCH.connection, BCH.retry, BCH.status, BCH.stop, BCH.rollback].sort(),
    );
    const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
      Promise.resolve(ipc.handlers.get(channel)!(null, ...args));

    expect(await invoke(BCH.status)).toMatchObject({ phase: "probing", dataRoot: h.dataRoot });
    await expect(invoke(BCH.status, "extra")).rejects.toThrow("invalid arguments for bootstrap:status");
    h.bootstrap.start();
    expect(await invoke(BCH.connection)).toMatchObject({ desktopCredential: "omp1.desk.secret" });
    expect(await invoke(BCH.status)).toMatchObject({ phase: "ready", hostPid: 777 });

    unbind();
    expect(ipc.handlers.size).toBe(0);
  });
});

describe("installEmbeddedHost", () => {
  const layout = (seedDir: string | null, home: string): HostInstallLayout => ({
    root: join(mkTmp(), "omp-ui-host"),
    seedDir,
    stableCommand: join(home, ".local", "bin", "omp-ui"),
  });

  it("requires exactly one embedded version", () => {
    const empty = mkTmp();
    expect(() => installEmbeddedHost(layout(empty, mkTmp()), "linux")).toThrow(/exactly one embedded host .* found 0/);
    expect(() => installEmbeddedHost(layout(null, mkTmp()), "linux")).toThrow("this build embeds no host");
  });

  it.runIf(process.platform !== "win32")("replaces a current pointer it installed and refuses one it did not", () => {
    const l = layout(seed("2.0.0"), mkTmp());
    installEmbeddedHost(l, "linux");
    // Ours: a symlink into the install root.
    expect(installEmbeddedHost(l, "linux")).toEqual({ version: "2.0.0", execPath: join(l.root, "current", "bin", "omp-ui") });

    fs.rmSync(join(l.root, "current"));
    fs.mkdirSync(join(l.root, "current"));
    expect(() => installEmbeddedHost(l, "linux")).toThrow(`refusing to replace ${join(l.root, "current")}: not a link omp-ui installed`);

    fs.rmdirSync(join(l.root, "current"));
    fs.symlinkSync("/opt/somebody-else", join(l.root, "current"), "dir");
    expect(() => installEmbeddedHost(l, "linux")).toThrow(/points outside/);
  });

  it("on Windows points the bin junction at the version and places no stable command", () => {
    const home = mkTmp();
    const l: HostInstallLayout = { root: join(mkTmp(), "omp-ui-host"), seedDir: seed("2.0.0"), stableCommand: null };
    expect(installEmbeddedHost(l, "win32")).toEqual({ version: "2.0.0", execPath: join(l.root, "bin", "omp-ui.exe") });
    expect(fs.readlinkSync(join(l.root, "bin"))).toBe(join(l.root, "versions", "2.0.0", "bin"));
    expect(fs.existsSync(join(l.root, "current"))).toBe(false);
    expect(fs.existsSync(join(home, ".local", "bin", "omp-ui"))).toBe(false);
  });
});

describe.runIf(process.platform !== "win32")("placeStableCommand (~/.local/bin/omp-ui)", () => {
  const root = "/data/omp-ui-host";
  const target = join(root, "current", "bin", "omp-ui");

  it("places the link when the path is absent", () => {
    const cmd = join(mkTmp(), "omp-ui");
    placeStableCommand(cmd, target, root);
    expect(fs.readlinkSync(cmd)).toBe(target);
  });

  it("replaces a link that points under the install root", () => {
    const cmd = join(mkTmp(), "omp-ui");
    fs.symlinkSync(join(root, "versions", "0.9.0", "bin", "omp-ui"), cmd);
    placeStableCommand(cmd, target, root);
    expect(fs.readlinkSync(cmd)).toBe(target);
  });

  it("replaces the legacy install.sh launcher, recognised by its marker in the first three lines", () => {
    const cmd = join(mkTmp(), "omp-ui");
    fs.writeFileSync(cmd, `#!/usr/bin/env bash\n${LEGACY_LAUNCHER_MARKER}\nexec "$HOME/.local/bin/omp-ui.AppImage" "$@"\n`, { mode: 0o755 });
    placeStableCommand(cmd, target, root);
    expect(fs.lstatSync(cmd).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(cmd)).toBe(target);
  });

  it("refuses a regular file without the marker and a link into someone else's tree, naming the path", () => {
    const foreign = join(mkTmp(), "omp-ui");
    fs.writeFileSync(foreign, `#!/bin/sh\necho mine\necho mine\n${LEGACY_LAUNCHER_MARKER}\n`);
    expect(() => placeStableCommand(foreign, target, root)).toThrow(
      `refusing to replace ${foreign}: not a link omp-ui installed and not its legacy launcher`,
    );
    expect(fs.readFileSync(foreign, "utf8")).toContain("echo mine");

    const elsewhere = join(mkTmp(), "omp-ui");
    fs.symlinkSync("/usr/local/bin/other-omp-ui", elsewhere);
    expect(() => placeStableCommand(elsewhere, target, root)).toThrow(`refusing to replace ${elsewhere}: it points outside ${root}`);
  });
});
