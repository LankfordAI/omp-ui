import type { RemoteBind, RemoteState } from "@omp-ui/core/types";
import {
  mintRemoteToken,
  startRemoteServer,
  type RemoteHost,
  type RemoteServerHandle,
} from "@omp-ui/server";

// Main-process lifecycle for the embedded remote-access server (issue #37), mirroring
// app-update.ts/omp-update.ts: packages/server owns the transport, this class owns the state
// machine the settings page renders and the reconciliation against persisted settings. It is the
// only place that knows the server is embedded rather than standalone.
//
// Deliberately session-blind: it holds no reference to `live`, `spawning`, or `killAll`, so
// flipping a remote setting can never disturb a running session.

export interface RemoteSettings {
  enabled: boolean;
  bind: RemoteBind;
  port: number;
  token: string;
}

export interface RemoteServerManagerDeps {
  host: RemoteHost;
  /** Directory holding the built browser bundle; "" in tests, which serves the WS transport only. */
  webRoot: string;
  getSettings: () => RemoteSettings;
  setToken: (token: string) => void;
  send: (state: RemoteState) => void;
}

/** True when both tuples name the same listener. */
function sameTarget(a: RemoteSettings, b: RemoteSettings): boolean {
  return a.enabled === b.enabled && a.bind === b.bind && a.port === b.port && a.token === b.token;
}

export class RemoteServerManager {
  #state: RemoteState;
  #handle: RemoteServerHandle | null = null;
  /** The tuple `#handle` was started for; null whenever no server runs. */
  #running: RemoteSettings | null = null;
  /**
   * Serializes reconciliation. Two rapid settings changes must not race two listeners onto one
   * port, so every apply/restart/stop queues behind the previous one.
   */
  #chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RemoteServerManagerDeps) {
    const s = deps.getSettings();
    this.#state = {
      status: "stopped",
      enabled: s.enabled,
      bind: s.bind,
      port: s.port,
      token: s.token,
      urls: [],
      webBundleMissing: false,
      error: null,
    };
  }

  get state(): RemoteState {
    return this.#state;
  }

  /** Every publish is a full RemoteState push — never a partial patch. */
  #publish(next: RemoteState): void {
    this.#state = next;
    this.deps.send(next);
  }

  /** Reconciles the running server against persisted settings. No-op when nothing changed. */
  apply(): Promise<void> {
    return this.#queue(false);
  }

  /** Stops and restarts even when settings are unchanged (token regeneration). */
  restart(): Promise<void> {
    return this.#queue(true);
  }

  stop(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#closeRunning();
      const s = this.deps.getSettings();
      this.#publish({
        status: "stopped",
        enabled: s.enabled,
        bind: s.bind,
        port: s.port,
        token: s.token,
        urls: [],
        webBundleMissing: false,
        error: null,
      });
    });
  }

  #queue(force: boolean): Promise<void> {
    return this.#enqueue(() => this.#reconcile(force));
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    // A rejection inside `work` must not poison the chain for the next caller, so the chain
    // itself swallows while the returned promise still reports.
    const run = this.#chain.then(work);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #closeRunning(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    this.#running = null;
    if (handle) await handle.close();
  }

  async #reconcile(force: boolean): Promise<void> {
    // A token is minted lazily but eagerly enough that the settings page always has one to show.
    if (this.deps.getSettings().token === "") this.deps.setToken(mintRemoteToken());
    const desired = this.deps.getSettings();

    if (!force && this.#running !== null && sameTarget(this.#running, desired)) return;

    await this.#closeRunning();

    if (!desired.enabled) {
      this.#publish({ ...desired, status: "stopped", urls: [], webBundleMissing: false, error: null });
      return;
    }

    this.#publish({ ...desired, status: "starting", urls: [], webBundleMissing: false, error: null });
    try {
      const handle = await startRemoteServer({
        host: this.deps.host,
        token: desired.token,
        bind: desired.bind,
        port: desired.port,
        webRoot: this.deps.webRoot,
      });
      this.#handle = handle;
      this.#running = desired;
      this.#publish({
        ...desired,
        status: "listening",
        urls: handle.urls,
        webBundleMissing: handle.webBundleMissing,
        error: null,
      });
    } catch (err) {
      // No server is left running on this path — #closeRunning already ran and the failed
      // startRemoteServer never handed one back.
      this.#publish({
        ...desired,
        status: "error",
        urls: [],
        webBundleMissing: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
