import {
  DESKTOP_PANE_WINDOW_PORT,
  DESKTOP_PANE_WINDOW_REQUEST,
  type DesktopFrameDelivery,
  type DesktopFrameReply,
  type DesktopMediaGeometry,
  type DesktopMediaLease,
  type DesktopMediaMessage,
} from "../../../browser-pane-desktop-protocol";

interface PaneWindow {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

type FrameCallback = (tabId: string, frame: Uint8Array) => void | Promise<void>;

export interface DesktopPaneMedia {
  requestMediaLease(tabId: string): Promise<DesktopMediaLease | null>;
  onMediaMessage(callback: (message: DesktopMediaMessage) => void): () => void;
}

function isGeometry(value: unknown): value is DesktopMediaGeometry {
  if (typeof value !== "object" || value === null) return false;
  return ["width", "height", "dsf", "surfaceWidth", "surfaceHeight"].every((key) =>
    key in value && typeof Reflect.get(value, key) === "number" &&
    Number.isFinite(Reflect.get(value, key)) && Reflect.get(value, key) > 0);
}

function isMediaMessage(value: unknown): value is DesktopMediaMessage {
  if (typeof value !== "object" || value === null || !("type" in value) ||
    !("tabId" in value) || typeof value.tabId !== "string") return false;
  if (value.type === "media-lease") {
    if (!("requestId" in value) || !Number.isSafeInteger(value.requestId) || !("lease" in value)) return false;
    const lease = value.lease;
    return lease === null || (typeof lease === "object" && "sourceId" in lease &&
      typeof lease.sourceId === "string" && "generation" in lease && Number.isSafeInteger(lease.generation) &&
      "geometry" in lease && isGeometry(lease.geometry));
  }
  return "generation" in value && Number.isSafeInteger(value.generation) &&
    (value.type === "media-ended" || (value.type === "media-geometry" &&
      "geometry" in value && isGeometry(value.geometry)));
}

function isDelivery(value: unknown): value is DesktopFrameDelivery {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "frame" &&
    "id" in value && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 &&
    "tabId" in value && typeof value.tabId === "string" &&
    "frame" in value && value.frame instanceof Uint8Array;
}

/** ACKs only after the registered writer has painted or deliberately dropped a frame. */
export function createDesktopPaneFrameReceiver(win: PaneWindow = window) {
  let port: MessagePort | null = null;
  let callback: FrameCallback | null = null;
  let disposed = false;
  let ready = false;
  let nextRequestId = 0;
  const mediaListeners = new Set<(message: DesktopMediaMessage) => void>();
  const pending = new Map<number, { tabId: string; resolve: (lease: DesktopMediaLease | null) => void; sent: boolean }>();

  const request = (): void => win.postMessage(DESKTOP_PANE_WINDOW_REQUEST, "*");
  const reply = (target: MessagePort, message: DesktopFrameReply): void => {
    if (disposed || port !== target) return;
    try {
      target.postMessage(message);
    } catch {
      // A closed endpoint cannot accept credit. Its close event replaces it.
    }
  };
  const sendReady = (): void => {
    if (port === null || (callback === null && mediaListeners.size === 0) || ready) return;
    ready = true;
    reply(port, { type: "ready" });
  };
  const sendRequests = (): void => {
    if (port === null) return;
    for (const [requestId, entry] of pending) {
      if (entry.sent) continue;
      entry.sent = true;
      try {
        port.postMessage({ type: "media-lease-request", requestId, tabId: entry.tabId } satisfies DesktopFrameReply);
      } catch {
        pending.delete(requestId);
        entry.resolve(null);
      }
    }
  };
  const receive = async (target: MessagePort, value: unknown): Promise<void> => {
    if (disposed || port !== target) return;
    if (isMediaMessage(value)) {
      if (value.type === "media-lease") {
        const entry = pending.get(value.requestId);
        if (entry?.tabId !== value.tabId) return;
        pending.delete(value.requestId);
        entry.resolve(value.lease);
      }
      for (const listener of mediaListeners) listener(value);
      return;
    }
    if (!ready || !isDelivery(value)) return;
    try {
      await callback?.(value.tabId, value.frame);
    } catch {
      // Writer failures intentionally drop the delivery, just like decode failures.
    } finally {
      reply(target, { type: "ack", id: value.id });
    }
  };
  const closePort = (): void => {
    const previous = port;
    port = null;
    ready = false;
    for (const entry of pending.values()) entry.resolve(null);
    pending.clear();
    if (previous !== null) {
      previous.onmessage = null;
      previous.close();
    }
  };
  const accept = (event: MessageEvent): void => {
    if (event.data !== DESKTOP_PANE_WINDOW_PORT) return;
    if (disposed || event.source !== win || event.ports.length !== 1) {
      for (const extra of event.ports) extra.close();
      return;
    }
    if (port !== null) closePort();
    const next = event.ports[0]!;
    port = next;
    next.onmessage = (message: MessageEvent<unknown>) => { void receive(next, message.data); };
    next.addEventListener("close", () => {
      if (disposed || port !== next) return;
      closePort();
      request();
    }, { once: true });
    next.start();
    sendReady();
    sendRequests();
  };

  win.addEventListener("message", accept);
  request();
  return {
    onFrame(cb: FrameCallback): void {
      if (disposed) return;
      callback = cb;
      sendReady();
    },
    requestMediaLease(tabId: string): Promise<DesktopMediaLease | null> {
      if (disposed) return Promise.resolve(null);
      const { promise, resolve } = Promise.withResolvers<DesktopMediaLease | null>();
      pending.set(++nextRequestId, { tabId, resolve, sent: false });
      sendRequests();
      return promise;
    },
    onMediaMessage(cb: (message: DesktopMediaMessage) => void): () => void {
      if (disposed) return () => {};
      mediaListeners.add(cb);
      sendReady();
      return () => { mediaListeners.delete(cb); };
    },
    dispose(): void {
      disposed = true;
      callback = null;
      mediaListeners.clear();
      win.removeEventListener("message", accept);
      closePort();
    },
  };
}
