import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CH } from "@omp-ui/core";
import { DESKTOP_PANE_PORT, DESKTOP_PANE_PORT_REQUEST, type DesktopMediaMessage } from "../browser-pane-desktop-protocol";
import { MainBackend } from "./backend";
import { RemoteInstanceManager } from "./remote-instance-manager";

const geometry = { width: 2271, height: 2006, dsf: 1.5, surfaceWidth: 2272, surfaceHeight: 2006 };
const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
  media: vi.fn<(tabId: string, message: Exclude<DesktopMediaMessage, { type: "media-lease" }>) => void>(),
  subscribe: vi.fn(),
  viewer: vi.fn(),
  lease: vi.fn(),
}));

class Port extends EventEmitter {
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();
  reply(data: unknown): void { this.emit("message", { data }); }
}
const pairs: Array<{ port1: Port; port2: Port }> = [];

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_stub",
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => state.handlers.set(channel, handler),
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => state.handlers.set(channel, handler),
  },
  MessageChannelMain: class {
    port1 = new Port();
    port2 = new Port();
    constructor() { pairs.push(this); }
  },
}));

vi.mock("./session-manager", () => ({
  SessionManager: class {
    constructor(opts: { send: typeof state.send; browserPane: { onDesktopMedia: typeof state.media } }) {
      state.send.mockImplementation(opts.send);
      state.media.mockImplementation(opts.browserPane.onDesktopMedia);
    }
    browserPaneSubscribe(tabId: string, clientId: string, on: boolean): void {
      state.subscribe(tabId, clientId, on);
      if (on) state.send(CH.onBrowserPaneFrame, tabId, new Uint8Array([1]));
    }
    browserPaneSetDesktopViewer(tabId: string, clientId: string, on: boolean): void {
      state.viewer(tabId, clientId, on);
      if (on) state.media(tabId, { type: "media-geometry", tabId, generation: 1, geometry });
    }
    browserPaneMediaLease(tabId: string, requester: number): unknown { return state.lease(tabId, requester); }
    setViewedTab(): void {}
    noteDesktopClientId(): void {}
    killAll(): void {}
    setRemoteAccessPort(): void {}
  },
}));

let base = "";
let backend: MainBackend;
let wc: EventEmitter & {
  id: number;
  mainFrame: { postMessage: Mock };
  isDestroyed: () => boolean;
  isCrashed: () => boolean;
  send: Mock;
};
const invoke = (channel: string, ...args: unknown[]): unknown => state.handlers.get(channel)!(null, ...args);
const requestPort = (event = { sender: wc, senderFrame: wc.mainFrame }): void => {
  state.handlers.get(DESKTOP_PANE_PORT_REQUEST)!(event);
};

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-desktop-frame-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(base, "agent"));
  vi.stubEnv("XDG_DATA_HOME", path.join(base, "data"));
  state.handlers.clear();
  vi.clearAllMocks();
  state.lease.mockReturnValue({ sourceId: "requester-bound", generation: 1, geometry });
  vi.spyOn(RemoteInstanceManager.prototype, "ownerOf").mockImplementation((tabId) => tabId === "remote" ? "instance" : null);
  vi.spyOn(RemoteInstanceManager.prototype, "notify").mockImplementation((_instance, channel, args) => {
    if (channel !== CH.browserPaneSubscribe) return;
    state.subscribe(...args);
    if (args[2]) state.send(CH.onBrowserPaneFrame, args[0], new Uint8Array([1]));
  });
  pairs.length = 0;
  wc = Object.assign(new EventEmitter(), {
    id: 42,
    mainFrame: { postMessage: vi.fn() },
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  });
  backend = new MainBackend({ isDestroyed: () => false, webContents: wc } as never, path.join(base, "registry.json"));
  backend.registerIpc();
});

afterEach(async () => {
  await backend.killAll();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("desktop pane port integration", () => {
  it("accepts only the app main frame and preserves the remote-instance JPEG route", () => {
    requestPort({ sender: Object.assign(new EventEmitter(), wc), senderFrame: wc.mainFrame });
    requestPort({ sender: wc, senderFrame: { postMessage: vi.fn() } });
    expect(pairs).toEqual([]);
    requestPort();
    expect(wc.mainFrame.postMessage).toHaveBeenCalledWith(DESKTOP_PANE_PORT, null, [pairs[0]!.port2]);
    invoke(CH.browserPaneSubscribe, "remote", "desktop", true);
    expect(pairs[0]!.port1.postMessage).not.toHaveBeenCalled();
    pairs[0]!.port1.reply({ type: "ready" });
    expect(pairs[0]!.port1.postMessage).toHaveBeenCalledWith({ type: "frame", id: 1, tabId: "remote", frame: new Uint8Array([1]) });
    expect(state.viewer).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalledWith(CH.onBrowserPaneFrame, expect.anything(), expect.anything());
  });

  it("keeps local desktop viewers out of JPEG subscriptions and authorizes leases per viewed tab", () => {
    requestPort();
    const port = pairs[0]!.port1;
    port.reply({ type: "ready" });
    invoke(CH.browserPaneSubscribe, "local", "desktop", true);
    state.send(CH.onBrowserPaneFrame, "local", new Uint8Array([1]));
    expect(state.subscribe).not.toHaveBeenCalled();
    expect(port.postMessage.mock.calls.some(([message]) => message.type === "frame")).toBe(false);
    port.reply({ type: "media-lease-request", requestId: 1, tabId: "local" });
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "media-lease", requestId: 1, tabId: "local", lease: { sourceId: "requester-bound", generation: 1, geometry } });
    expect(state.lease).toHaveBeenCalledExactlyOnceWith("local", 42);
    for (const tabId of ["unknown", "remote"]) {
      port.reply({ type: "media-lease-request", requestId: 2, tabId });
      expect(port.postMessage).toHaveBeenLastCalledWith({ type: "media-lease", requestId: 2, tabId, lease: null });
    }
    const count = port.postMessage.mock.calls.length;
    for (const request of [
      { requestId: "1", tabId: "local" }, { requestId: NaN, tabId: "local" },
      { requestId: Infinity, tabId: "local" }, { requestId: 1, tabId: 12 },
    ]) port.reply({ type: "media-lease-request", ...request });
    expect(port.postMessage).toHaveBeenCalledTimes(count);
    invoke(CH.tabViewed, "desktop", null);
    port.reply({ type: "media-lease-request", requestId: 3, tabId: "local" });
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "media-lease", requestId: 3, tabId: "local", lease: null });
  });

  it("forwards lifecycle only for desktop viewers and reannounces geometry on port replacement", () => {
    invoke(CH.browserPaneSubscribe, "local", "desktop", true);
    requestPort();
    const old = pairs[0]!.port1;
    old.reply({ type: "ready" });
    expect(old.postMessage).toHaveBeenCalledWith({ type: "media-geometry", tabId: "local", generation: 1, geometry });
    requestPort();
    const current = pairs[1]!.port1;
    old.reply({ type: "media-lease-request", requestId: 1, tabId: "local" });
    expect(current.postMessage).not.toHaveBeenCalled();
    current.reply({ type: "ready" });
    expect(current.postMessage).toHaveBeenCalledWith({ type: "media-geometry", tabId: "local", generation: 1, geometry });
    state.media("local", { type: "media-ended", tabId: "local", generation: 2 });
    expect(current.postMessage).toHaveBeenLastCalledWith({ type: "media-ended", tabId: "local", generation: 2 });
    const count = current.postMessage.mock.calls.length;
    state.media("other", { type: "media-ended", tabId: "other", generation: 2 });
    backend.handlers().notify[CH.browserPaneSubscribe]("other", "remote-client", true);
    expect(current.postMessage).toHaveBeenCalledTimes(count);
  });

  it("replaces remote JPEG ports without dropping desired tabs and fences old ACKs", () => {
    invoke(CH.browserPaneSubscribe, "remote", "desktop", true);
    requestPort();
    const old = pairs[0]!.port1;
    old.reply({ type: "ready" });
    state.send(CH.onBrowserPaneFrame, "remote", new Uint8Array([2]));
    requestPort();
    const current = pairs[1]!.port1;
    expect(old.close).toHaveBeenCalledOnce();
    old.reply({ type: "ready" });
    expect(current.postMessage).not.toHaveBeenCalled();
    current.reply({ type: "ready" });
    state.send(CH.onBrowserPaneFrame, "remote", new Uint8Array([3]));
    old.reply({ type: "ack", id: 2 });
    current.reply({ type: "ack", id: "2" });
    current.reply({ type: "ack", id: 1 });
    expect(current.postMessage.mock.calls).toEqual([[{ type: "frame", id: 2, tabId: "remote", frame: new Uint8Array([2]) }]]);
    current.reply({ type: "ack", id: 2 });
    expect(current.postMessage).toHaveBeenLastCalledWith({ type: "frame", id: 3, tabId: "remote", frame: new Uint8Array([3]) });
  });

  it.each(["navigation", "crash", "destruction", "killAll"])("releases both subscription paths on %s", async (cause) => {
    invoke(CH.browserPaneSubscribe, "local", "desktop", true);
    invoke(CH.browserPaneSubscribe, "remote", "desktop", true);
    requestPort();
    const old = pairs[0]!.port1;
    old.reply({ type: "ready" });
    if (cause === "navigation") {
      wc.emit("did-start-navigation", { isSameDocument: true, isMainFrame: true });
      wc.emit("did-start-navigation", { isSameDocument: false, isMainFrame: false });
      expect(state.subscribe).not.toHaveBeenCalledWith("remote", "desktop", false);
      expect(state.viewer).not.toHaveBeenCalledWith("local", "desktop", false);
      wc.emit("did-start-navigation", { isSameDocument: false, isMainFrame: true });
    } else if (cause === "crash") wc.emit("render-process-gone", {}, {});
    else if (cause === "destruction") wc.emit("destroyed");
    else await backend.killAll();
    expect(state.subscribe).toHaveBeenCalledWith("remote", "desktop", false);
    expect(state.viewer).toHaveBeenCalledWith("local", "desktop", false);
    expect(old.close).toHaveBeenCalledOnce();
    const count = old.postMessage.mock.calls.length;
    old.reply({ type: "ready" });
    state.send(CH.onBrowserPaneFrame, "remote", new Uint8Array([2]));
    state.media("local", { type: "media-ended", tabId: "local", generation: 2 });
    expect(old.postMessage).toHaveBeenCalledTimes(count);
  });
});
