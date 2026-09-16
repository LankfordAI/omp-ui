import {
  BROWSER_PANE_ACTING_MS,
  BROWSER_PANE_FPS,
  BROWSER_PANE_MAX_VIEWPORT,
  BROWSER_PANE_MIN_VIEWPORT,
  BROWSER_PANE_RESIZE_DEBOUNCE_MS,
  CH,
  decodeBrowserPaneFrame,
  type BrowserPaneState,
} from "@omp-ui/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeListener, BridgeListenerDeps, CreateBridgeListener } from "./browser-pane-bridge";
import type { CreatePane, CreatePaneOptions, PaneContents, PaneEvent } from "./browser-pane-contents";
import { BrowserPaneHost } from "./browser-pane-host";

interface FakePane {
  pane: PaneContents;
  opts: CreatePaneOptions;
  /** Delivers one paint at the given physical size. */
  paint(width: number, height: number, jpeg: Buffer): void;
  emit(event: PaneEvent): void;
  setUrl(url: string): void;
}

function fakePane(opts: CreatePaneOptions): FakePane {
  const handlers = new Map<PaneEvent, Set<(...args: unknown[]) => void>>();
  let paintCb: Parameters<PaneContents["onPaint"]>[0] | null = null;
  let url = "";
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
    paint: (width, height, jpeg) =>
      paintCb?.({ x: 0, y: 0, width, height }, { toJPEG: () => jpeg, getSize: () => ({ width, height }) }),
    emit: (event) => {
      for (const cb of handlers.get(event) ?? []) cb();
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
  /** Only the state emits, in order. */
  states(): BrowserPaneState[];
  frames(): Uint8Array[];
}

function harness(opts: { paneFails?: boolean; listenerFails?: boolean; now?: () => number } = {}): Harness {
  const sent: Harness["sent"] = [];
  const panes: FakePane[] = [];
  const listeners: Harness["listeners"] = [];
  const warnings: string[] = [];
  let nextPort = 41000;
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
    warn: (message) => warnings.push(message),
  });
  return {
    host,
    sent,
    panes,
    listeners,
    warnings,
    createPane,
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

  it("clamps the display scale and stamps it into the frame header", async () => {
    const sent: Harness["sent"] = [];
    const panes: FakePane[] = [];
    const host = new BrowserPaneHost({
      send: (channel, ...args) => sent.push({ channel, args }),
      createPane: async (opts) => {
        const fake = fakePane(opts);
        panes.push(fake);
        return fake.pane;
      },
      displayScaleFactor: () => 3,
    });
    host.subscribe("t1", "c1", true);
    await flush();
    expect(panes[0]!.opts.deviceScaleFactor).toBe(2);
    panes[0]!.paint(2560, 1600, Buffer.from([1]));
    const frame = sent.find((s) => s.channel === CH.onBrowserPaneFrame)?.args[1] as Uint8Array;
    expect(decodeBrowserPaneFrame(frame)?.header).toEqual({ width: 2560, height: 1600, dsf: 2 });
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
    h.host.resize("t1", 900, 700);
    h.host.resize("t1", 100, 9000);
    vi.advanceTimersByTime(BROWSER_PANE_RESIZE_DEBOUNCE_MS);
    expect(pane.setContentSize).toHaveBeenCalledTimes(1);
    expect(pane.setContentSize).toHaveBeenCalledWith(BROWSER_PANE_MIN_VIEWPORT, BROWSER_PANE_MAX_VIEWPORT);

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
  });

  it("drops input for a tab without a page", () => {
    const h = harness();
    expect(() => h.host.input("t1", { type: "keyDown", keyCode: "a" })).not.toThrow();
    expect(h.createPane).not.toHaveBeenCalled();
  });
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

  it("creates the page for a goto on a tab that has none", async () => {
    const h = harness();
    h.host.navigate("t1", { action: "goto", url: "https://example.com/" });
    await flush();
    expect(h.createPane).toHaveBeenCalledTimes(1);
    expect(h.panes[0]!.pane.loadURL).toHaveBeenLastCalledWith("https://example.com/");
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
        fps: 0,
        lastEncodeMs: 5,
        bridgePort: 41000,
        partition: "persist:browser-pane",
        lastError: null,
      },
    ]);
  });
});
