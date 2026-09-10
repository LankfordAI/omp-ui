import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CH, type BreadcrumbSink, type ChannelTable, type ClientRole } from "@omp-ui/core";
import {
  connectInstanceClient,
  HOST_CLOSE_INCOMPATIBLE,
  HOST_PROTOCOL,
  InstanceConnectError,
  mintRemoteToken,
  REMOTE_CLOSE_REVOKED,
  REMOTE_WS_PATH,
  type ConnectionContext,
  type EventScope,
  type HostSurface,
  type InstanceClient,
} from "@omp-ui/server";
import { hostRecordPath, readHostRecord } from "@omp-ui/core";
import { startLocalControl, type LocalControl } from "./local-control";

interface FakeSurface extends HostSurface {
  /** Every context handlers() built a table for, in order (snapshots: the server mutates in place). */
  readonly built: ConnectionContext[];
  emit(scope: EventScope, channel: string, args: unknown[]): void;
}

/** Answers `host:status` only for a control connection — the gating HostApplication performs. */
function fakeSurface(): FakeSurface {
  const built: ConnectionContext[] = [];
  const sinks = new Set<(scope: EventScope, channel: string, args: unknown[]) => void>();
  return {
    built,
    handlers(ctx) {
      built.push({ ...ctx });
      const request: Record<string, () => unknown> = { [CH.getState]: () => ({ self: ctx.role }) };
      if (ctx.control) request[CH.getHostStatus] = () => ({ control: true });
      return { request, notify: {} } as unknown as ChannelTable;
    },
    connectionClosed() {},
    addSink(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    emit(scope, channel, args) {
      for (const sink of sinks) sink(scope, channel, args);
    },
  };
}

const controls: LocalControl[] = [];
const clients: InstanceClient[] = [];
const sockets: WebSocket[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const ws of sockets.splice(0)) ws.close();
  for (const c of controls.splice(0)) await c.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function start() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-local-control-"));
  roots.push(dataRoot);
  const surface = fakeSurface();
  const crumbs: Array<[string, string | undefined]> = [];
  const breadcrumbs: BreadcrumbSink = {
    record: (kind, fields) => {
      crumbs.push([kind, fields?.detail]);
    },
    entries: () => [],
  };
  const control = await startLocalControl({
    surface,
    dataRoot,
    hostVersion: "1.2.3-test",
    pid: 777,
    processStartMs: 1_700_000_000_000,
    incarnation: 4,
    now: () => 1_700_000_001_000,
    breadcrumbs,
  });
  controls.push(control);
  return { dataRoot, surface, control, crumbs };
}

async function dial(control: LocalControl, credential: string, role: ClientRole): Promise<InstanceClient> {
  const client = await connectInstanceClient(control.record.endpoint, credential, {
    hello: { clientRole: role, clientKind: role, clientVersion: "t", clientProtocol: HOST_PROTOCOL },
    timeoutMs: 5000,
  });
  clients.push(client);
  return client;
}

async function dialFailure(control: LocalControl, credential: string) {
  try {
    clients.push(
      await connectInstanceClient(control.record.endpoint, credential, {
        hello: { clientRole: "browser", clientKind: "browser", clientVersion: "t", clientProtocol: HOST_PROTOCOL },
        timeoutMs: 5000,
      }),
    );
  } catch (err) {
    expect(err).toBeInstanceOf(InstanceConnectError);
    return (err as InstanceConnectError).failure;
  }
  throw new Error("connected with a credential that should have been refused");
}

describe("startLocalControl", () => {
  it("publishes a 0600 record naming the bound loopback endpoint and both credentials", async () => {
    const { dataRoot, control } = await start();
    const onDisk = readHostRecord(dataRoot);
    expect(onDisk).toEqual(control.record);
    expect(control.record).toMatchObject({
      schemaVersion: 1,
      dataRoot,
      hostVersion: "1.2.3-test",
      hostProtocol: HOST_PROTOCOL,
      pid: 777,
      processStartMs: 1_700_000_000_000,
      startedAtMs: 1_700_000_001_000,
      incarnation: 4,
    });
    expect(control.record.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(control.record.desktopCredential).toMatch(/^omp1\.desk\./);
    expect(control.record.controlCredential).toMatch(/^omp1\.ctl\./);
    if (process.platform !== "win32") {
      expect(fs.statSync(hostRecordPath(dataRoot)).mode & 0o777).toBe(0o600);
    }
  });

  it("grants the desktop credential a local desktop context without control", async () => {
    const { control, surface } = await start();
    const client = await dial(control, control.record.desktopCredential, "desktop");
    expect(client.hello?.verdict).toBe("compatible");
    expect(surface.built).toHaveLength(1);
    expect(surface.built[0]).toMatchObject({ role: "desktop", local: true, control: false });
    expect(control.connections().map((c) => c.role)).toEqual(["desktop"]);
    await expect(client.request(CH.getHostStatus, [])).rejects.toThrow("unknown channel");
  });

  it("grants the control credential a browser context whose table carries the control plane", async () => {
    const { control, surface } = await start();
    const client = await dial(control, control.record.controlCredential, "browser");
    expect(surface.built[0]).toMatchObject({ role: "browser", local: true, control: true });
    await expect(client.request(CH.getHostStatus, [])).resolves.toEqual({ control: true });
  });

  it("refuses a remote-looking token and an absent credential with 401", async () => {
    const { control, surface } = await start();
    expect(await dialFailure(control, mintRemoteToken())).toEqual({ kind: "unauthorized" });
    expect(await dialFailure(control, "")).toEqual({ kind: "unauthorized" });
    expect(surface.built).toEqual([]);
  });

  it("closes an implicit protocol-1 client with 4002 before any table is built", async () => {
    const { control, surface } = await start();
    const ws = new WebSocket(`${control.record.endpoint.replace("http://", "ws://")}${REMOTE_WS_PATH}`, {
      headers: { authorization: `Bearer ${control.record.desktopCredential}` },
    });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString("utf8") }));
    });
    ws.send(JSON.stringify({ t: "req", id: 1, ch: CH.getState, args: [] }));
    expect(await closed).toEqual({ code: HOST_CLOSE_INCOMPATIBLE, reason: "hello required" });
    expect(surface.built).toEqual([]);
  });

  it("rotates both credentials: clients drop with 4001, the old pair is refused, the record is rewritten", async () => {
    const { dataRoot, control } = await start();
    const before = { ...control.record };
    const desktop = await dial(control, before.desktopCredential, "desktop");
    const ctl = await dial(control, before.controlCredential, "browser");
    const closes: Array<[number, string]> = [];
    desktop.onClose((code, reason) => closes.push([code, reason]));
    ctl.onClose((code, reason) => closes.push([code, reason]));

    await control.rotateLocalCredentials();

    await vi.waitFor(() => expect(closes).toHaveLength(2));
    expect(closes).toEqual([
      [REMOTE_CLOSE_REVOKED, "credential rotated"],
      [REMOTE_CLOSE_REVOKED, "credential rotated"],
    ]);
    const after = control.record;
    expect(after.desktopCredential).not.toBe(before.desktopCredential);
    expect(after.controlCredential).not.toBe(before.controlCredential);
    expect(after).toEqual({ ...before, desktopCredential: after.desktopCredential, controlCredential: after.controlCredential });
    expect(readHostRecord(dataRoot)).toEqual(after);

    expect(await dialFailure(control, before.desktopCredential)).toEqual({ kind: "unauthorized" });
    expect(await dialFailure(control, before.controlCredential)).toEqual({ kind: "unauthorized" });
    const fresh = await dial(control, after.controlCredential, "browser");
    await expect(fresh.request(CH.getHostStatus, [])).resolves.toEqual({ control: true });
    await vi.waitFor(() => expect(control.connections()).toHaveLength(1));
  });

  it("records an emit-miss breadcrumb for a connection-scoped event nobody holds", async () => {
    const { control, surface, crumbs } = await start();
    await dial(control, control.record.desktopCredential, "desktop");
    surface.emit({ kind: "connection", id: "gone" }, CH.onPtyExit, ["tab", 0]);
    expect(crumbs).toEqual([["emit-miss", `connection:gone ${CH.onPtyExit}`]]);
  });

  it("close() stops listening and deletes the record", async () => {
    const { dataRoot, control } = await start();
    controls.splice(controls.indexOf(control), 1);
    const endpoint = control.record.endpoint;
    await control.close();
    expect(fs.existsSync(hostRecordPath(dataRoot))).toBe(false);
    await expect(
      connectInstanceClient(endpoint, "x", {
        hello: { clientRole: "browser", clientKind: "browser", clientVersion: "t", clientProtocol: HOST_PROTOCOL },
        timeoutMs: 2000,
      }),
    ).rejects.toMatchObject({ failure: { kind: "unreachable" } });
  });
});
