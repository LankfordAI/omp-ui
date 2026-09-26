import type { DesktopFrameDelivery } from "../browser-pane-desktop-protocol";

export interface DesktopPaneSubscription {
  tabId: string;
  clientId: string;
}

export interface DesktopPaneStream {
  subscribe(tabId: string, clientId: string, on: boolean): void;
  noteViewed(clientId: string, tabId: string | null): void;
  offer(tabId: string, frame: Uint8Array): void;
  ready(send: (delivery: DesktopFrameDelivery) => void): void;
  ack(id: number): void;
  disconnect(): void;
  reset(): DesktopPaneSubscription[];
}

/** One delivery awaiting paint, plus the latest pending frame per desired tab. */
export function createDesktopPaneStream(): DesktopPaneStream {
  const desired = new Map<string, Set<string>>();
  const pending = new Map<string, Uint8Array>();
  let inflight: DesktopFrameDelivery | null = null;
  let send: ((delivery: DesktopFrameDelivery) => void) | null = null;
  let nextId = 1;

  const disconnect = (): void => {
    send = null;
    if (inflight !== null && desired.has(inflight.tabId) && !pending.has(inflight.tabId)) {
      pending.set(inflight.tabId, inflight.frame);
    }
    inflight = null;
  };

  const flush = (): void => {
    if (send === null || inflight !== null) return;
    // Never wrap IDs: a delayed ACK must not acquire a later delivery's credit.
    if (!Number.isSafeInteger(nextId)) {
      disconnect();
      return;
    }
    for (const [tabId, frame] of pending) {
      pending.delete(tabId);
      if (!desired.has(tabId)) continue;
      const delivery: DesktopFrameDelivery = { type: "frame", id: nextId++, tabId, frame };
      inflight = delivery;
      try {
        send(delivery);
      } catch {
        disconnect();
      }
      return;
    }
  };

  const subscribe = (tabId: string, clientId: string, on: boolean): void => {
    if (on) {
      let clients = desired.get(tabId);
      if (clients === undefined) {
        clients = new Set();
        desired.set(tabId, clients);
      }
      clients.add(clientId);
    } else {
      const clients = desired.get(tabId);
      clients?.delete(clientId);
      if (clients?.size === 0) {
        desired.delete(tabId);
        pending.delete(tabId);
      }
    }
  };

  return {
    subscribe,
    noteViewed(clientId: string, tabId: string | null): void {
      for (const id of desired.keys()) {
        if (id !== tabId) subscribe(id, clientId, false);
      }
    },
    offer(tabId: string, frame: Uint8Array): void {
      if (!desired.has(tabId)) return;
      pending.set(tabId, frame);
      flush();
    },
    ready(deliver: (delivery: DesktopFrameDelivery) => void): void {
      send = deliver;
      flush();
    },
    ack(id: number): void {
      if (!Number.isSafeInteger(id) || inflight?.id !== id) return;
      inflight = null;
      flush();
    },
    disconnect,
    reset(): DesktopPaneSubscription[] {
      const subscriptions: DesktopPaneSubscription[] = [];
      for (const [tabId, clients] of desired) {
        for (const clientId of clients) subscriptions.push({ tabId, clientId });
      }
      send = null;
      inflight = null;
      pending.clear();
      desired.clear();
      return subscriptions;
    },
  };
}
