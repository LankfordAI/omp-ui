import type { RemoteBind, RemoteState } from "@omp-ui/core/types";
import {
  INSTANCE_CLIENT_HEADER,
  mintRemoteToken,
  passwordSessionCredential,
  REMOTE_CLOSE_REVOKED,
  startHostServer,
  tokenMatches,
  withRemoteToken,
  type HostServerHandle,
  type HostServerOptions,
  type HostSurface,
  type UpgradeGrant,
} from "@omp-ui/server";

// Main-process lifecycle for the embedded remote-access server (issue #37), mirroring
// app-update.ts/omp-update.ts: packages/server owns the transport, this class owns the state
// machine the settings page renders and the reconciliation against persisted settings. It is the
// only place that knows the server is embedded rather than standalone — and, since #442, the only
// place that knows what a credential is worth: the server asks `authenticate` on every request.
//
// Deliberately session-blind: it holds no reference to `live`, `spawning`, or `killAll`, so
// flipping a remote setting can never disturb a running session.

export interface RemoteSettings {
  enabled: boolean;
  bind: RemoteBind;
  port: number;
  token: string;
  /** Salted scrypt hash (hex) of the sign-in password; "" = password auth off. */
  passwordHash: string;
  /** Hex salt for passwordHash; "" = password auth off. */
  passwordSalt: string;
}

export interface RemoteServerManagerDeps {
  surface: HostSurface;
  /** Directory holding the built browser bundle; "" in tests, which serves the WS transport only. */
  webRoot: string;
  /** This build's version, answered in every ServerHello. */
  hostVersion: string;
  getSettings: () => RemoteSettings;
  setToken: (token: string) => void;
  send: (state: RemoteState) => void;
}

/**
 * True when both tuples name the same listener. The token is deliberately absent: a rotation
 * changes what `authenticate` accepts, never which socket is bound (see rotateCredential).
 */
function sameTarget(a: RemoteSettings, b: RemoteSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.bind === b.bind &&
    a.port === b.port &&
    a.passwordHash === b.passwordHash &&
    a.passwordSalt === b.passwordSalt
  );
}

const BROWSER_GRANT: UpgradeGrant = { role: "browser", local: false, control: false };
const INSTANCE_GRANT: UpgradeGrant = { role: "instance", local: false, control: false };

export class RemoteServerManager {
  #state: RemoteState;
  #handle: HostServerHandle | null = null;
  /** The tuple `#handle` was started for; null whenever no server runs. */
  #running: RemoteSettings | null = null;
  /**
   * Serializes reconciliation. Two rapid settings changes must not race two listeners onto one
   * port, so every apply/restart/stop queues behind the previous one.
   */
  #chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RemoteServerManagerDeps) {
    this.#state = this.#idle("stopped", null);
  }

  get state(): RemoteState {
    return this.#state;
  }

  /** Every publish is a full RemoteState push — never a partial patch. */
  #publish(next: RemoteState): void {
    this.#state = next;
    this.deps.send(next);
  }

  /** A state with no listener: stopped, starting, or error. Built field by field so passwordHash and passwordSalt can never ride a remote:state push. */
  #idle(status: "stopped" | "starting" | "error", error: string | null): RemoteState {
    const s = this.deps.getSettings();
    return {
      status,
      enabled: s.enabled,
      bind: s.bind,
      port: s.port,
      token: s.token,
      hasPassword: s.passwordHash !== "",
      urls: [],
      tokenUrls: [],
      webBundleMissing: false,
      error,
    };
  }

  /** The listening state for `handle` under the current settings. */
  #listening(handle: HostServerHandle): RemoteState {
    const s = this.deps.getSettings();
    // Primary URLs are bare once a password exists; the token fallback always rides tokenUrls.
    const tokenUrls = withRemoteToken(handle.urls, s.token);
    return {
      status: "listening",
      enabled: s.enabled,
      bind: s.bind,
      port: s.port,
      token: s.token,
      hasPassword: s.passwordHash !== "",
      urls: s.passwordHash !== "" ? handle.urls : tokenUrls,
      tokenUrls,
      webBundleMissing: handle.webBundleMissing,
      error: null,
    };
  }

  /**
   * The one credential policy (issue #442): the current token, or the session credential the
   * current password hash derives, read at call time so a rotation takes effect without a
   * restart. The joined-instance header selects the instance role; everything else is a browser.
   */
  readonly #authenticate: HostServerOptions["authenticate"] = (presented, req) => {
    if (presented === null) return null;
    const s = this.deps.getSettings();
    const accepted =
      tokenMatches(s.token, presented) ||
      (s.passwordHash !== "" && tokenMatches(passwordSessionCredential(s.passwordHash), presented));
    if (!accepted) return null;
    return req.headers[INSTANCE_CLIENT_HEADER] === "instance" ? INSTANCE_GRANT : BROWSER_GRANT;
  };

  /** Reconciles the running server against persisted settings. No-op when nothing changed. */
  apply(): Promise<void> {
    return this.#enqueue(() => this.#reconcile(false));
  }

  /** Stops and restarts even when settings are unchanged. */
  restart(): Promise<void> {
    return this.#enqueue(() => this.#reconcile(true));
  }

  /**
   * A regenerated token: every connected client is dropped with REMOTE_CLOSE_REVOKED and the
   * pairing URLs are republished. The listener stays up — `authenticate` reads the new token on
   * its next call.
   */
  rotateCredential(): Promise<void> {
    return this.#enqueue(async () => {
      const handle = this.#handle;
      if (handle === null) {
        // No listener to evict from; only the token the settings page reveals changes.
        this.#publish({ ...this.#state, token: this.deps.getSettings().token });
        return;
      }
      handle.closeConnections(() => true, REMOTE_CLOSE_REVOKED, "credential rotated");
      this.#publish(this.#listening(handle));
    });
  }

  stop(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#closeRunning();
      this.#publish(this.#idle("stopped", null));
    });
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
      this.#publish(this.#idle("stopped", null));
      return;
    }

    this.#publish(this.#idle("starting", null));
    try {
      // Both must be non-empty: a hash without its salt is a partial/corrupt write, and the
      // safe fallback is token-only mode rather than a crash.
      const password =
        desired.passwordHash !== "" && desired.passwordSalt !== ""
          ? { salt: desired.passwordSalt, hash: desired.passwordHash }
          : null;
      const handle = await startHostServer({
        surface: this.deps.surface,
        bind: desired.bind,
        port: desired.port,
        webRoot: this.deps.webRoot,
        authenticate: this.#authenticate,
        password,
        manifestToken: () => (password ? null : this.deps.getSettings().token),
        hostVersion: this.deps.hostVersion,
        allowImplicitProtocol1: true,
        local: false,
      });
      this.#handle = handle;
      this.#running = desired;
      this.#publish(this.#listening(handle));
    } catch (err) {
      // No server is left running on this path — #closeRunning already ran and the failed
      // startHostServer never handed one back.
      this.#publish(this.#idle("error", err instanceof Error ? err.message : String(err)));
    }
  }
}
