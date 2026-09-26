import { EventEmitter } from "node:events";
import {
  BROWSER_PANE_ACTING_MS,
  BROWSER_PANE_DEFAULT_VIEWPORT,
  BROWSER_PANE_MAX_VIEWPORT,
  BROWSER_PANE_MIN_VIEWPORT,
  BROWSER_PANE_RESIZE_DEBOUNCE_MS,
  CH,
  decodeBrowserPaneFrame,
  type BrowserPaneState,
} from "@omp-ui/core";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { BridgeListener, BridgeListenerDeps, CreateBridgeListener } from "./browser-pane-bridge";
import type { CreatePane, CreatePaneOptions, PaneContents, PaneEvent } from "./browser-pane-contents";
import { BrowserPaneHost, type BrowserPaneHostDeps } from "./browser-pane-host";
import { jpegDimensions } from "./browser-pane-capture";

interface FakePane {
  pane: PaneContents;
  opts: CreatePaneOptions;
  /** Delivers a JPEG with the given SOF dimensions on the capture session. */
  frame(width: number, height: number, payload?: Buffer, sessionId?: string): Buffer;
  emit(event: PaneEvent, ...args: unknown[]): void;
  setUrl(url: string): void;
}

function fakePane(opts: CreatePaneOptions, autoCommit = true): FakePane {
  const handlers = new Map<PaneEvent, Set<(...args: unknown[]) => void>>();
  const debuggerEvents = new EventEmitter();
  let captureSession = 0;
  let url = "";
  let destroyed = false;
  const pane: PaneContents = {
    setContentSize: vi.fn(),
    setZoomFactor: vi.fn(),
    getContentSize: () => ({ width: opts.width, height: opts.height }),
    mediaSourceId: (requester) => `source-${requester}`,
    loadURL: vi.fn(async (next: string) => {
      url = next;
      // Real Electron commits every load with did-stop-loading; the host gates
      // the metrics override on that first commit (#557).
      if (autoCommit) for (const cb of handlers.get("did-stop-loading") ?? []) cb();
    }),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => true,
    getURL: () => url,
    getTitle: () => "Fake",
    isLoading: () => false,
    sendInputEvent: vi.fn(),
    insertText: vi.fn(async () => {}),
    imeSetComposition: vi.fn(async () => {}),
    focus: vi.fn(),
    selectAll: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    cut: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: () => true,
      sendCommand: vi.fn(async (method: string) => {
        if (method === "Target.getTargetInfo") return { targetInfo: { type: "page", targetId: "page" } };
        if (method === "Target.attachToTarget") return { sessionId: `capture-${++captureSession}` };
        return {};
      }),
      on: (event, callback) => { debuggerEvents.on(event, callback); },
      off: (event, callback) => { debuggerEvents.off(event, callback); },
    },
    userAgent: "fake-ua",
    on: (event, cb) => {
      let set = handlers.get(event);
      if (set === undefined) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
      };
    },
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    isDestroyed: () => destroyed,
  };
  return {
    pane,
    opts,
    frame: (width, height, payload = Buffer.alloc(0), sessionId = `capture-${captureSession}`) => {
      const header = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
      header.writeUInt16BE(height, 7);
      header.writeUInt16BE(width, 9);
      const jpeg = Buffer.concat([header, payload, Buffer.from([0xff, 0xd9])]);
      debuggerEvents.emit("message", {}, "Page.screencastFrame", { data: jpeg.toString("base64"), sessionId: 1 }, sessionId);
      return jpeg;
    },
    emit: (event, ...args) => {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
    setUrl: (next) => {
      url = next;
    },
  };
}

interface Harness {
  host: BrowserPaneHost;
  sent: Array<{ channel: string; args: unknown[] }>;
  panes: FakePane[];
  listeners: Array<{ deps: BridgeListenerDeps; listener: BridgeListener }>;
  warnings: string[];
  createPane: ReturnType<typeof vi.fn<CreatePane>>;
  clearPartition: Mock<(partition: string) => Promise<void>>;
  /** Only the state emits, in order. */
  states(): BrowserPaneState[];
  frames(): Uint8Array[];
}

type ClockDeps = Pick<BrowserPaneHostDeps, "targetScaleFactor" | "clockEnabled" | "clockText" | "stampImage" | "onDesktopMedia">;

function harness(
  opts: { paneFails?: boolean; listenerFails?: boolean; autoCommit?: boolean; now?: () => number; clock?: ClockDeps } = {},
): Harness {
  const sent: Harness["sent"] = [];
  const panes: FakePane[] = [];
  const listeners: Harness["listeners"] = [];
  const warnings: string[] = [];
  let nextPort = 41000;
  const clearPartition = vi.fn<(partition: string) => Promise<void>>(async () => {});
  const createPane = vi.fn<CreatePane>(async (paneOpts) => {
    if (opts.paneFails === true) throw new Error("no gpu");
    const fake = fakePane(paneOpts, opts.autoCommit);
    panes.push(fake);
    return fake.pane;
  });
  const createListener: CreateBridgeListener = async (deps) => {
    if (opts.listenerFails === true) throw new Error("EADDRINUSE");
    const port = nextPort;
    nextPort += 1;
    const listener: BridgeListener = {
      port,
      url: `http://127.0.0.1:${port}/${deps.token}`,
      close: vi.fn(),
      clientCount: () => 0,
    };
    listeners.push({ deps, listener });
    return listener;
  };
  const host = new BrowserPaneHost({
    send: (channel, ...args) => sent.push({ channel, args }),
    createPane,
    createListener,
    now: opts.now,
    clearPartition,
    warn: (message) => warnings.push(message),
    ...opts.clock,
  });
  return {
    host,
    sent,
    panes,
    listeners,
    warnings,
    createPane,
    clearPartition,
    states: () =>
      sent.filter((s) => s.channel === CH.onBrowserPaneState).map((s) => s.args[1] as BrowserPaneState),
    frames: () =>
      sent.filter((s) => s.channel === CH.onBrowserPaneFrame).map((s) => s.args[1] as Uint8Array),
  };
}

/** Microtask drain: factory settle → shared in-flight promise → sink callbacks. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserPaneHost sink registry (U2)", () => {
  it("captures only while subscribed, keeps the page alive and replays the cache", async () => {
    const h = harness();
    await h.host.ensure("t1");
    const fake = h.panes[0]!;
    fake.frame(1280, 800);
    expect(h.frames()).toEqual([]);
    h.host.subscribe("t1", "c1", true);
    await flush();
    const jpeg = fake.frame(1280, 800);
    expect(decodeBrowserPaneFrame(h.frames()[0]!)?.header).toEqual({ width: 1280, height: 800, dsf: 1 });
    expect(Buffer.from(decodeBrowserPaneFrame(h.frames()[0]!)!.jpeg)).toEqual(jpeg);
    h.host.subscribe("t1", "c2", true);
    await flush();
    expect(h.frames()[1]).toBe(h.frames()[0]);
    h.host.subscribe("t1", "c1", false);
    h.host.subscribe("t1", "c2", false);
    fake.frame(900, 600);
    await flush();
    expect(h.frames()).toHaveLength(2);
    expect(h.host.diagnostics()[0]).toMatchObject({ pageAlive: true, subscribers: 0, fps: 0 });
    expect(await h.host.ensure("t1")).toMatchObject({ status: "available", frame: { width: 1280, height: 800, dsf: 1 } });
    h.host.disposeAll();
  });

  it("noteViewed stops only the pages the client left", async () => {
    const h = harness();
    await Promise.all([h.host.ensureEndpoint("t1"), h.host.ensureEndpoint("t2")]);
    h.host.subscribe("t1", "c1", true);
    h.host.subscribe("t2", "c1", true);
    await flush();
    h.host.noteViewed("c1", "t2");
    h.panes[0]!.frame(1280, 800);
    h.panes[1]!.frame(900, 600);
    expect(h.frames().map((frame) => decodeBrowserPaneFrame(frame)?.header.width)).toEqual([900]);
    h.host.noteViewed("c1", null);
    h.panes[1]!.frame(800, 600);
    await flush();
    expect(h.frames()).toHaveLength(1);
    expect(h.host.livePageCount()).toBe(2);
    h.host.disposeAll();
  });

  it("clamps the target scale into the window size, the override, and the frame header", async () => {
    const sent: Harness["sent"] = [];
    const panes: FakePane[] = [];
    const host = new BrowserPaneHost({
      send: (channel, ...args) => sent.push({ channel, args }),
      createPane: async (opts) => {
        const fake = fakePane(opts);
        panes.push(fake);
        return fake.pane;
      },
      targetScaleFactor: () => 3,
    });
    await host.ensureEndpoint("t1");
    host.subscribe("t1", "c1", true);
    await flush();
    const pane = panes[0]!.pane;
    // Window at css*2 (the BROWSER_PANE_MAX_DSF clamp), the page zoomed 2x inside it.
    expect(panes[0]!.opts).toMatchObject({ width: 2560, height: 1600, zoomFactor: 2 });
    expect(pane.setContentSize).toHaveBeenCalledWith(2560, 1600);
    expect(pane.debugger.sendCommand).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", {
      width: 2560,
      height: 1600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    panes[0]!.frame(2560, 1600);
    const frame = sent.find((s) => s.channel === CH.onBrowserPaneFrame)?.args[1] as Uint8Array;
    expect(decodeBrowserPaneFrame(frame)?.header).toEqual({ width: 2560, height: 1600, dsf: 2 });
    expect(host.diagnostics()[0]).toMatchObject({ targetDsf: 2 });
  });

  it("drops a JPEG with empty dimensions", async () => {
    const sent: Harness["sent"] = [];
    const panes: FakePane[] = [];
    const host = new BrowserPaneHost({
      send: (channel, ...args) => sent.push({ channel, args }),
      createPane: async (opts) => {
        const fake = fakePane(opts);
        panes.push(fake);
        return fake.pane;
      },
      targetScaleFactor: () => 2,
    });
    await host.ensureEndpoint("t1");
    host.subscribe("t1", "c1", true);
    await flush();
    panes[0]!.frame(0, 0);
    expect(sent.filter((s) => s.channel === CH.onBrowserPaneFrame)).toHaveLength(0);
    expect(await host.ensure("t1")).toMatchObject({ status: "available", frame: null });
  });

  it("sizes the window, zoom, override and header for a fractional density, and maps pane input to window DIPs", async () => {
    const sent: Harness["sent"] = [];
    const panes: FakePane[] = [];
    const host = new BrowserPaneHost({
      send: (channel, ...args) => sent.push({ channel, args }),
      createPane: async (opts) => {
        const fake = fakePane(opts);
        panes.push(fake);
        return fake.pane;
      },
      targetScaleFactor: () => 1.5,
    });
    await host.ensureEndpoint("t1");
    host.subscribe("t1", "c1", true);
    await flush();
    const pane = panes[0]!.pane;
    expect(panes[0]!.opts).toMatchObject({ width: 1920, height: 1200, zoomFactor: 1.5 });
    expect(pane.setContentSize).toHaveBeenCalledWith(1920, 1200);
    expect(pane.debugger.sendCommand).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", {
      width: 1920,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    panes[0]!.frame(1920, 1200);
    const frame = sent.find((s) => s.channel === CH.onBrowserPaneFrame)?.args[1] as Uint8Array;
    expect(decodeBrowserPaneFrame(frame)?.header).toEqual({ width: 1920, height: 1200, dsf: 1.5 });
    expect(host.diagnostics()[0]).toMatchObject({ targetDsf: 1.5 });
    host.input("t1", { type: "mouseDown", x: 100, y: 50, button: "left", clickCount: 1 });
    expect(pane.sendInputEvent).toHaveBeenLastCalledWith({ type: "mouseDown", x: 150, y: 75, button: "left", clickCount: 1 });
    host.input("t1", { type: "mouseWheel", x: 10, y: 20, deltaX: 0, deltaY: -100, hasPreciseScrollingDeltas: false });
    expect(pane.sendInputEvent).toHaveBeenLastCalledWith({
      type: "mouseWheel", x: 15, y: 30, deltaX: 0, deltaY: -150, hasPreciseScrollingDeltas: false,
    });
  });

  it("re-asserts its own metrics 250 ms after an agent viewport override settles", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.host.ensureEndpoint("t1");
    await h.host.ensure("t1");
    const pane = h.panes[0]!.pane;
    const setContentSize = vi.mocked(pane.setContentSize);
    const sendCommand = vi.mocked(pane.debugger.sendCommand);
    const sizes = setContentSize.mock.calls.length;
    const overrides = sendCommand.mock.calls.length;
    const deps = h.listeners[0]!.deps;
    // The send-time hook derives agent state only; it no longer re-pins.
    deps.onCommand("Emulation.clearDeviceMetricsOverride");
    vi.advanceTimersByTime(250);
    expect(setContentSize).toHaveBeenCalledTimes(sizes);
    expect(sendCommand).toHaveBeenCalledTimes(overrides);

    deps.onCommandSettled("Emulation.clearDeviceMetricsOverride", {});
    vi.advanceTimersByTime(249);
    expect(setContentSize).toHaveBeenCalledTimes(sizes);
    vi.advanceTimersByTime(1);
    expect(setContentSize).toHaveBeenCalledTimes(sizes + 1);
    expect(setContentSize).toHaveBeenLastCalledWith(1280, 800);
    // Clear, then set: the clear is what makes Chromium accept the otherwise-identical override again.
    expect(sendCommand).toHaveBeenCalledTimes(overrides + 2);
    expect(sendCommand).toHaveBeenNthCalledWith(overrides + 1, "Emulation.clearDeviceMetricsOverride");
    expect(sendCommand).toHaveBeenLastCalledWith("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const clearOrder = sendCommand.mock.invocationCallOrder[overrides]!;
    const setOrder = sendCommand.mock.invocationCallOrder[overrides + 1]!;
    expect(clearOrder).toBeLessThan(setOrder);
    // The bridge override command itself never marks the agent as acting.
    expect(h.states().every((s) => s.agent !== "acting")).toBe(true);
  });

  it("re-pins after an agent screenshot that touches emulation, not after a plain one", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.host.ensureEndpoint("t1");
    await h.host.ensure("t1");
    const pane = h.panes[0]!.pane;
    const setContentSize = vi.mocked(pane.setContentSize);
    const sendCommand = vi.mocked(pane.debugger.sendCommand);
    const deps = h.listeners[0]!.deps;
    let sizes = setContentSize.mock.calls.length;
    let overrides = sendCommand.mock.calls.length;
    const expectRepin = () => {
      expect(setContentSize).toHaveBeenCalledTimes(sizes + 1);
      expect(sendCommand).toHaveBeenCalledTimes(overrides + 2);
      expect(sendCommand).toHaveBeenNthCalledWith(overrides + 1, "Emulation.clearDeviceMetricsOverride");
      expect(sendCommand).toHaveBeenLastCalledWith("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      sizes = setContentSize.mock.calls.length;
      overrides = sendCommand.mock.calls.length;
    };

    // A plain screenshot: puppeteer forces captureBeyondViewport=false and Chromium touches no emulation.
    deps.onCommandSettled("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    vi.advanceTimersByTime(250);
    expect(setContentSize).toHaveBeenCalledTimes(sizes);
    expect(sendCommand).toHaveBeenCalledTimes(overrides);

    // A clipped screenshot: Chromium restores the agent session's empty params, disabling the widget's emulation.
    deps.onCommandSettled("Page.captureScreenshot", {
      clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 },
      captureBeyondViewport: true,
    });
    vi.advanceTimersByTime(250);
    expectRepin();

    // puppeteer's fullPage: captureBeyondViewport without a clip.
    deps.onCommandSettled("Page.captureScreenshot", { captureBeyondViewport: true });
    vi.advanceTimersByTime(250);
    expectRepin();
  });

  it("re-pins when a CDP client detaches while others remain", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.host.ensureEndpoint("t1");
    await h.host.ensure("t1");
    const pane = h.panes[0]!.pane;
    const setContentSize = vi.mocked(pane.setContentSize);
    const sendCommand = vi.mocked(pane.debugger.sendCommand);
    const deps = h.listeners[0]!.deps;
    let sizes = setContentSize.mock.calls.length;
    let overrides = sendCommand.mock.calls.length;
    const expectRepin = () => {
      expect(setContentSize).toHaveBeenCalledTimes(sizes + 1);
      expect(setContentSize).toHaveBeenLastCalledWith(1280, 800);
      expect(sendCommand).toHaveBeenCalledTimes(overrides + 2);
      expect(sendCommand).toHaveBeenNthCalledWith(overrides + 1, "Emulation.clearDeviceMetricsOverride");
      expect(sendCommand).toHaveBeenLastCalledWith("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      sizes = setContentSize.mock.calls.length;
      overrides = sendCommand.mock.calls.length;
    };

    deps.onClientCount(2);
    vi.advanceTimersByTime(250);
    expect(setContentSize).toHaveBeenCalledTimes(sizes);
    expect(sendCommand).toHaveBeenCalledTimes(overrides);

    // One of two leaves: its session teardown may have disabled the widget's emulation.
    deps.onClientCount(1);
    vi.advanceTimersByTime(250);
    expectRepin();

    deps.onClientCount(0);
    vi.advanceTimersByTime(250);
    expectRepin();
    expect(h.states().at(-1)?.agent).toBe("detached");
  });

  it("subscribing to a tab whose page cannot be created is a no-op and ensure answers create-failed", async () => {
    const h = harness({ paneFails: true });
    h.host.subscribe("t1", "c1", true);
    await flush();
    expect(h.frames()).toEqual([]);
    await expect(h.host.ensure("t1")).resolves.toEqual({ status: "unavailable", reason: "create-failed" });
    expect(h.warnings.some((w) => w.includes("no gpu"))).toBe(true);
    expect(h.host.diagnostics()).toEqual([]);
  });

  it("waits for the first commit and clears old document frames before navigation", async () => {
    vi.useFakeTimers();
    const h = harness({ autoCommit: false });
    await h.host.ensure("t1");
    h.host.subscribe("t1", "c1", true);
    await flush();
    const fake = h.panes[0]!;
    fake.frame(100, 100);
    expect(h.frames()).toEqual([]);
    fake.emit("did-navigate");
    await flush();
    fake.frame(200, 100);
    expect(h.frames().map((frame) => decodeBrowserPaneFrame(frame)?.header.width)).toEqual([200]);
    fake.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    fake.frame(300, 100, undefined, "capture-1");
    expect(await h.host.ensure("t1")).toMatchObject({ frame: null });
    h.host.subscribe("t1", "c2", true);
    await flush();
    expect(h.frames()).toHaveLength(1);
    fake.emit("did-navigate");
    await flush();
    fake.frame(400, 100, undefined, "capture-1");
    fake.frame(500, 100);
    vi.advanceTimersByTime(34);
    expect(h.frames().map((frame) => decodeBrowserPaneFrame(frame)?.header.width)).toEqual([200, 500]);
    fake.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    fake.emit("did-navigate-in-page");
    fake.frame(600, 100);
    vi.advanceTimersByTime(34);
    expect(h.frames().map((frame) => decodeBrowserPaneFrame(frame)?.header.width)).toEqual([200, 500, 600]);
    h.host.disposeAll();
  });

  it("discards destroyed-page frames and cache when a page is recreated", async () => {
    const h = harness();
    await h.host.ensure("t1");
    h.host.subscribe("t1", "c1", true);
    await flush();
    const old = h.panes[0]!;
    old.frame(100, 100);
    old.emit("destroyed");
    old.frame(200, 100);
    expect(await h.host.ensure("t1")).toMatchObject({ frame: null });
    await flush();
    old.frame(300, 100);
    h.panes[1]!.frame(400, 100);
    expect(h.frames().map((frame) => decodeBrowserPaneFrame(frame)?.header.width)).toEqual([100, 400]);
    h.host.disposeAll();
  });

  it("bounds capture errors, recovers on commit and preserves unrelated load errors on success", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.host.ensure("t1");
    const fake = h.panes[0]!;
    const command = vi.mocked(fake.pane.debugger.sendCommand);
    const normal = command.getMockImplementation()!;
    command.mockImplementation(async (method, params, sessionId) => {
      if (method === "Page.startScreencast") throw new Error("x".repeat(800));
      return normal(method, params, sessionId);
    });
    h.host.subscribe("t1", "c1", true);
    await flush();
    expect(h.states().at(-1)?.error).toBe(`capture-failed: ${"x".repeat(500)}`);
    fake.frame(100, 100);
    expect(h.frames()).toEqual([]);
    command.mockImplementation(normal);
    fake.emit("did-navigate");
    await flush();
    fake.frame(200, 100);
    expect(h.states().at(-1)?.error).toBeNull();
    fake.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", "https://missing.invalid/", true);
    fake.frame(300, 100);
    vi.advanceTimersByTime(34);
    expect(h.host.diagnostics()[0]).toMatchObject({ lastError: "load-failed: NAME_NOT_RESOLVED" });
    expect(h.frames().map((frame) => decodeBrowserPaneFrame(frame)?.header.width)).toEqual([200, 300]);
    h.host.disposeAll();
  });
});

describe("BrowserPaneHost page lifecycle", () => {
  it("remembers the last committed URL across dispose and forgets it on delete", async () => {
    const h = harness();
    await h.host.ensure("t1");
    const first = h.panes[0]!;
    first.setUrl("https://example.com/docs");
    first.emit("did-navigate");
    expect(h.states().at(-1)).toMatchObject({ url: "https://example.com/docs", alive: true });

    h.host.dispose("t1");
    expect(first.pane.destroy).toHaveBeenCalledTimes(1);
    expect(h.states().at(-1)).toMatchObject({ url: "https://example.com/docs", alive: false });

    await h.host.ensure("t1");

    expect(h.panes[1]!.pane.loadURL).toHaveBeenCalledWith("https://example.com/docs");

    h.host.dispose("t1", { forgetUrl: true });
    await h.host.ensure("t1");
    expect(h.panes[2]!.pane.loadURL).toHaveBeenCalledWith("about:blank");
  });
  it("does not resurrect forgotten state from late pane notifications", async () => {
    const h = harness();
    await h.host.ensureEndpoint("t1");
    h.host.dispose("t1", { forgetUrl: true });

    h.host.subscribe("t1", "client", false);
    h.host.setOpen("t1", false);
    h.host.resize("t1", 900, 600);
    h.host.navigate("t1", { action: "goto", url: "https://example.com/" });
    await flush();

    expect(h.host.diagnostics()).toEqual([]);
    expect(h.createPane).not.toHaveBeenCalled();
  });

  it("emits alive:false and drops the page when the page dies underneath it", async () => {
    const h = harness();
    await h.host.ensure("t1");
    h.panes[0]!.emit("destroyed");
    expect(h.states().at(-1)).toMatchObject({ alive: false });
    await h.host.ensure("t1");
    expect(h.createPane).toHaveBeenCalledTimes(2);
  });

  it("debounces resize into one clamped setContentSize and clamps pointer input to the viewport", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.host.ensure("t1");
    const pane = h.panes[0]!.pane;
    // Creation itself sizes the window through applyMetrics; count from there.
    const created = vi.mocked(pane.setContentSize).mock.calls.length;
    h.host.resize("t1", 900, 700);
    h.host.resize("t1", 100, 9000);
    vi.advanceTimersByTime(BROWSER_PANE_RESIZE_DEBOUNCE_MS);
    expect(pane.setContentSize).toHaveBeenCalledTimes(created + 1);
    expect(pane.setContentSize).toHaveBeenLastCalledWith(BROWSER_PANE_MIN_VIEWPORT, BROWSER_PANE_MAX_VIEWPORT);

    h.host.input("t1", { type: "mouseMove", x: -5, y: 99999 });
    expect(pane.sendInputEvent).toHaveBeenCalledWith({
      type: "mouseMove",
      x: 0,
      y: BROWSER_PANE_MAX_VIEWPORT,
    });
    h.host.input("t1", { type: "edit", command: "selectAll" });
    expect(pane.selectAll).toHaveBeenCalledTimes(1);
    h.host.input("t1", { type: "insertText", text: "한🙂" });
    expect(pane.insertText).toHaveBeenCalledWith("한🙂");
    h.host.input("t1", { type: "imeSetComposition", text: "ㅎ", selectionStart: 1, selectionEnd: 1 });
    expect(pane.imeSetComposition).toHaveBeenCalledWith("ㅎ", 1, 1);
    expect(pane.sendInputEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "imeSetComposition" }));
  });

  it("drops input for a tab without a page", () => {
    const h = harness();
    expect(() => h.host.input("t1", { type: "keyDown", keyCode: "a" })).not.toThrow();
    expect(h.createPane).not.toHaveBeenCalled();
  });

  it("returns no-page before creation and clamps pick coordinates to the viewport", async () => {
    const h = harness();
    await expect(h.host.pick("t1", 10, 20)).resolves.toEqual({ status: "no-page" });
    await h.host.ensure("t1");
    const sendCommand = vi.mocked(h.panes[0]!.pane.debugger.sendCommand);
    sendCommand.mockImplementation(async (method) => {
      if (method === "Runtime.evaluate") return { result: { value: [0, 0] } };
      throw new Error("miss");
    });
    await expect(h.host.pick("t1", -50, 99_999)).resolves.toEqual({ status: "miss" });
    expect(sendCommand).toHaveBeenCalledWith(
      "DOM.getNodeForLocation",
      expect.objectContaining({ x: 0, y: BROWSER_PANE_DEFAULT_VIEWPORT.height }),
    );
  });
});

  it("clears after destroying live pages and recreates only a subscribed page", async () => {
    const h = harness();
    expect(h.host.livePageCount()).toBe(0);
    await h.host.ensure("hidden");
    await h.host.ensureEndpoint("visible");
    h.host.subscribe("visible", "client", true);
    await flush();
    h.panes[0]!.setUrl("https://hidden.test/");
    h.panes[0]!.emit("did-navigate");
    h.panes[1]!.setUrl("https://visible.test/");
    h.panes[1]!.emit("did-navigate");
    expect(h.host.livePageCount()).toBe(2);

    await h.host.clearData();
    expect(h.panes[0]!.pane.destroy).toHaveBeenCalledTimes(1);
    expect(h.panes[1]!.pane.destroy).toHaveBeenCalledTimes(1);
    expect(h.clearPartition).toHaveBeenCalledWith("persist:browser-pane");
    await flush();
    expect(h.createPane).toHaveBeenCalledTimes(3);
    expect(h.panes[2]!.pane.loadURL).toHaveBeenCalledWith("https://visible.test/");
    expect(h.listeners.every(({ listener }) => !vi.mocked(listener.close).mock.calls.length)).toBe(true);
  });

describe("BrowserPaneHost navigation and popups (U7 host)", () => {
  it("routes a popup through goto and drops non-web popups", async () => {
    const h = harness();
    await h.host.ensure("t1");
    const fake = h.panes[0]!;
    fake.opts.onPopup("https://example.com/popup");
    await flush();
    expect(fake.pane.loadURL).toHaveBeenLastCalledWith("https://example.com/popup");
    const calls = vi.mocked(fake.pane.loadURL).mock.calls.length;
    fake.opts.onPopup("javascript:alert(1)");
    fake.opts.onPopup("about:blank");
    fake.opts.onPopup("file:///etc/passwd");
    await flush();
    expect(vi.mocked(fake.pane.loadURL).mock.calls).toHaveLength(calls);
  });

  it("drops a disallowed goto and re-emits the unchanged state", async () => {
    const h = harness();
    await h.host.ensure("t1");
    const before = h.states().length;
    h.host.navigate("t1", { action: "goto", url: "file:///etc/passwd" });
    await flush();
    expect(h.panes[0]!.pane.loadURL).toHaveBeenCalledTimes(1);
    expect(h.states()).toHaveLength(before + 1);
    expect(h.states().at(-1)).toMatchObject({ url: null, alive: true });
  });

  it("maps back/forward/reload/stop onto the page, back only when history allows", async () => {
    const h = harness();
    await h.host.ensure("t1");
    const pane = h.panes[0]!.pane;
    h.host.navigate("t1", { action: "back" });
    h.host.navigate("t1", { action: "forward" });
    h.host.navigate("t1", { action: "reload" });
    h.host.navigate("t1", { action: "stop" });
    await flush();
    expect(pane.goBack).not.toHaveBeenCalled();
    expect(pane.goForward).toHaveBeenCalledTimes(1);
    expect(pane.reload).toHaveBeenCalledTimes(1);
    expect(pane.stop).toHaveBeenCalledTimes(1);
  });

  it("ignores navigation for a tab that has no armed pane", async () => {
    const h = harness();
    h.host.navigate("t1", { action: "goto", url: "https://example.com/" });
    await flush();
    expect(h.createPane).not.toHaveBeenCalled();
    expect(h.host.diagnostics()).toEqual([]);
  });

  it("publishes top-level navigation failures and records diagnostics", async () => {
    const h = harness();
    await h.host.ensure("t1");
    h.panes[0]!.emit(
      "did-fail-load",
      {},
      -105,
      "NAME_NOT_RESOLVED",
      "https://missing.invalid/",
      true,
    );

    expect(h.states().at(-1)).toMatchObject({
      error: "load-failed: NAME_NOT_RESOLVED",
    });
    expect(h.host.diagnostics()).toMatchObject([
      { tabId: "t1", lastError: "load-failed: NAME_NOT_RESOLVED" },
    ]);
  });
});

describe("BrowserPaneHost endpoint, agent state, and denied ports (U7 host)", () => {
  it("mints one listener per tab and reuses it", async () => {
    const h = harness();
    const url = await h.host.ensureEndpoint("t1");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:41000\/[A-Za-z0-9_-]{43}$/);
    expect(await h.host.ensureEndpoint("t1")).toBe(url);
    expect(h.listeners).toHaveLength(1);
    // The bridge's first client creates the page through the host.
    expect(h.listeners[0]!.deps.pane()).toBeNull();
    await h.listeners[0]!.deps.onFirstClient();
    expect(h.listeners[0]!.deps.pane()).toBe(h.panes[0]!.pane);
  });

  it("answers null with a warning when the listener cannot bind", async () => {
    const h = harness({ listenerFails: true });
    expect(await h.host.ensureEndpoint("t1")).toBeNull();
    expect(h.warnings[0]).toMatch(/EADDRINUSE/);
    await h.host.ensure("t1");
    expect(h.host.diagnostics()).toMatchObject([{ tabId: "t1", bridgePort: null, pageAlive: true }]);
  });

  it("derives detached → attached → acting → attached → detached from the bridge callbacks", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.host.ensureEndpoint("t1");
    const { deps } = h.listeners[0]!;
    const agents = () => h.states().map((s) => s.agent);

    deps.onClientCount(1);
    expect(agents()).toEqual(["attached"]);
    deps.onClientCount(2);
    expect(agents()).toEqual(["attached"]);

    deps.onCommand("Page.getNavigationHistory");
    expect(agents()).toEqual(["attached"]);
    deps.onCommand("Input.dispatchMouseEvent");
    expect(agents()).toEqual(["attached", "acting"]);
    vi.advanceTimersByTime(BROWSER_PANE_ACTING_MS - 100);
    // A repeat extends the window silently.
    deps.onCommand("Runtime.evaluate");
    vi.advanceTimersByTime(200);
    expect(agents()).toEqual(["attached", "acting"]);
    vi.advanceTimersByTime(BROWSER_PANE_ACTING_MS);
    expect(agents()).toEqual(["attached", "acting", "attached"]);

    deps.onCommand("Page.navigate");
    expect(agents().at(-1)).toBe("acting");
    deps.onClientCount(0);
    expect(agents().at(-1)).toBe("detached");
    vi.advanceTimersByTime(BROWSER_PANE_ACTING_MS * 2);
    expect(agents().at(-1)).toBe("detached");
    expect(h.host.diagnostics()).toMatchObject([{ tabId: "t1", cdpClients: 0, agentState: "detached" }]);
  });

  it("recomputes the denied ports on listener start, close, and remote port changes", async () => {
    const h = harness();
    expect([...h.host.deniedPorts()]).toEqual([]);
    await h.host.ensureEndpoint("t1");
    await h.host.ensureEndpoint("t2");
    expect([...h.host.deniedPorts()].sort()).toEqual([41000, 41001]);
    h.host.setRemoteAccessPort(7777);
    expect(h.host.deniedPorts().has(7777)).toBe(true);
    h.host.dispose("t1");
    expect(h.listeners[0]!.listener.close).toHaveBeenCalledTimes(1);
    expect([...h.host.deniedPorts()].sort()).toEqual([41001, 7777]);
    h.host.setRemoteAccessPort(null);
    expect([...h.host.deniedPorts()]).toEqual([41001]);
    h.host.disposeAll();
    expect([...h.host.deniedPorts()]).toEqual([]);
  });

  it("reports one diagnostics row per tab with a page or listener, URLs reduced to origin", async () => {
    const h = harness({ now: (() => {
      let t = 0;
      return () => (t += 5);
    })() });
    await h.host.ensureEndpoint("t1");
    await h.host.ensure("t1");
    const fake = h.panes[0]!;
    fake.setUrl("https://example.com/secret?token=1");
    fake.emit("did-navigate");
    h.host.subscribe("t1", "c1", true);
    await flush();
    fake.frame(1280, 800);
    expect(h.host.diagnostics()).toEqual([
      {
        tabId: "t1",
        pageAlive: true,
        subscribers: 1,
        cdpClients: 0,
        agentState: "detached",
        urlOrigin: "https://example.com",
        frame: { width: 1280, height: 800, dsf: 1 },
        targetDsf: 1,
        fps: 0,
        lastFrameProcessMs: expect.any(Number),
        bridgePort: 41000,
        partition: "persist:browser-pane",
        lastError: null,
      },
    ]);
  });
});

describe("BrowserPaneHost browser clock screenshot stamp", () => {
  const JPEG_CLIP = { format: "jpeg", quality: 40, clip: { x: 0, y: 0, width: 10, height: 10, scale: 2 } };

  it("returns the capture untouched when the tab's project has the clock off", async () => {
    const stampImage = vi.fn(async () => "c3RhbXBlZA==");
    const h = harness({ clock: { stampImage } });
    await h.host.ensureEndpoint("t1");
    const result = { data: "cmF3" };
    await expect(h.listeners[0]!.deps.transformScreenshot!(result, JPEG_CLIP)).resolves.toBe(result);
    expect(stampImage).not.toHaveBeenCalled();
  });

  it("stamps in the capture's format and quality, sized off the clip's CSS width, else the viewport's", async () => {
    const stampImage = vi.fn(async () => "c3RhbXBlZA==");
    const clockEnabled = vi.fn((tabId: string) => tabId === "t1");
    const h = harness({ clock: { targetScaleFactor: () => 2, clockEnabled, clockText: () => "10:42", stampImage } });
    await h.host.ensureEndpoint("t1");
    const { deps } = h.listeners[0]!;
    await deps.onFirstClient();

    const stamped = await deps.transformScreenshot!({ data: "cmF3", sentinel: 7 }, JPEG_CLIP);
    expect(stampImage).toHaveBeenCalledWith({
      data: "cmF3",
      mimeType: "image/jpeg",
      quality: 40,
      text: "10:42",
      cssWidth: 10,
    });
    expect(clockEnabled).toHaveBeenCalledWith("t1");
    expect(stamped).toEqual({ data: "c3RhbXBlZA==", sentinel: 7 });

    // No clip: the image spans the viewport, whatever dsf the host pins.
    await deps.transformScreenshot!({ data: "cmF3" }, { format: "webp" });
    expect(stampImage).toHaveBeenLastCalledWith({
      data: "cmF3",
      mimeType: "image/webp",
      quality: null,
      text: "10:42",
      cssWidth: BROWSER_PANE_DEFAULT_VIEWPORT.width,
    });
  });

  it("fails the capture with a browser clock error when the stamp rejects", async () => {
    const h = harness({
      clock: {
        clockEnabled: () => true,
        stampImage: async () => {
          throw new Error("the clock stamper timed out");
        },
      },
    });
    await h.host.ensureEndpoint("t1");
    await expect(h.listeners[0]!.deps.transformScreenshot!({ data: "cmF3" }, {})).rejects.toThrow(
      /^omp-ui browser clock.*the clock stamper timed out/,
    );
  });
});

describe("BrowserPaneHost session-level visibility (#556)", () => {
  it("emits the open flag only on a change", async () => {
    const h = harness();
    await h.host.ensureEndpoint("t1");
    expect(h.states()).toHaveLength(0);
    h.host.setOpen("t1", true);
    expect(h.states().at(-1)).toMatchObject({ open: true });
    const before = h.states().length;
    h.host.setOpen("t1", true);
    expect(h.states()).toHaveLength(before);
    h.host.setOpen("t1", false);
    expect(h.states().at(-1)).toMatchObject({ open: false });
  });

  it("includes the flag in the ensure answer and starts closed", async () => {
    const h = harness();
    const first = await h.host.ensure("t1");
    await flush();
    expect(first.status).toBe("available");
    if (first.status === "available") expect(first.state.open).toBe(false);
    h.host.setOpen("t1", true);
    const again = await h.host.ensure("t1");
    if (again.status === "available") expect(again.state.open).toBe(true);
  });

  it("closes the posture everywhere when the page is disposed", async () => {
    const h = harness();
    await h.host.ensureEndpoint("t1");
    h.host.setOpen("t1", true);
    h.host.dispose("t1");
    expect(h.states().at(-1)).toMatchObject({ open: false, alive: false });
  });

  it("painting is bound to subscribe, not to the open flag", async () => {
    const h = harness();
    await h.host.ensureEndpoint("t1");
    h.host.setOpen("t1", true);
    await flush();
    // An open pane nobody is viewing paints nothing.
    expect(h.panes).toHaveLength(0);
    h.host.subscribe("t1", "c1", true);
    await flush();
    expect(h.panes).toHaveLength(1);
  });
});

describe("BrowserPaneHost desktop media", () => {
  it("leases committed viewed pages without JPEG capture and recreates desktop-only pages", async () => {
    const media = vi.fn();
    const h = harness({ autoCommit: false, clock: { onDesktopMedia: media } });
    expect(h.host.mediaLease("unknown", 42)).toBeNull();
    await h.host.ensure("tab");
    h.host.setDesktopViewer("tab", "desktop", true);
    expect(h.host.mediaLease("tab", 42)).toBeNull();
    const first = h.panes[0]!;
    first.emit("did-navigate");
    await flush();
    const lease = h.host.mediaLease("tab", 42)!;
    expect(lease).toMatchObject({ sourceId: "source-42", geometry: { width: 1280, height: 800 } });
    expect(vi.mocked(first.pane.debugger.sendCommand).mock.calls.some(([method]) => method === "Page.startScreencast")).toBe(false);
    first.emit("did-navigate-in-page");
    await flush();
    expect(h.host.mediaLease("tab", 42)?.generation).toBe(lease.generation);
    media.mockClear();
    h.host.setDesktopViewer("tab", "desktop", true);
    expect(media).toHaveBeenCalledWith("tab", { type: "media-geometry", tabId: "tab", generation: lease.generation, geometry: lease.geometry });
    h.host.subscribe("tab", "remote", true);
    await flush();
    expect(vi.mocked(first.pane.debugger.sendCommand).mock.calls.some(([method]) => method === "Page.startScreencast")).toBe(true);
    h.host.subscribe("tab", "remote", false);
    await h.host.clearData();
    await flush();
    expect(first.pane.destroy).toHaveBeenCalledOnce();
    const ended = media.mock.calls.find(([, message]) => message.type === "media-ended")![1];
    expect(ended.generation).toBeGreaterThan(lease.generation);
    h.panes[1]!.emit("did-navigate");
    await flush();
    expect(h.host.mediaLease("tab", 42)!.generation).toBeGreaterThan(ended.generation);
    expect(vi.mocked(h.panes[1]!.pane.debugger.sendCommand).mock.calls.some(([method]) => method === "Page.startScreencast")).toBe(false);
    h.host.noteViewed("desktop", "other");
    expect(h.host.mediaLease("tab", 42)).toBeNull();
    expect(h.panes[1]!.pane.isDestroyed()).toBe(false);
    h.host.disposeAll();
  });

  it("pads only after override completion and publishes logical JPEG dimensions", async () => {
    vi.useFakeTimers();
    const media = vi.fn();
    const h = harness({ autoCommit: false, clock: { targetScaleFactor: () => 1.5, onDesktopMedia: media } });
    await h.host.ensure("tab");
    const fake = h.panes[0]!;
    h.host.resize("tab", 1514, 1337);
    vi.advanceTimersByTime(BROWSER_PANE_RESIZE_DEBOUNCE_MS);
    h.host.setDesktopViewer("tab", "desktop", true);
    expect(fake.pane.setContentSize).toHaveBeenLastCalledWith(2271, 2006);
    expect(media).not.toHaveBeenCalled();
    const command = vi.mocked(fake.pane.debugger.sendCommand);
    const normal = command.getMockImplementation()!;
    // Executor form: the node tsconfig lib is ES2022.
    let resolveOverride!: (value: unknown) => void;
    const override = new Promise<unknown>((resolve) => { resolveOverride = resolve; });
    command.mockImplementation((method, params, session) => method === "Emulation.setDeviceMetricsOverride"
      ? override : normal(method, params, session));
    fake.emit("did-navigate");
    expect(h.host.mediaLease("tab", 42)).toBeNull();
    expect(fake.pane.setContentSize).toHaveBeenLastCalledWith(2271, 2006);
    resolveOverride({});
    await flush();
    expect(fake.pane.setContentSize).toHaveBeenLastCalledWith(2272, 2006);
    expect(media.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(fake.pane.setContentSize).mock.invocationCallOrder.at(-1)!);
    expect(h.host.mediaLease("tab", 42)?.geometry).toEqual({ width: 2271, height: 2006, dsf: 1.5, surfaceWidth: 2272, surfaceHeight: 2006 });
    h.host.subscribe("tab", "remote", true);
    await flush();
    fake.frame(2272, 2006);
    const frame = decodeBrowserPaneFrame(h.frames()[0]!)!;
    expect(frame.header).toEqual({ width: 2271, height: 2006, dsf: 1.5 });
    expect(jpegDimensions(Buffer.from(frame.jpeg))).toEqual({ width: 2271, height: 2006 });
    h.host.disposeAll();
  });

  it.each(["destroy", "navigation", "resize"])("fences pending geometry after %s", async (change) => {
    vi.useFakeTimers();
    const media = vi.fn();
    const h = harness({ autoCommit: false, clock: { onDesktopMedia: media } });
    await h.host.ensure("tab");
    h.host.resize("tab", 1001, 801);
    vi.advanceTimersByTime(BROWSER_PANE_RESIZE_DEBOUNCE_MS);
    const fake = h.panes[0]!;
    let resolveOverride!: (value: unknown) => void;
    const override = new Promise<unknown>((resolve) => { resolveOverride = resolve; });
    vi.mocked(fake.pane.debugger.sendCommand).mockImplementation((method) => method === "Emulation.setDeviceMetricsOverride"
      ? override : Promise.resolve({}));
    fake.emit("did-navigate");
    if (change === "destroy") h.host.dispose("tab");
    else if (change === "navigation") fake.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    else {
      h.host.resize("tab", 1201, 901);
      vi.advanceTimersByTime(BROWSER_PANE_RESIZE_DEBOUNCE_MS);
      vi.mocked(fake.pane.debugger.sendCommand).mockClear();
    }
    media.mockClear();
    vi.mocked(fake.pane.setContentSize).mockClear();
    resolveOverride({});
    await flush();
    if (change === "resize") {
      expect(fake.pane.setContentSize).toHaveBeenCalledExactlyOnceWith(1202, 902);
      expect(media).toHaveBeenCalledWith("tab", expect.objectContaining({ geometry: expect.objectContaining({ width: 1201, height: 901 }) }));
    } else {
      expect(fake.pane.setContentSize).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
    }
    h.host.disposeAll();
  });
});
