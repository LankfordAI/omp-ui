// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_PANE_WINDOW_PORT,
  DESKTOP_PANE_WINDOW_REQUEST,
} from "../../../browser-pane-desktop-protocol";
import { createDesktopPaneFrameReceiver } from "./browser-pane-desktop-stream";

class Port implements MessagePort {
  // jsdom unwraps DOM wrappers in MessageEventInit.ports but does not wrap
  // each entry back on read. Keep this port plain and delegate its events.
  private readonly events = new EventTarget();
  addEventListener = this.events.addEventListener.bind(this.events);
  removeEventListener = this.events.removeEventListener.bind(this.events);
  dispatchEvent = this.events.dispatchEvent.bind(this.events);
  onmessage: ((this: MessagePort, event: MessageEvent) => unknown) | null = null;
  onmessageerror: ((this: MessagePort, event: MessageEvent) => unknown) | null = null;
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();
  message(data: unknown): void {
    this.onmessage?.call(this, new MessageEvent("message", { data }));
  }
  deliver(id: number): void {
    this.onmessage?.call(this, new MessageEvent("message", {
      data: { type: "frame", id, tabId: "tab", frame: new Uint8Array([id]) },
    }));
  }
}

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});

function harness() {
  const request = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  const receiver = createDesktopPaneFrameReceiver();
  disposals.push(() => receiver.dispose());
  const attach = (ports: MessagePort[], source: Window | null = window, marker = DESKTOP_PANE_WINDOW_PORT): void => {
    window.dispatchEvent(new MessageEvent("message", { data: marker, source, ports }));
  };
  return { receiver, request, attach };
}

const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe("desktop pane receiver", () => {
  it("installs its listener before requesting and waits for the callback before ready", () => {
    const port = new Port();
    vi.spyOn(window, "postMessage").mockImplementation(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: window, data: DESKTOP_PANE_WINDOW_PORT, ports: [port],
      }));
    });
    const receiver = createDesktopPaneFrameReceiver();
    disposals.push(() => receiver.dispose());
    expect(port.postMessage).not.toHaveBeenCalled();
    receiver.onFrame(() => {});
    expect(port.postMessage.mock.calls).toEqual([[{ type: "ready" }]]);
    receiver.onFrame(() => {});
    expect(port.postMessage.mock.calls).toEqual([[{ type: "ready" }]]);
  });

  it("withholds ACK until painting completes", async () => {
    const h = harness();
    const port = new Port();
    const painting = Promise.withResolvers<void>();
    const writer = vi.fn(() => painting.promise);
    h.receiver.onFrame(writer);
    h.attach([port]);
    port.deliver(7);
    await settle();
    expect(writer).toHaveBeenCalledWith("tab", new Uint8Array([7]));
    expect(port.postMessage.mock.calls).toEqual([[{ type: "ready" }]]);
    painting.resolve();
    await settle();
    expect(port.postMessage.mock.calls).toEqual([[{ type: "ready" }], [{ type: "ack", id: 7 }]]);
  });

  it.each(["drop", "throw", "reject"])("ACKs an intentional %s without blocking future deliveries", async (outcome) => {
    const h = harness();
    const port = new Port();
    h.receiver.onFrame(() => {
      if (outcome === "throw") throw new Error("paint failed");
      if (outcome === "reject") return Promise.reject(new Error("decode failed"));
    });
    h.attach([port]);
    port.deliver(1);
    await settle();
    port.deliver(2);
    await settle();
    expect(port.postMessage.mock.calls).toEqual([
      [{ type: "ready" }], [{ type: "ack", id: 1 }], [{ type: "ack", id: 2 }],
    ]);
  });

  it("closes superseded ports and fences their unfinished paints and close events", async () => {
    const h = harness();
    const first = new Port();
    const second = new Port();
    const painting = Promise.withResolvers<void>();
    h.receiver.onFrame(() => painting.promise);
    h.attach([first]);
    first.deliver(1);
    h.attach([second]);
    expect(first.close).toHaveBeenCalledOnce();
    first.dispatchEvent(new Event("close"));
    painting.resolve();
    await settle();
    expect(first.postMessage.mock.calls).toEqual([[{ type: "ready" }]]);
    expect(second.postMessage.mock.calls).toEqual([[{ type: "ready" }]]);
    expect(h.request.mock.calls).toEqual([[DESKTOP_PANE_WINDOW_REQUEST, "*"]]);
  });

  it("requests exactly one immediate replacement on live close, never on disposal", async () => {
    const h = harness();
    const first = new Port();
    h.receiver.onFrame(() => {});
    h.attach([first]);
    first.dispatchEvent(new Event("close"));
    first.dispatchEvent(new Event("close"));
    expect(h.request.mock.calls).toEqual([
      [DESKTOP_PANE_WINDOW_REQUEST, "*"], [DESKTOP_PANE_WINDOW_REQUEST, "*"],
    ]);
    const second = new Port();
    const painting = Promise.withResolvers<void>();
    h.receiver.onFrame(() => painting.promise);
    h.attach([second]);
    second.deliver(2);
    h.receiver.dispose();
    second.dispatchEvent(new Event("close"));
    painting.resolve();
    await settle();
    expect(second.close).toHaveBeenCalledOnce();
    expect(second.postMessage.mock.calls).toEqual([[{ type: "ready" }]]);
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it("rejects a foreign source or extra ports without displacing the live port", async () => {
    const h = harness();
    const writer = vi.fn();
    h.receiver.onFrame(writer);
    const live = new Port();
    h.attach([live]);
    const foreign = new Port();
    h.attach([foreign], null);
    const extra = [new Port(), new Port()];
    h.attach(extra);
    h.attach([]);
    const unrelated = new Port();
    h.attach([unrelated], window, "another-protocol");
    expect(foreign.close).toHaveBeenCalledOnce();
    for (const port of extra) expect(port.close).toHaveBeenCalledOnce();
    expect(live.close).not.toHaveBeenCalled();
    live.deliver(3);
    await settle();
    expect(writer).toHaveBeenCalledWith("tab", new Uint8Array([3]));
    expect(live.postMessage).toHaveBeenLastCalledWith({ type: "ack", id: 3 });
  });

  it("queues leases before the first port and settles only the matching tab and request", async () => {
    const h = harness();
    const pending = h.receiver.requestMediaLease("tab");
    const port = new Port();
    h.attach([port]);
    const request = port.postMessage.mock.calls[0]![0];
    expect(request).toEqual({ type: "media-lease-request", requestId: 1, tabId: "tab" });
    let settled = false;
    void pending.then(() => { settled = true; });
    port.message({ type: "media-lease", requestId: 1, tabId: "other", lease: null });
    await settle();
    expect(settled).toBe(false);
    const lease = { sourceId: "source", generation: 3, geometry: { width: 3, height: 5, dsf: 1.5, surfaceWidth: 4, surfaceHeight: 6 } };
    port.message({ type: "media-lease", requestId: 1, tabId: "tab", lease });
    expect(await pending).toEqual(lease);
  });

  it("settles leases null on replacement, live close and disposal, fencing late replies", async () => {
    const h = harness();
    const first = new Port();
    h.attach([first]);
    const replaced = h.receiver.requestMediaLease("tab");
    const staleHandler = first.onmessage!;
    const second = new Port();
    h.attach([second]);
    expect(await replaced).toBeNull();
    const current = h.receiver.requestMediaLease("tab");
    staleHandler.call(first, new MessageEvent("message", { data: { type: "media-lease", requestId: 2, tabId: "tab", lease: null } }));
    let settled = false;
    void current.then(() => { settled = true; });
    await settle();
    expect(settled).toBe(false);
    second.dispatchEvent(new Event("close"));
    expect(await current).toBeNull();
    const queued = h.receiver.requestMediaLease("tab");
    h.receiver.dispose();
    expect(await queued).toBeNull();
    expect(await h.receiver.requestMediaLease("tab")).toBeNull();
  });

  it("notifies media listeners without consuming JPEG credit and removes disposed listeners", async () => {
    const h = harness();
    const listener = vi.fn();
    const unsubscribe = h.receiver.onMediaMessage(listener);
    const port = new Port();
    h.attach([port]);
    const ended = { type: "media-ended", tabId: "tab", generation: 3 };
    port.message(ended);
    await settle();
    expect(listener).toHaveBeenCalledWith(ended);
    expect(port.postMessage.mock.calls).toEqual([[{ type: "ready" }]]);
    unsubscribe();
    port.message(ended);
    expect(listener).toHaveBeenCalledOnce();
  });
});
