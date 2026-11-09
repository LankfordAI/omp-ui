import { randomUUID } from "node:crypto";
import { setHostToolsCommand, type HostToolOptions } from "@omp-ui/core/host-bridge";
import { normalizeControlFrame, type RpcFrame } from "@omp-ui/core";
import type { RpcLiveEntry } from "./live-entry";

interface Registration {
  entry: RpcLiveEntry;
  desiredEpoch: number;
  desiredEnabled: boolean;
  pending: { id: string; epoch: number; enabled: boolean; timer: NodeJS.Timeout } | null;
  waiters: Array<() => void>;
  queued: boolean;
}

/** Correlates control replies with the owning process, never the tab's successor. */
export class ArtifactHostTools {
  private epoch = 0;
  private readonly entries = new Map<RpcLiveEntry, Registration>();

  constructor(private readonly deps: {
    enabled: () => boolean;
    current: (tabId: string) => RpcLiveEntry | null;
    error: (tabId: string, message: string) => void;
  }) {}

  get currentEpoch(): number { return this.epoch; }

  initial(entry: RpcLiveEntry, options: HostToolOptions): object {
    this.forget(entry);
    entry.hostToolOptions = { ...options };
    const registration: Registration = {
      entry, desiredEpoch: this.epoch, desiredEnabled: options.artifacts,
      pending: null, waiters: [], queued: false,
    };
    this.entries.set(entry, registration);
    return this.command(registration);
  }

  /** Called only on the protocol ready rail; no hot command can precede it. */
  ready(entry: RpcLiveEntry): void {
    entry.hostToolsReady = true;
    const registration = this.entries.get(entry);
    if (registration !== undefined) this.schedule(registration);
  }

  sync(enabled: boolean): Promise<void> {
    this.epoch++;
    const pending: Promise<void>[] = [];
    for (const registration of this.entries.values()) {
      registration.desiredEpoch = this.epoch;
      registration.desiredEnabled = enabled;
      registration.entry.artifactAuthoringError = enabled ? "Artifact tool registration is pending" : null;
      const { promise, resolve } = Promise.withResolvers<void>();
      registration.waiters.push(resolve);
      pending.push(promise);
      this.schedule(registration);
    }
    return Promise.allSettled(pending).then(() => undefined);
  }

  observe(entry: RpcLiveEntry, frame: RpcFrame): void {
    const registration = this.entries.get(entry);
    const control = normalizeControlFrame(frame);
    if (registration === undefined || control?.kind !== "response") return;
    const pending = registration.pending;
    if (pending === null || pending.id !== control.id) return;
    clearTimeout(pending.timer);
    registration.pending = null;
    if (this.deps.current(entry.record.tabId) !== entry) { this.forget(entry); return; }
    if (pending.epoch === registration.desiredEpoch && pending.enabled === registration.desiredEnabled) {
      entry.artifactHostToolsEpoch = pending.epoch;
      entry.artifactAuthoringError = control.success === true ? null :
        (typeof control.error === "string" ? control.error : "OMP rejected artifact tool registration");
      if (control.success !== true) this.deps.error(entry.record.tabId, entry.artifactAuthoringError!);
      this.settle(registration);
    }
    this.schedule(registration);
  }

  private command(registration: Registration): object {
    const { entry } = registration;
    const options = { ...entry.hostToolOptions!, artifacts: registration.desiredEnabled };
    entry.hostToolOptions = options;
    entry.artifactAuthoringError = options.artifacts ? "Artifact tool registration is pending" : null;
    const id = `omp-ui-artifact-tools-${randomUUID()}`;
    const pending = {
      id, epoch: registration.desiredEpoch, enabled: options.artifacts,
      timer: setTimeout(() => {
        if (registration.pending !== pending) return;
        registration.pending = null;
        if (this.deps.current(entry.record.tabId) !== entry) { this.forget(entry); return; }
        if (pending.epoch === registration.desiredEpoch) {
          entry.artifactHostToolsEpoch = pending.epoch;
          entry.artifactAuthoringError = "OMP artifact tool registration timed out after 30 seconds";
          this.deps.error(entry.record.tabId, entry.artifactAuthoringError);
          this.settle(registration);
        }
        this.schedule(registration);
      }, 30_000),
    };
    pending.timer.unref?.();
    registration.pending = pending;
    return setHostToolsCommand(options, id);
  }

  private schedule(registration: Registration): void {
    if (registration.queued || registration.pending !== null || !registration.entry.hostToolsReady) return;
    const { entry } = registration;
    if (entry.artifactHostToolsEpoch === registration.desiredEpoch) { this.settle(registration); return; }
    registration.queued = true;
    queueMicrotask(() => {
      registration.queued = false;
      if (this.entries.get(entry) !== registration || registration.pending !== null) return;
      if (this.deps.current(entry.record.tabId) !== entry || entry.rpc === null) { this.forget(entry); return; }
      // Read current desire after coalescing all flips in this turn.
      registration.desiredEnabled = this.deps.enabled();
      try { entry.rpc.send(this.command(registration)); }
      catch (error) {
        this.cancelPending(registration);
        entry.artifactHostToolsEpoch = registration.desiredEpoch;
        entry.artifactAuthoringError = String(error);
        this.deps.error(entry.record.tabId, entry.artifactAuthoringError);
        this.settle(registration);
      }
    });
  }
  private cancelPending(registration: Registration): void {
    if (registration.pending !== null) clearTimeout(registration.pending.timer);
    registration.pending = null;
  }


  private settle(registration: Registration): void {
    for (const resolve of registration.waiters.splice(0)) resolve();
  }

  forget(entry: RpcLiveEntry): void {
    const registration = this.entries.get(entry);
    if (registration === undefined) return;
    if (registration.pending !== null) clearTimeout(registration.pending.timer);
    this.entries.delete(entry);
    this.settle(registration);
  }

  close(): void { for (const entry of this.entries.keys()) this.forget(entry); }
}
