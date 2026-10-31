import type { RemoteBind, RemoteState } from "@omp-ui/core";
import {
  mintRemoteToken,
  startRemoteServer,
  type RemoteHost,
  type RemoteServerHandle,
} from "@omp-ui/server";

/**
 * The lite member's remote listener lifecycle (issue #1010): packages/server
 * owns the transport, this class owns the reconciliation against the member's
 * persisted settings. A direct port of desktop's RemoteServerManager minus the
 * Electron-only extras (breadcrumbs, the browser-pane port guard) and minus the
 * webhook/MCP intakes a headless fleet member does not host.
 */

export interface LiteRemoteSettings {
  enabled: boolean;
  bind: RemoteBind;
  port: number;
  token: string;
  /** Salted scrypt hash (hex) of the sign-in password; "" = password auth off. */
  passwordHash: string;
  /** Hex salt for passwordHash; "" = password auth off. */
  passwordSalt: string;
}

export interface LiteRemoteServerDeps {
  host: RemoteHost;
  /** Directory holding a built browser bundle; "" serves the WS transport only. */
  webRoot: string;
  getSettings: () => LiteRemoteSettings;
  setToken: (token: string) => void;
  /** Publishes every full-state change; `remote:state` to joined owners. */
  send: (state: RemoteState) => void;
  /** The member version the transport reports. */
  version?: string;
}

/** True when both tuples name the same listener. */
function sameTarget(a: LiteRemoteSettings, b: LiteRemoteSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.bind === b.bind &&
    a.port === b.port &&
    a.token === b.token &&
    a.passwordHash === b.passwordHash &&
    a.passwordSalt === b.passwordSalt
  );
}

export class LiteRemoteServer {
  #state: RemoteState;
  #handle: RemoteServerHandle | null = null;
  /** The tuple `#handle` was started for; null whenever no server runs. */
  #running: LiteRemoteSettings | null = null;
  /** Serializes reconciliation so two rapid settings changes never race two listeners onto one port. */
  #chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LiteRemoteServerDeps) {
    const s = deps.getSettings();
    this.#state = this.#snapshot(s, "stopped", [], [], false, null);
  }

  get state(): RemoteState {
    return this.#state;
  }

  /** Reconciles the running listener with persisted settings; no-op when the target is unchanged. */
  apply(): Promise<void> {
    return this.#queue(false);
  }

  /** Stops and restarts even when settings are unchanged (token rotation). */
  restart(): Promise<void> {
    return this.#queue(true);
  }

  stop(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#closeRunning();
      this.#publish(this.#snapshot(this.deps.getSettings(), "stopped", [], [], false, null));
    });
  }

  #queue(force: boolean): Promise<void> {
    return this.#enqueue(() => this.#reconcile(force));
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    // A rejection inside `work` must not poison the chain for later callers,
    // while the returned promise still reports it.
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
    // A token is minted lazily but always before a listener could start, so
    // `status` and the settings pairings never see an empty credential.
    if (this.deps.getSettings().token === "") this.deps.setToken(mintRemoteToken());
    const desired = this.deps.getSettings();

    if (!force && this.#running !== null && sameTarget(this.#running, desired)) return;

    await this.#closeRunning();

    if (!desired.enabled) {
      this.#publish(this.#snapshot(desired, "stopped", [], [], false, null));
      return;
    }

    this.#publish(this.#snapshot(desired, "starting", [], [], false, null));
    try {
      // Both must be non-empty: a hash without its salt is a partial write;
      // the safe fallback is token-only mode.
      const password =
        desired.passwordHash !== "" && desired.passwordSalt !== ""
          ? { salt: desired.passwordSalt, hash: desired.passwordHash }
          : null;
      const handle = await startRemoteServer({
        host: this.deps.host,
        token: desired.token,
        bind: desired.bind,
        port: desired.port,
        webRoot: this.deps.webRoot,
        password,
        version: this.deps.version,
      });
      this.#handle = handle;
      this.#running = desired;
      this.#publish(
        // Primary URLs are bare once a password exists; the token fallback always rides
        // tokenUrls. Field by field — never spread desired — so passwordHash/passwordSalt
        // can never ride a remote:state push.
        this.#snapshot(
          desired,
          "listening",
          desired.passwordHash !== "" ? handle.urls : handle.tokenUrls,
          handle.tokenUrls,
          handle.webBundleMissing,
          null,
          handle.port,
        ),
      );
    } catch (err) {
      // #closeRunning already ran and the failed start never handed one back: no listener remains.
      this.#publish(
        this.#snapshot(desired, "error", [], [], false, err instanceof Error ? err.message : String(err)),
      );
    }
  }

  #snapshot(
    s: LiteRemoteSettings,
    status: RemoteState["status"],
    urls: string[],
    tokenUrls: string[],
    webBundleMissing: boolean,
    error: string | null,
    livePort?: number,
  ): RemoteState {
    return {
      status,
      enabled: s.enabled,
      bind: s.bind,
      port: livePort ?? s.port,
      token: s.token,
      hasPassword: s.passwordHash !== "",
      urls,
      tokenUrls,
      webBundleMissing,
      error,
    };
  }

  #publish(next: RemoteState): void {
    this.#state = next;
    this.deps.send(next);
  }
}
