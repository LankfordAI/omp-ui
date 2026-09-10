import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, type ChannelTable } from "@omp-ui/core";
import type { ScopedSink } from "@omp-ui/server";
import { IPC_CONNECTION_ID, type HostApplication } from "@omp-ui/host";
import { bindBackendIpc, bindWindowSink } from "./ipc-bridge";

type IpcListener = (event: unknown, ...args: unknown[]) => unknown;

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, IpcListener>(),
  listeners: new Map<string, IpcListener[]>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcListener) => ipc.handlers.set(channel, fn),
    on: (channel: string, fn: IpcListener) =>
      ipc.listeners.set(channel, [...(ipc.listeners.get(channel) ?? []), fn]),
    removeHandler: (channel: string) => ipc.handlers.delete(channel),
    removeListener: (channel: string, fn: IpcListener) =>
      ipc.listeners.set(channel, (ipc.listeners.get(channel) ?? []).filter((l) => l !== fn)),
  },
}));

const sent: Array<{ channel: string; args: unknown[] }> = [];
const win = {
  destroyed: false,
  isDestroyed: () => win.destroyed,
  webContents: {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, args });
    },
  },
};

/** A host reduced to what the bridge touches: one sink set and one table per connection. */
function fakeHost(table: ChannelTable) {
  const sinks = new Set<ScopedSink>();
  const closed: string[] = [];
  const host = {
    handlers: vi.fn(() => table),
    connectionClosed: (id: string) => {
      closed.push(id);
    },
    addSink: (sink: ScopedSink) => {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
  };
  const emit: ScopedSink = (scope, channel, args) => {
    for (const sink of sinks) sink(scope, channel, args);
  };
  return { host: host as unknown as HostApplication, sinks, closed, emit };
}

const ctx = {
  id: IPC_CONNECTION_ID,
  role: "desktop" as const,
  local: true,
  control: false,
  clientKind: "desktop" as const,
  clientVersion: "0.0.0",
  protocolVersion: 2,
};

beforeEach(() => {
  ipc.handlers.clear();
  ipc.listeners.clear();
  sent.length = 0;
  win.destroyed = false;
  win.webContents.isCrashed = () => false;
  win.webContents.send = (channel, ...args) => {
    sent.push({ channel, args });
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bindBackendIpc", () => {
  const table = {
    request: { [CH.setThemeId]: vi.fn(async () => undefined) },
    notify: { [CH.tabViewed]: vi.fn() },
  } as unknown as ChannelTable;

  it("binds the connection's table to ipcMain through the codec-checked dispatchers", async () => {
    const { host } = fakeHost(table);
    bindBackendIpc(host, ctx);
    expect(host.handlers).toHaveBeenCalledWith(ctx);

    await ipc.handlers.get(CH.setThemeId)!(null, "nord");
    expect(table.request[CH.setThemeId]).toHaveBeenCalledWith("nord");
    // A malformed tuple is rejected at the boundary, never reaching the handler.
    await expect(ipc.handlers.get(CH.setThemeId)!(null, 42)).rejects.toThrow(
      `invalid arguments for ${CH.setThemeId}`,
    );
    expect(table.request[CH.setThemeId]).toHaveBeenCalledTimes(1);

    for (const listener of ipc.listeners.get(CH.tabViewed)!) listener(null, "tab-1");
    expect(table.notify[CH.tabViewed]).toHaveBeenCalledWith("tab-1");
  });

  it("unbind removes every handler and listener and closes the connection on the host", () => {
    const { host, closed } = fakeHost(table);
    const unbind = bindBackendIpc(host, ctx);
    expect(ipc.handlers.size).toBe(1);
    unbind();
    expect(ipc.handlers.size).toBe(0);
    expect([...ipc.listeners.values()].flat()).toHaveLength(0);
    expect(closed).toEqual([IPC_CONNECTION_ID]);
  });
});

describe("bindWindowSink", () => {
  const state = { themeId: "nord" };

  it("mirrors broadcasts, desktop-role events, and the window's own connection — nothing else", () => {
    const { host, emit } = fakeHost({ request: {}, notify: {} } as ChannelTable);
    bindWindowSink(host, win as never);
    emit({ kind: "broadcast" }, CH.onAttentionChanged, ["tab-1", null]);
    emit({ kind: "role", role: "desktop" }, CH.onStateChanged, [state]);
    emit({ kind: "connection", id: IPC_CONNECTION_ID }, CH.onStateChanged, [state]);
    emit({ kind: "role", role: "browser" }, CH.onStateChanged, [state]);
    emit({ kind: "connection", id: "conn-phone" }, CH.onStateChanged, [state]);
    expect(sent).toEqual([
      { channel: CH.onAttentionChanged, args: ["tab-1", null] },
      { channel: CH.onStateChanged, args: [state] },
      { channel: CH.onStateChanged, args: [state] },
    ]);
  });

  it("skips the window while the renderer is crashed or the window is gone (issue #183)", () => {
    const { host, emit } = fakeHost({ request: {}, notify: {} } as ChannelTable);
    bindWindowSink(host, win as never);
    win.webContents.isCrashed = () => true;
    emit({ kind: "broadcast" }, CH.onStateChanged, [state]);
    win.webContents.isCrashed = () => false;
    win.destroyed = true;
    emit({ kind: "broadcast" }, CH.onStateChanged, [state]);
    expect(sent).toEqual([]);
  });

  it("tolerates a disposed-frame throw and rate-limits the warn", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, emit } = fakeHost({ request: {}, notify: {} } as ChannelTable);
    bindWindowSink(host, win as never);
    win.webContents.send = () => {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    };
    emit({ kind: "broadcast" }, CH.onStateChanged, [state]);
    emit({ kind: "broadcast" }, CH.onStateChanged, [state]);
    expect(warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    emit({ kind: "broadcast" }, CH.onStateChanged, [state]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("other sinks still receive their events when the window send throws", () => {
    const { host, emit, sinks } = fakeHost({ request: {}, notify: {} } as ChannelTable);
    bindWindowSink(host, win as never);
    win.webContents.send = () => {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    };
    const remote: string[] = [];
    sinks.add((scope, channel) => {
      if (scope.kind === "connection" && scope.id === "conn-phone") remote.push(channel);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    emit({ kind: "broadcast" }, CH.onStateChanged, [state]);
    emit({ kind: "connection", id: "conn-phone" }, CH.onStateChanged, [state]);
    expect(remote).toEqual([CH.onStateChanged]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops the mirror", () => {
    const { host, emit, sinks } = fakeHost({ request: {}, notify: {} } as ChannelTable);
    const off = bindWindowSink(host, win as never);
    off();
    emit({ kind: "broadcast" }, CH.onStateChanged, [state]);
    expect(sinks.size).toBe(0);
    expect(sent).toEqual([]);
  });
});
