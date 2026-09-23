import {
  BROWSER_PANE_ACTING_MS,
  BROWSER_PANE_DEFAULT_VIEWPORT,
  BROWSER_PANE_FPS,
  BROWSER_PANE_JPEG_QUALITY,
  BROWSER_PANE_JPEG_QUALITY_SETTLED,
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

interface FakePane {
  pane: PaneContents;
  opts: CreatePaneOptions;
  /** Delivers one paint at the given physical size. */
  paint(width: number, height: number, jpeg: Buffer): void;
  /** The toJPEG mock of the most recent paint. */
  lastJpegQuality(): number | undefined;
  setLoading(on: boolean): void;
  emit(event: PaneEvent, ...args: unknown[]): void;
  setUrl(url: string): void;
}

function fakePane(opts: CreatePaneOptions): FakePane {
  const handlers = new Map<PaneEvent, Set<(...args: unknown[]) => void>>();
  let paintCb: Parameters<PaneContents["onPaint"]>[0] | null = null;
  let url = "";
  let loading = false;
  let toJPEG: Mock<(quality: number) => Buffer> | undefined;
  let destroyed = false;
  const pane: PaneContents = {
    onPaint: (cb) => {
      paintCb = cb;
      return () => {
        paintCb = null;
      };
    },
    setFrameRate: vi.fn(),
    startPainting: vi.fn(),
    stopPainting: vi.fn(),
    invalidate: vi.fn(),
    setContentSize: vi.fn(),
    getContentSize: () => ({ width: opts.width, height: opts.height }),
    loadURL: vi.fn(async (next: string) => {
      url = next;
      // Real Electron commits every load with did-stop-loading; the host gates
      // the metrics override on that first commit (#557).
      for (const cb of handlers.get("did-stop-loading") ?? []) cb();
    }),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => true,
    getURL: () => url,
    getTitle: () => "Fake",
    isLoading: () => loading,
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
      sendCommand: vi.fn(async () => ({})),
      on: vi.fn(),
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
    paint: (width, height, jpeg) => {
      toJPEG = vi.fn<(quality: number) => Buffer>(() => jpeg);
      paintCb?.({ x: 0, y: 0, width, height }, { toJPEG, getSize: () => ({ width, height }) });
    },
    lastJpegQuality: () => toJPEG?.mock.calls.at(-1)?.[0],
    setLoading: (on) => {
      loading = on;
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

type ClockDeps = Pick<BrowserPaneHostDeps, "targetScaleFactor" | "clockEnabled" | "clockText" | "stampImage">;

function harness(
  opts: { paneFails?: boolean; listenerFails?: boolean; now?: () => number; clock?: ClockDeps } = {},
): Harness {
  const sent: Harness["sent"] = [];
  const panes: FakePane[] = [];
  const listeners: Harness["listeners"] = [];
  const warnings: string[] = [];
  let nextPort = 41000;
  const clearPartition = vi.fn<(partition: string) => Promise<void>>(async () => {});
  const createPane = vi.fn<CreatePane>(async (paneOpts) => {
    if (opts.paneFails === true) throw new Error("no gpu");
    const fake = fakePane(paneOpts);
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
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserPaneHost sink registry (U2)", () => {
  it("creates the page on the first sink, paints at BROWSER_PANE_FPS, and stops when the last sink leaves", async () => {
    const h = harness();
    await h.host.ensureEndpoint("t1");
    h.host.subscribe("t1", "c1", true);
    await flush();
    expect(h.createPane).toHaveBeenCalledTimes(1);
    const pane = h.panes[0]!.pane;
    expect(pane.setFrameRate).toHaveBeenCalledWith(BROWSER_PANE_FPS);
    expect(pane.startPainting).toHaveBeenCalledTimes(1);
    expect(pane.debugger.attach).toHaveBeenCalledWith("1.3");
    // No cached frame yet: the page is asked to paint instead of a replay.
    expect(pane.invalidate).toHaveBeenCalledTimes(1);
    expect(h.frames()).toEqual([]);

    h.host.subscribe("t1", "c2", true);
    await flush();
    expect(h.createPane).toHaveBeenCalledTimes(1);
    expect(pane.startPainting).toHaveBeenCalledTimes(1);

    h.host.subscribe("t1", "c1", false);
    expect(pane.stopPainting).not.toHaveBeenCalled();
    h.host.subscribe("t1", "c2", false);
    expect(pane.stopPainting).toHaveBeenCalledTimes(1);
  });

  it("stops painting immediately after creation when nobody is subscribed", async () => {
    const h = harness();
    await h.host.ensure("t1");
    const pane = h.panes[0]!.pane;
    expect(pane.stopPainting).toHaveBeenCalledTimes(1);
    expect(pane.startPainting).not.toHaveBeenCalled();
    expect(pane.loadURL).toHaveBeenCalledWith("about:blank");
  });

  it("noteViewed drops the client's sink from every other tab", async () => {
    const h = harness();
    await Promise.all([h.host.ensureEndpoint("t1"), h.host.ensureEndpoint("t2")]);
    h.host.subscribe("t1", "c1", true);
    h.host.subscribe("t2", "c1", true);
    await flush();
    const [p1, p2] = h.panes.map((p) => p.pane);
    h.host.noteViewed("c1", "t2");
    expect(p1!.stopPainting).toHaveBeenCalledTimes(1);
    expect(p2!.stopPainting).not.toHaveBeenCalled();
    h.host.noteViewed("c1", null);
    expect(p2!.stopPainting).toHaveBeenCalledTimes(1);
  });

  it("sends frames only while sinks exist and replays the cached frame to a newcomer", async () => {
    const h = harness();
    await h.host.ensure("t1");
    const fake = h.panes[0]!;
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3]);
    fake.paint(1280, 800, jpeg);
    expect(h.frames()).toEqual([]);

    h.host.subscribe("t1", "c1", true);
    await flush();
    // Replay, not invalidate: the cache answers the newcomer.
    expect(fake.pane.invalidate).not.toHaveBeenCalled();
    const [replayed] = h.frames();
    const decoded = decodeBrowserPaneFrame(replayed!);
    expect(decoded?.header).toEqual({ width: 1280, height: 800, dsf: 1 });
    expect(Buffer.from(decoded!.jpeg).equals(jpeg)).toBe(true);

    fake.paint(1280, 800, Buffer.from([9, 9]));
    expect(h.frames()).toHaveLength(2);
    h.host.subscribe("t1", "c1", false);
    fake.paint(1280, 800, Buffer.from([7]));
    expect(h.frames()).toHaveLength(2);

    const result = await h.host.ensure("t1");
    expect(result).toMatchObject({ status: "available", frame: { width: 1280, height: 800, dsf: 1 } });
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
    // Window at css*2 (the BROWSER_PANE_MAX_DSF clamp), CSS viewport pinned at 2x.
    expect(pane.setContentSize).toHaveBeenCalledWith(2560, 1600);
    expect(pane.debugger.sendCommand).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 2,
      mobile: false,
    });
    panes[0]!.paint(2560, 1600, Buffer.from([1]));
    const frame = sent.find((s) => s.channel === CH.onBrowserPaneFrame)?.args[1] as Uint8Array;
    expect(decodeBrowserPaneFrame(frame)?.header).toEqual({ width: 2560, height: 1600, dsf: 2 });
    expect(host.diagnostics()[0]).toMatchObject({ targetDsf: 2, metricsMode: "window-scaled" });
  });

  it("drops an empty paint and stamps the dsf the frame was really painted at", async () => {
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
    // Electron's first paint of a fresh window is 0×0: never a frame, never cached.
    panes[0]!.paint(0, 0, Buffer.alloc(0));
    expect(sent.filter((s) => s.channel === CH.onBrowserPaneFrame)).toHaveLength(0);
    expect(await host.ensure("t1")).toMatchObject({ status: "available", frame: null });
    // A route that yields nothing (override ineffective) falls back to dsf 1, never a false 2.
    panes[0]!.paint(1280, 800, Buffer.from([1]));
    const frame = sent.find((s) => s.channel === CH.onBrowserPaneFrame)?.args[1] as Uint8Array;
    expect(decodeBrowserPaneFrame(frame)?.header).toEqual({ width: 1280, height: 800, dsf: 1 });
    expect(host.diagnostics()[0]?.frame).toEqual({ width: 1280, height: 800, dsf: 1 });
  });

  it("sizes the window and header for a fractional target density", async () => {
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
    expect(pane.setContentSize).toHaveBeenCalledWith(1920, 1200);
    expect(pane.debugger.sendCommand).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1.5,
      mobile: false,
    });
    panes[0]!.paint(1920, 1200, Buffer.from([1]));
    const frame = sent.find((s) => s.channel === CH.onBrowserPaneFrame)?.args[1] as Uint8Array;
    expect(decodeBrowserPaneFrame(frame)?.header).toEqual({ width: 1920, height: 1200, dsf: 1.5 });
    expect(host.diagnostics()[0]).toMatchObject({ targetDsf: 1.5, metricsMode: "window-scaled" });
  });

  it("shrinks the window once when a platform squares the scale, then converges", async () => {
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
    const pane = panes[0]!.pane;
    // A window-DIP-auto-scaled platform paints css*2*2: the header tells the truth
    // for that frame and the host shrinks the window to CSS size once.
    panes[0]!.paint(5120, 3200, Buffer.from([1]));
    expect(decodeBrowserPaneFrame(sent.at(-1)?.args[1] as Uint8Array)?.header.dsf).toBe(4);
    expect(pane.setContentSize).toHaveBeenLastCalledWith(1280, 800);
    expect(pane.debugger.sendCommand).toHaveBeenLastCalledWith("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 2,
      mobile: false,
    });
    expect(host.diagnostics()[0]).toMatchObject({ targetDsf: 2, metricsMode: "window-css" });
    panes[0]!.paint(2560, 1600, Buffer.from([2]));
    expect(decodeBrowserPaneFrame(sent.at(-1)?.args[1] as Uint8Array)?.header).toEqual({
      width: 2560,
      height: 1600,
      dsf: 2,
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
    // Clear, then size, then set: the clear is what makes Chromium accept the
    // otherwise-identical override again.
    expect(sendCommand).toHaveBeenCalledTimes(overrides + 2);
    expect(sendCommand).toHaveBeenNthCalledWith(overrides + 1, "Emulation.clearDeviceMetricsOverride");
    expect(sendCommand).toHaveBeenLastCalledWith("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const clearOrder = sendCommand.mock.invocationCallOrder[overrides]!;
    const sizeOrder = setContentSize.mock.invocationCallOrder[sizes]!;
    const setOrder = sendCommand.mock.invocationCallOrder[overrides + 1]!;
    expect(clearOrder).toBeLessThan(sizeOrder);
    expect(sizeOrder).toBeLessThan(setOrder);
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

  it("encodes loading frames at 70 and settled frames at 85", async () => {
    const h = harness();
    await h.host.ensure("t1");
    const fake = h.panes[0]!;
    fake.setLoading(true);
    fake.paint(1280, 800, Buffer.from([1]));
    expect(fake.lastJpegQuality()).toBe(BROWSER_PANE_JPEG_QUALITY);
    fake.setLoading(false);
    fake.paint(1280, 800, Buffer.from([1]));
    expect(fake.lastJpegQuality()).toBe(BROWSER_PANE_JPEG_QUALITY_SETTLED);
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
    fake.paint(1280, 800, Buffer.from([1]));
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
        metricsMode: "window-scaled",
        fps: 0,
        lastEncodeMs: 5,
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
