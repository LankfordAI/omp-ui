import { normalizeControlFrame, type RpcFrame } from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

interface BridgeSnapshot {
  processKey: string;
  revision: number;
}

interface BridgeOwner {
  current: string;
  retired: Set<string>;
}

export interface BridgeSnapshotTrackerOptions<T extends BridgeSnapshot> {
  statusKey: string;
  parse: (value: unknown) => T | null;
  broadcast: () => Promise<void>;
  onAccept?: (tabId: string, snapshot: T) => void;
  onClear?: (tabId: string) => boolean;
}

/** Monotonic, process-owned projection of one generated bridge status stream. */
export class BridgeSnapshotTracker<T extends BridgeSnapshot> implements FrameObserver {
  private readonly latest = new Map<string, T>();
  private readonly owners = new Map<string, BridgeOwner>();

  constructor(private readonly options: BridgeSnapshotTrackerOptions<T>) {}

  snapshot(tabId: string): T | undefined {
    return this.latest.get(tabId);
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    const control = normalizeControlFrame(frame);
    if (control === null || control.kind !== "ext_request" || control.method !== "setStatus") return;
    const wire = control.frame;
    if (wire.statusKey !== this.options.statusKey) return;
    const snapshot = this.options.parse(
      typeof wire.statusText === "string" ? wire.statusText : undefined,
    );
    if (snapshot === null || !this.adopts(tabId, snapshot.processKey)) return;
    const retained = this.latest.get(tabId);
    if (
      retained !== undefined &&
      retained.processKey === snapshot.processKey &&
      snapshot.revision <= retained.revision
    ) {
      return;
    }
    this.latest.set(tabId, snapshot);
    this.options.onAccept?.(tabId, snapshot);
    void this.options.broadcast();
  }

  onExit(tabId: string): void {
    this.clear(tabId);
  }

  dispose(tabId: string): void {
    this.clear(tabId);
  }

  private adopts(tabId: string, processKey: string): boolean {
    const owner = this.owners.get(tabId);
    if (owner === undefined) {
      this.owners.set(tabId, { current: processKey, retired: new Set<string>() });
      return true;
    }
    if (owner.current === processKey) return true;
    if (owner.retired.has(processKey)) return false;
    owner.retired.add(owner.current);
    owner.current = processKey;
    return true;
  }

  private clear(tabId: string): void {
    let had = this.latest.delete(tabId);
    had = this.owners.delete(tabId) || had;
    had = (this.options.onClear?.(tabId) ?? false) || had;
    if (had) void this.options.broadcast();
  }
}
