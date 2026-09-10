import type { spawn as spawnFn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HostPairing, HostStatus } from "@omp-ui/core";
import { HOST_PROTOCOL, InstanceConnectError, type InstanceClient, type ServerHello } from "@omp-ui/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerRecordV1 } from "./authority/lock";
import type { HostConnectionRecordV1 } from "@omp-ui/core";
import {
  defaultIsDesktopInstalled,
  defaultLaunchDesktop,
  EXIT,
  runCli,
  type CliDeps,
  type CliIo,
} from "./cli";
import type { Supervisor, SupervisorStatus } from "./supervisor";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cli-"));
  dirs.push(d);
  return fs.realpathSync.native(d);
}

function makeIo(dataRoot: string, extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: { OMP_UI_DATA_DIR: dataRoot },
    platform: "linux",
    home: "/home/me",
    ...extra,
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

const RECORD: HostConnectionRecordV1 = {
  schemaVersion: 1,
  dataRoot: "/data",
  hostVersion: "1.2.3",
  hostProtocol: 2,
  protocolRange: { min: 1, max: 2 },
  endpoint: "http://127.0.0.1:4677",
  desktopCredential: "omp1.desk.DESKTOPSECRET",
  controlCredential: "omp1.ctl.CONTROLSECRET",
  pid: 4242,
  processStartMs: 100,
  startedAtMs: 1_000,
  incarnation: 7,
};

const LOCK: OwnerRecordV1 = {
  schemaVersion: 1,
  pid: 4242,
  bootId: "boot-1",
  processStartMs: 100,
  startedAtMs: 1_000,
  incarnation: 7,
  hostVersion: "1.2.3",
  dataRoot: "/data",
  flavor: "installed",
};

const STATUS: HostStatus = {
  schemaVersion: 1,
  dataRoot: "/data",
  hostVersion: "1.2.3",
  hostProtocol: 2,
  protocolRange: { min: 1, max: 2 },
  pid: 4242,
  startedAtMs: 1_000,
  incarnation: 7,
  liveSessions: 2,
  connections: 1,
  verifier: { state: "ready", reason: null, pin: "153.0.8010.36" },
  credentialBackend: "libsecret",
  hostUpdate: {
    currentVersion: "1.2.3",
    latestVersion: null,
    stagedVersion: "1.2.4",
    status: "staged",
    progress: null,
    graceDeadlineMs: null,
    deferrals: 0,
    deferralLimit: 3,
    affectedTabIds: [],
    lastAttempt: { fromVersion: "1.2.2", toVersion: "1.2.3", outcome: "applied", atMs: 900 },
    rollbackVersion: "1.2.2",
    currentIsStaged: false,
    error: null,
  },
};

const PAIRING: HostPairing = {
  urls: ["http://192.168.1.5:4677/"],
  tokenUrls: ["http://192.168.1.5:4677/?t=TOKENSECRET"],
  hasPassword: true,
};

const HELLO: ServerHello = {
  t: "hello",
  verdict: "compatible",
  hostVersion: "1.2.3",
  hostProtocol: 2,
  protocolRange: { min: 1, max: 2 },
  reason: null,
};

type StopBehaviour = "close" | "hang" | "reject";

interface FakeClientOpts {
  answers?: Partial<Record<string, unknown | (() => Promise<unknown>)>>;
  stop?: StopBehaviour;
  hello?: ServerHello | null;
}

function fakeClient(opts: FakeClientOpts = {}) {
  const closeCbs: Array<(code: number, reason: string) => void> = [];
  const requests: Array<[string, unknown[]]> = [];
  const closed = vi.fn();
  const answers: Partial<Record<string, unknown>> = { "host:status": STATUS, "host:pair": PAIRING, ...opts.answers };
  const client: InstanceClient = {
    hello: opts.hello === undefined ? HELLO : opts.hello,
    request<Result>(channel: string, args: unknown[]): Promise<Result> {
      requests.push([channel, args]);
      if (channel === "host:stop") {
        const mode = opts.stop ?? "close";
        if (mode === "hang") return new Promise<Result>(() => {});
        if (mode === "reject") return Promise.reject(new Error("stop is not permitted for this connection"));
        // The real host closes the socket: pendings reject, then close callbacks fire, synchronously.
        return new Promise<Result>((_, reject) => {
          queueMicrotask(() => {
            reject(new Error("remote connection lost"));
            for (const cb of closeCbs) cb(1001, "host stopping");
          });
        });
      }
      const answer = answers[channel];
      if (typeof answer === "function") return (answer as () => Promise<Result>)();
      if (answer === undefined) return Promise.reject(new Error(`unknown channel ${channel}`));
      return Promise.resolve(answer as Result);
    },
    notify() {},
    onEvent() {},
    onClose(cb) {
      closeCbs.push(cb);
    },
    close: closed,
  };
  return { client, requests, closed };
}

function fakeSupervisor(status: SupervisorStatus, hooks: Partial<Pick<Supervisor, "install" | "uninstall">> = {}) {
  const install = vi.fn(hooks.install ?? (async () => {}));
  const uninstall = vi.fn(hooks.uninstall ?? (async () => {}));
  const supervisor = {
    id: "systemd-user",
    definitionPath: "/home/me/.config/systemd/user/omp-ui-host.service",
    render: () => "",
    parse: () => ({ ours: true, execStart: null }),
    install,
    status: async () => status,
    uninstall,
  } as unknown as Supervisor;
  return { supervisor, install, uninstall };
}

interface DepsOpts {
  record?: HostConnectionRecordV1 | null;
  lock?: OwnerRecordV1 | null;
  client?: FakeClientOpts;
  connectError?: InstanceConnectError;
  supervisorStatus?: SupervisorStatus;
  supervisorHooks?: Partial<Pick<Supervisor, "install" | "uninstall">>;
  desktopInstalled?: boolean;
}

function makeDeps(opts: DepsOpts = {}) {
  const fake = fakeClient(opts.client);
  const sup = fakeSupervisor(opts.supervisorStatus ?? { kind: "installed", running: true, foreign: false, path: "/unit", detail: "active" }, opts.supervisorHooks);
  const connect = vi.fn(async () => {
    if (opts.connectError) throw opts.connectError;
    return fake.client;
  });
  const serve = vi.fn(async () => 0);
  const launchDesktop = vi.fn(async () => 0);
  const deps: CliDeps = {
    version: "1.2.3",
    flavor: "installed",
    now: () => 5_000,
    serve,
    readHostRecord: () => (opts.record === undefined ? RECORD : opts.record),
    readLock: () => (opts.lock === undefined ? LOCK : opts.lock),
    connect: connect as unknown as CliDeps["connect"],
    supervisor: () => sup.supervisor,
    launchDesktop,
    isDesktopInstalled: () => opts.desktopInstalled ?? false,
  };
  return { deps, connect, serve, launchDesktop, ...fake, ...sup };
}

const unreachable = new InstanceConnectError({ kind: "unreachable", message: "ECONNREFUSED" });
const incompatible = new InstanceConnectError({
  kind: "incompatible",
  hostVersion: "9.0.0",
  protocolRange: { min: 5, max: 6 },
  reason: "protocol 2 unsupported; host supports 5..6",
});

describe("runCli dispatch", () => {
  it("prints help and exits 0 with no command and no installed desktop", async () => {
    const root = tmpRoot();
    const { io, stdout } = makeIo(root);
    const { deps, launchDesktop } = makeDeps({ desktopInstalled: false });
    expect(await runCli([], io, deps)).toBe(EXIT.OK);
    expect(stdout()).toContain("Usage: omp-ui");
    expect(stdout()).toContain("6  unsupported platform");
    expect(launchDesktop).not.toHaveBeenCalled();
  });

  it("starts the desktop with no command when one is installed", async () => {
    const { io } = makeIo(tmpRoot());
    const { deps, launchDesktop } = makeDeps({ desktopInstalled: true });
    launchDesktop.mockResolvedValue(EXIT.OPERATIONAL);
    expect(await runCli([], io, deps)).toBe(EXIT.OPERATIONAL);
    expect(launchDesktop).toHaveBeenCalledWith(io);
  });

  it("`desktop` launches even when detection says absent, so the launcher can explain", async () => {
    const { io } = makeIo(tmpRoot());
    const { deps, launchDesktop } = makeDeps({ desktopInstalled: false });
    expect(await runCli(["desktop"], io, deps)).toBe(EXIT.OK);
    expect(launchDesktop).toHaveBeenCalledOnce();
  });

  it("prints the version", async () => {
    const { io, stdout } = makeIo(tmpRoot());
    expect(await runCli(["--version"], io, makeDeps().deps)).toBe(EXIT.OK);
    expect(stdout()).toBe("1.2.3\n");
  });

  it("unknown command → usage on stderr, exit 2, nothing on stdout", async () => {
    const { io, stdout, stderr } = makeIo(tmpRoot());
    expect(await runCli(["frobnicate"], io, makeDeps().deps)).toBe(EXIT.USAGE);
    expect(stderr()).toMatch(/unknown command frobnicate/);
    expect(stderr()).toContain("Usage: omp-ui");
    expect(stdout()).toBe("");
  });

  it("unknown flag and stray positional are usage errors that never probe", async () => {
    const { io } = makeIo(tmpRoot());
    const { deps, connect } = makeDeps();
    expect(await runCli(["status", "--verbose"], io, deps)).toBe(EXIT.USAGE);
    expect(await runCli(["stop", "now"], io, deps)).toBe(EXIT.USAGE);
    expect(await runCli(["stop", "--timeout"], io, deps)).toBe(EXIT.USAGE);
    expect(await runCli(["stop", "--timeout", "-1"], io, deps)).toBe(EXIT.USAGE);
    expect(await runCli(["service"], io, deps)).toBe(EXIT.USAGE);
    expect(await runCli(["service", "dance"], io, deps)).toBe(EXIT.USAGE);
    expect(connect).not.toHaveBeenCalled();
  });

  it("`serve` receives the data root resolved from OMP_UI_DATA_DIR and returns its exit code", async () => {
    const root = tmpRoot();
    const { io } = makeIo(root);
    const { deps, serve } = makeDeps();
    serve.mockResolvedValue(EXIT.AUTHORITY_CONFLICT);
    expect(await runCli(["serve"], io, deps)).toBe(EXIT.AUTHORITY_CONFLICT);
    expect(serve).toHaveBeenCalledWith({ dataRoot: root });
  });
});

describe("status", () => {
  it("absent: no record and no lock → exit 3 with the minimal shape", async () => {
    const root = tmpRoot();
    const { io, stdout } = makeIo(root);
    const { deps, connect } = makeDeps({ record: null, lock: null });
    expect(await runCli(["status", "--json"], io, deps)).toBe(EXIT.ABSENT);
    expect(JSON.parse(stdout())).toEqual({ schemaVersion: 1, state: "absent", dataRoot: root });
    expect(connect).not.toHaveBeenCalled();
  });

  it("running: probes with the control credential and a 2 s hello, reports every field, closes", async () => {
    const root = tmpRoot();
    const { io, stdout } = makeIo(root);
    const { deps, connect, requests, closed } = makeDeps();
    expect(await runCli(["status", "--json"], io, deps)).toBe(EXIT.OK);
    expect(connect).toHaveBeenCalledWith(RECORD.endpoint, RECORD.controlCredential, {
      timeoutMs: 2000,
      hello: { clientRole: "browser", clientKind: "browser", clientVersion: "1.2.3", clientProtocol: HOST_PROTOCOL },
    });
    expect(requests).toEqual([["host:status", []]]);
    expect(closed).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout())).toEqual({
      schemaVersion: 1,
      state: "running",
      dataRoot: root,
      runtime: { pid: 4242, startedAtMs: 1_000, incarnation: 7, endpoint: RECORD.endpoint },
      owner: LOCK,
      versions: { host: "1.2.3", protocol: 2, range: { min: 1, max: 2 }, verdict: "compatible" },
      staged: { matchesCurrent: false },
      lastUpdateAttempt: { fromVersion: "1.2.2", toVersion: "1.2.3", outcome: "applied", atMs: 900 },
      rollbackVersion: "1.2.2",
      verifier: { state: "ready", reason: null, pin: "153.0.8010.36" },
      credentialBackend: "libsecret",
      supervisor: { kind: "installed", running: true, foreign: false, path: "/unit", detail: "active" },
      logs: { dir: path.join(root, "logs") },
    });
  });

  it("staged matches current when nothing is staged or the running build is the staged one", async () => {
    const root = tmpRoot();
    const { io, stdout } = makeIo(root);
    const hostUpdate = { ...STATUS.hostUpdate, stagedVersion: "1.2.3", currentIsStaged: true };
    const { deps } = makeDeps({ client: { answers: { "host:status": { ...STATUS, hostUpdate } } } });
    await runCli(["status", "--json"], io, deps);
    expect(JSON.parse(stdout()).staged).toEqual({ matchesCurrent: true });
  });

  it("human output is aligned key/value lines", async () => {
    const root = tmpRoot();
    const { io, stdout } = makeIo(root);
    expect(await runCli(["status"], io, makeDeps().deps)).toBe(EXIT.OK);
    const lines = stdout().split("\n").filter(Boolean);
    expect(lines[0]).toMatch(/^schemaVersion\s+1$/);
    expect(lines).toContain(lines.find((l) => /^state\s+running$/.test(l)));
    expect(lines.find((l) => l.startsWith("runtime.pid"))).toMatch(/^runtime\.pid\s+4242$/);
    const gap = lines.map((l) => l.indexOf("  ")).filter((i) => i > 0);
    // Every value column starts at one position: keys are padded to the widest.
    const valueColumns = new Set(lines.map((l) => l.search(/(?<=\S)\s{2,}\S/) + l.match(/(?<=\S)\s{2,}/)![0].length));
    expect(gap.length).toBe(lines.length);
    expect(valueColumns.size).toBe(1);
  });

  it("unresponsive: record present but the probe fails → exit 4", async () => {
    const root = tmpRoot();
    const { io, stdout } = makeIo(root);
    const { deps } = makeDeps({ connectError: unreachable });
    expect(await runCli(["status", "--json"], io, deps)).toBe(EXIT.UNHEALTHY);
    expect(JSON.parse(stdout())).toMatchObject({
      schemaVersion: 1,
      state: "unresponsive",
      runtime: { pid: 4242, endpoint: RECORD.endpoint },
      owner: LOCK,
      reason: "ECONNREFUSED",
      logs: { dir: path.join(root, "logs") },
    });
  });

  it("incompatible: the host's hello verdict names the reason → exit 4", async () => {
    const root = tmpRoot();
    const { io, stdout } = makeIo(root);
    const { deps } = makeDeps({ connectError: incompatible });
    expect(await runCli(["status", "--json"], io, deps)).toBe(EXIT.UNHEALTHY);
    expect(JSON.parse(stdout())).toMatchObject({
      state: "incompatible",
      versions: { host: "9.0.0", verdict: "incompatible" },
      reason: "protocol 2 unsupported; host supports 5..6",
    });
  });

  it("a lock without a record is unresponsive, not absent", async () => {
    const { io, stdout } = makeIo(tmpRoot());
    const { deps, connect } = makeDeps({ record: null });
    expect(await runCli(["status", "--json"], io, deps)).toBe(EXIT.UNHEALTHY);
    expect(JSON.parse(stdout())).toMatchObject({ state: "unresponsive", owner: LOCK });
    expect(connect).not.toHaveBeenCalled();
  });

  it("a released lock without a record is a stopped host: absent, naming the last owner", async () => {
    const root = tmpRoot();
    const { io, stdout } = makeIo(root);
    const released = { ...LOCK, releasedAtMs: 1_700_000_100_000 };
    const { deps, connect } = makeDeps({ record: null, lock: released });
    expect(await runCli(["status", "--json"], io, deps)).toBe(EXIT.ABSENT);
    expect(JSON.parse(stdout())).toEqual({ schemaVersion: 1, state: "absent", dataRoot: root, lastOwner: released });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("pair", () => {
  it("prints the password sign-in URL, hides token URLs, and never leaks a credential", async () => {
    const { io, stdout, stderr } = makeIo(tmpRoot());
    const { deps, requests, closed } = makeDeps();
    expect(await runCli(["pair"], io, deps)).toBe(EXIT.OK);
    expect(stdout()).toBe("password sign-in: http://192.168.1.5:4677/\n");
    expect(requests).toEqual([["host:pair", []]]);
    expect(closed).toHaveBeenCalledOnce();
    const everything = stdout() + stderr();
    expect(everything).not.toContain("TOKENSECRET");
    expect(everything).not.toContain(RECORD.desktopCredential);
    expect(everything).not.toContain(RECORD.controlCredential);
  });

  it("--all adds the full-access token URLs; --json mirrors the same gating", async () => {
    const { io, stdout } = makeIo(tmpRoot());
    expect(await runCli(["pair", "--all"], io, makeDeps().deps)).toBe(EXIT.OK);
    expect(stdout()).toBe(
      "password sign-in: http://192.168.1.5:4677/\nfull access (token): http://192.168.1.5:4677/?t=TOKENSECRET\n",
    );

    const plain = makeIo(tmpRoot());
    await runCli(["pair", "--json"], plain.io, makeDeps().deps);
    expect(JSON.parse(plain.stdout())).toEqual({ schemaVersion: 1, hasPassword: true, urls: PAIRING.urls });

    const all = makeIo(tmpRoot());
    await runCli(["pair", "--json", "--all"], all.io, makeDeps().deps);
    expect(JSON.parse(all.stdout())).toEqual({
      schemaVersion: 1,
      hasPassword: true,
      urls: PAIRING.urls,
      tokenUrls: PAIRING.tokenUrls,
    });
  });

  it("labels a token-only host plainly", async () => {
    const { io, stdout } = makeIo(tmpRoot());
    const { deps } = makeDeps({ client: { answers: { "host:pair": { ...PAIRING, hasPassword: false } } } });
    await runCli(["pair"], io, deps);
    expect(stdout()).toBe("sign-in: http://192.168.1.5:4677/\n");
  });

  it("absent → 3, unreachable → 4, on stderr", async () => {
    const absent = makeIo(tmpRoot());
    expect(await runCli(["pair"], absent.io, makeDeps({ record: null }).deps)).toBe(EXIT.ABSENT);
    expect(absent.stderr()).toMatch(/no host running/);
    expect(absent.stdout()).toBe("");

    const down = makeIo(tmpRoot());
    expect(await runCli(["pair"], down.io, makeDeps({ connectError: unreachable }).deps)).toBe(EXIT.UNHEALTHY);
    expect(down.stderr()).toMatch(/unresponsive: ECONNREFUSED/);
  });
});

describe("stop", () => {
  it("no record → idempotent success", async () => {
    const { io, stdout } = makeIo(tmpRoot());
    const { deps, connect } = makeDeps({ record: null });
    expect(await runCli(["stop"], io, deps)).toBe(EXIT.OK);
    expect(stdout()).toBe("no host running\n");
    expect(connect).not.toHaveBeenCalled();
  });

  it("the host closing the socket is success", async () => {
    const { io, stdout } = makeIo(tmpRoot());
    const { deps, requests } = makeDeps();
    expect(await runCli(["stop"], io, deps)).toBe(EXIT.OK);
    expect(requests).toEqual([["host:stop", []]]);
    expect(stdout()).toBe("stopped host pid 4242\n");
  });

  it("a host that never exits within --timeout → 4, closed, never killed", async () => {
    const { io, stderr } = makeIo(tmpRoot());
    const { deps, closed } = makeDeps({ client: { stop: "hang" } });
    expect(await runCli(["stop", "--timeout", "0.05"], io, deps)).toBe(EXIT.UNHEALTHY);
    expect(stderr()).toMatch(/pid 4242 .* did not exit within 0\.05 s; not killed/);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("a refused stop is an operational failure", async () => {
    const { io, stderr } = makeIo(tmpRoot());
    expect(await runCli(["stop"], io, makeDeps({ client: { stop: "reject" } }).deps)).toBe(EXIT.OPERATIONAL);
    expect(stderr()).toMatch(/stop refused: stop is not permitted/);
  });

  it("an unreachable host with a record left behind → 4", async () => {
    const { io } = makeIo(tmpRoot());
    expect(await runCli(["stop"], io, makeDeps({ connectError: unreachable }).deps)).toBe(EXIT.UNHEALTHY);
  });
});

describe("rollback", () => {
  it("requests host-update:rollback on a live host", async () => {
    const { io, stdout } = makeIo(tmpRoot());
    const { deps, requests, closed } = makeDeps({ client: { answers: { "host-update:rollback": null } } });
    expect(await runCli(["rollback"], io, deps)).toBe(EXIT.OK);
    expect(requests).toEqual([["host-update:rollback", []]]);
    expect(closed).toHaveBeenCalledOnce();
    expect(stdout()).toMatch(/rollback requested/);
  });

  it("a host error → 1; absent → 3", async () => {
    const failing = makeIo(tmpRoot());
    const { deps } = makeDeps({
      client: { answers: { "host-update:rollback": () => Promise.reject(new Error("no rollback target")) } },
    });
    expect(await runCli(["rollback"], failing.io, deps)).toBe(EXIT.OPERATIONAL);
    expect(failing.stderr()).toMatch(/rollback failed: no rollback target/);
    expect(await runCli(["rollback"], makeIo(tmpRoot()).io, makeDeps({ record: null }).deps)).toBe(EXIT.ABSENT);
  });
});

describe("service", () => {
  const installed = (running: boolean, foreign = false): SupervisorStatus => ({
    kind: "installed",
    running,
    foreign,
    path: "/unit",
    detail: running ? "active" : "inactive",
  });

  it("install passes the exec path, data root, and log dir to the supervisor", async () => {
    const root = tmpRoot();
    const { io, stdout } = makeIo(root, { env: { OMP_UI_DATA_DIR: root, OMP_UI_EXEC_PATH: "/opt/omp-ui/bin/omp-ui" } });
    const { deps, install } = makeDeps();
    expect(await runCli(["service", "install"], io, deps)).toBe(EXIT.OK);
    expect(install).toHaveBeenCalledWith({
      execPath: "/opt/omp-ui/bin/omp-ui",
      dataRoot: root,
      logDir: path.join(root, "logs"),
    });
    expect(stdout()).toContain("omp-ui-host.service");
  });

  it("install failures map linger/foreign/unsupported to 6 and anything else to 1", async () => {
    for (const [message, code] of [
      ["linger not enabled", EXIT.UNSUPPORTED],
      ["foreign supervisor definition at /unit", EXIT.UNSUPPORTED],
      ["unsupported platform: freebsd", EXIT.UNSUPPORTED],
      ["EACCES: permission denied, open '/unit'", EXIT.UNSUPPORTED],
      ["systemctl daemon-reload exited 1", EXIT.OPERATIONAL],
    ] as const) {
      const { io, stderr } = makeIo(tmpRoot());
      const { deps } = makeDeps({ supervisorHooks: { install: async () => { throw new Error(message); } } });
      expect(await runCli(["service", "install"], io, deps)).toBe(code);
      expect(stderr()).toContain(message);
    }
  });

  it("status exit codes: absent 3, running 0, installed-not-running 4, foreign 6, unsupported 6", async () => {
    const cases: Array<[SupervisorStatus, number]> = [
      [{ kind: "absent" }, EXIT.ABSENT],
      [installed(true), EXIT.OK],
      [installed(false), EXIT.UNHEALTHY],
      [installed(true, true), EXIT.UNSUPPORTED],
      [{ kind: "unsupported", reason: "no launchd" }, EXIT.UNSUPPORTED],
    ];
    for (const [status, code] of cases) {
      const { io, stdout, stderr } = makeIo(tmpRoot());
      expect(await runCli(["service", "status", "--json"], io, makeDeps({ supervisorStatus: status }).deps)).toBe(code);
      expect(JSON.parse(stdout())).toMatchObject({ schemaVersion: 1, supervisor: status, host: { state: "running" } });
      if (status.kind === "installed" && status.foreign) expect(stderr()).toMatch(/not owned by omp-ui/);
    }
  });

  it("status of an installed, running definition still needs a responsive host", async () => {
    const { io } = makeIo(tmpRoot());
    const { deps } = makeDeps({ supervisorStatus: installed(true), connectError: unreachable });
    expect(await runCli(["service", "status"], io, deps)).toBe(EXIT.UNHEALTHY);
  });

  it("uninstall --purge-data without --yes is a usage error and touches nothing", async () => {
    const { io, stderr } = makeIo(tmpRoot());
    const { deps, uninstall, connect } = makeDeps();
    expect(await runCli(["service", "uninstall", "--purge-data"], io, deps)).toBe(EXIT.USAGE);
    expect(stderr()).toMatch(/pass --yes to confirm/);
    expect(uninstall).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("uninstall stops the host first, then removes the definition; purge carries the root", async () => {
    const root = tmpRoot();
    const { io, stdout } = makeIo(root);
    const { deps, uninstall, requests } = makeDeps();
    expect(await runCli(["service", "uninstall"], io, deps)).toBe(EXIT.OK);
    expect(requests).toEqual([["host:stop", []]]);
    expect(uninstall).toHaveBeenCalledWith({ purgeData: false });
    expect(stdout()).toMatch(/data preserved/);

    const purge = makeDeps({ record: null });
    expect(await runCli(["service", "uninstall", "--purge-data", "--yes"], makeIo(root).io, purge.deps)).toBe(EXIT.OK);
    expect(purge.uninstall).toHaveBeenCalledWith({ purgeData: true, dataRoot: root });
  });

  it("uninstall keeps the definition when the host will not stop", async () => {
    const { io } = makeIo(tmpRoot());
    const { deps, uninstall } = makeDeps({ client: { stop: "reject" } });
    expect(await runCli(["service", "uninstall"], io, deps)).toBe(EXIT.OPERATIONAL);
    expect(uninstall).not.toHaveBeenCalled();
  });
});

describe("desktop launcher", () => {
  function spawnFake(outcome: "spawn" | "error") {
    const calls: Array<[string, string[]]> = [];
    const spawn = ((command: string, args: string[]) => {
      calls.push([command, args]);
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      queueMicrotask(() => {
        if (outcome === "spawn") child.emit("spawn");
        else child.emit("error", new Error("ENOEXEC"));
      });
      return child;
    }) as unknown as typeof spawnFn;
    return { spawn, calls };
  }

  it("launches the Linux desktop wrapper when installed, else the AppImage, detached", async () => {
    const { io } = makeIo(tmpRoot());
    const appImage = "/home/me/.local/bin/omp-ui.AppImage";
    const wrapper = "/home/me/.local/bin/omp-ui-desktop";
    expect(defaultIsDesktopInstalled(io, (p) => p === appImage)).toBe(true);
    expect(defaultIsDesktopInstalled(io, (p) => p === wrapper)).toBe(true);
    expect(defaultIsDesktopInstalled(io, () => false)).toBe(false);
    const viaImage = spawnFake("spawn");
    expect(await defaultLaunchDesktop(io, { exists: (p) => p === appImage, spawn: viaImage.spawn })).toBe(EXIT.OK);
    expect(viaImage.calls).toEqual([[appImage, []]]);
    const viaWrapper = spawnFake("spawn");
    const both = (p: string): boolean => p === appImage || p === wrapper;
    expect(await defaultLaunchDesktop(io, { exists: both, spawn: viaWrapper.spawn })).toBe(EXIT.OK);
    expect(viaWrapper.calls).toEqual([[wrapper, []]]);
  });

  it("uses `open -a` on macOS and the installed exe on Windows", async () => {
    const mac = makeIo(tmpRoot(), { platform: "darwin", home: "/Users/me" });
    const macSpawn = spawnFake("spawn");
    expect(await defaultLaunchDesktop(mac.io, { exists: (p) => p === "/Applications/omp-ui.app", spawn: macSpawn.spawn })).toBe(EXIT.OK);
    expect(macSpawn.calls).toEqual([["open", ["-a", "omp-ui"]]]);

    const win = makeIo(tmpRoot(), { platform: "win32", home: "C:\\Users\\me", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } });
    const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\omp-ui\\omp-ui.exe";
    expect(defaultIsDesktopInstalled(win.io, (p) => p === exe)).toBe(true);
    const winSpawn = spawnFake("spawn");
    expect(await defaultLaunchDesktop(win.io, { exists: (p) => p === exe, spawn: winSpawn.spawn })).toBe(EXIT.OK);
    expect(winSpawn.calls).toEqual([[exe, []]]);
  });

  it("an absent client is operational (1); an undefined platform is unsupported (6); a spawn error is 1", async () => {
    const missing = makeIo(tmpRoot());
    const { spawn } = spawnFake("spawn");
    expect(await defaultLaunchDesktop(missing.io, { exists: () => false, spawn })).toBe(EXIT.OPERATIONAL);
    expect(missing.stderr()).toMatch(/not installed at \/home\/me\/\.local\/bin\/omp-ui\.AppImage/);

    const bsd = makeIo(tmpRoot(), { platform: "freebsd" });
    expect(defaultIsDesktopInstalled(bsd.io, () => true)).toBe(false);
    expect(await defaultLaunchDesktop(bsd.io, { exists: () => true, spawn })).toBe(EXIT.UNSUPPORTED);

    const broken = makeIo(tmpRoot());
    const failing = spawnFake("error");
    expect(await defaultLaunchDesktop(broken.io, { exists: () => true, spawn: failing.spawn })).toBe(EXIT.OPERATIONAL);
    expect(broken.stderr()).toMatch(/could not start .*ENOEXEC/);
  });
});
