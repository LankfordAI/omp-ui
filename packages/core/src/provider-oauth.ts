import { logoutCredential, readProviderAccounts } from "./provider-accounts";
import { OAUTH_PROVIDER_SPECS, resolveOAuthProviderSpecs, type OAuthProviderSpec } from "./provider-catalog";
import { RpcClient, type RpcSpawnFn } from "./rpc/client";
import type { RpcFrame } from "./rpc/codec";
import type { ProviderCredential, ProviderOAuthState, ProviderOAuthStatus, ProviderSignOutResult } from "./types";

/** omp's own rpc login handler gives the human 600 s per prompt; the whole flow gets the same. */
export const OAUTH_FLOW_TIMEOUT_MS = 600_000;

export const IDLE_PROVIDER_OAUTH_STATE: ProviderOAuthState = {
  providerId: null, phase: "idle", url: null, instructions: null, prompt: null, error: null,
};

export interface ProviderOAuthDeps {
  getOmpPath: () => string | null;
  /** Scratch dir used as both --cwd and --session-dir for the bare child; created on demand. */
  scratchDir: string;
  send: (state: ProviderOAuthState) => void;
  /** Host-side browser launch for the open_url frame (desktop: openExternalSafe). */
  onOpenUrl?: (url: string) => void;
  spawnProcess?: RpcSpawnFn;
}

interface ActiveFlow {
  providerId: string;
  rpc: RpcClient;
  timer: NodeJS.Timeout;
  pendingInputId: string | null;
  settled: boolean;
}

/**
 * Provider sign-ins, owned by MainBackend. Two responsibilities: a discovered
 * login catalog and the stored credentials behind each row (read with omp's
 * `get_logout_accounts` over one bare rpc child, so no token ever reaches this
 * process), and the one app-wide sign-in flow, which drives omp's rpc `login`
 * command in a bare rpc-ui child. Both account reads and sign-out (`logout`)
 * resolve login aliases, so an alias row shows and removes the canonical
 * credential (issue #779).
 */
export class ProviderOAuth {
  #specs: readonly OAuthProviderSpec[] = OAUTH_PROVIDER_SPECS;
  #accounts = new Map<string, ProviderCredential[]>();
  #accountsUnsupported = false;
  #catalogPath: string | null | undefined;
  #refreshGeneration = 0;
  #refreshFlight: { path: string | null; promise: Promise<ProviderOAuthStatus[]>; abort: AbortController } | null = null;
  #disposed = false;
  #state: ProviderOAuthState = IDLE_PROVIDER_OAUTH_STATE;
  #flow: ActiveFlow | null = null;
  /**
   * Bumped when a flow is installed (after its child is up) and on every
   * cancel(), including a cancel that dismisses a terminal state with no
   * live child: the post-login account refresh outlives #settle, and a
   * completion captured under an older generation must never publish into a
   * newer flow or a dismissed terminal state. A failed start installs no
   * flow and must not bump it, or it would suppress the older flow's
   * legitimate done. A settle alone must not bump it either, or a flow that
   * succeeds and settles mid-refresh would orphan its own done publish.
   */
  #flowGeneration = 0;

  constructor(private readonly deps: ProviderOAuthDeps) {}

  get state(): ProviderOAuthState { return this.#state; }

  statuses(): ProviderOAuthStatus[] {
    return this.#specs.map((spec) => ({
      id: spec.id, providerId: spec.providerId, label: spec.label, hint: spec.hint,
      credentials: this.#accounts.get(spec.providerId) ?? [],
      accountsUnsupported: this.#accountsUnsupported,
    }));
  }

  /** Any stored credential, not discovery's broader authenticated flag, satisfies the existing spawn gate. */
  hasModelAccount(): boolean {
    for (const accounts of this.#accounts.values()) {
      if (accounts.length > 0) return true;
    }
    return false;
  }

  /** Discover available sign-ins and atomically refresh their OAuth identities. */
  async refresh(): Promise<ProviderOAuthStatus[]> {
    this.#assertUsable();
    const ompPath = this.deps.getOmpPath();
    if (this.#refreshFlight?.path === ompPath) return this.#refreshFlight.promise;
    return this.#beginRefresh(ompPath);
  }

  #beginRefresh(ompPath: string | null): Promise<ProviderOAuthStatus[]> {
    this.#assertUsable();
    const generation = ++this.#refreshGeneration;
    this.#refreshFlight?.abort.abort();
    const abort = new AbortController();
    const promise = this.#readSnapshot(ompPath, generation, abort.signal);
    const flight = { path: ompPath, promise, abort };
    this.#refreshFlight = flight;
    const clear = (): void => {
      if (this.#refreshFlight === flight) this.#refreshFlight = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  async #readSnapshot(
    ompPath: string | null,
    generation: number,
    signal: AbortSignal,
  ): Promise<ProviderOAuthStatus[]> {
    const read = await readProviderAccounts({
      ompPath, scratchDir: this.deps.scratchDir,
      spawnProcess: this.deps.spawnProcess, signal,
    });
    if (signal.aborted || generation !== this.#refreshGeneration) return this.statuses();
    if (read === null) {
      // Transport failure: a committed roster stays authoritative for its own
      // binary (issue #721); otherwise answer from the static catalog.
      if (!signal.aborted && generation === this.#refreshGeneration && !this.#disposed &&
          (ompPath === null || this.#catalogPath !== ompPath)) {
        this.#specs = OAUTH_PROVIDER_SPECS;
        this.#accounts = new Map();
        this.#accountsUnsupported = false;
        this.#catalogPath = ompPath;
      }
      return this.statuses();
    }
    const specs = resolveOAuthProviderSpecs(read.providers);
    if (!signal.aborted && generation === this.#refreshGeneration && !this.#disposed) {
      this.#specs = specs;
      this.#accounts = new Map(specs.map((spec) => [
        spec.providerId,
        read.ok ? read.accounts.get(spec.providerId) ?? [] : [],
      ]));
      this.#accountsUnsupported = !read.ok;
      this.#catalogPath = ompPath;
    }
    return this.statuses();
  }

  /** Never share an account snapshot sampled before a credential mutation. */
  async #refreshAfterMutation(): Promise<ProviderOAuthStatus[]> {
    for (;;) {
      while (this.#refreshFlight !== null) {
        await this.#refreshFlight.promise.catch(() => undefined);
        this.#assertUsable();
      }
      const generation = this.#refreshGeneration + 1;
      const rows = await this.#beginRefresh(this.deps.getOmpPath());
      this.#assertUsable();
      // A path switch may supersede this read. Drain its replacement and
      // sample again before returning.
      if (generation === this.#refreshGeneration) return rows;
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("provider sign-ins are disposed");
  }

  start(id: string): void {
    this.#assertUsable();
    const spec = this.#specs.find((entry) => entry.id === id);
    if (spec === undefined) throw new Error(`unknown sign-in provider: ${id}`);
    if (this.#flow !== null) throw new Error("a provider sign-in is already in progress");
    const ompPath = this.deps.getOmpPath();
    if (ompPath === null) throw new Error("omp binary not found");
    // The constructor spawns synchronously (and mkdirs the scratch dir). It
    // runs before the flow is installed, so a thrown spawn leaves #flow null
    // and nothing published: start() stays retryable and cancel() stays safe.
    // Because no flow was installed, it also leaves any older in-flight
    // completion valid.
    const flow: ActiveFlow = { providerId: spec.providerId, rpc: undefined as never, timer: undefined as never, pendingInputId: null, settled: false };
    flow.rpc = new RpcClient({
      cwd: this.deps.scratchDir,
      lineageDir: this.deps.scratchDir,   // RpcClient mkdirs it before spawning
      ompPath,
      bare: true,
      initialCommands: [{ type: "login", providerId: spec.providerId }],
      onFrame: (frame) => this.#onFrame(flow, frame),
      onExit: (code) => this.#fail(flow, `omp exited (${code ?? "signal"}) before the sign-in finished`),
      onError: (msg) => this.#fail(flow, msg),
      spawnProcess: this.deps.spawnProcess,
    });
    this.#flowGeneration++;
    this.#flow = flow;
    this.#publish({ ...IDLE_PROVIDER_OAUTH_STATE, providerId: spec.providerId, phase: "starting" });
    flow.timer = setTimeout(() => this.#fail(flow, "sign-in timed out after 10 minutes"), OAUTH_FLOW_TIMEOUT_MS);
  }

  submitInput(value: string): void {
    const flow = this.#flow;
    if (flow === null || flow.pendingInputId === null) throw new Error("omp is not waiting for input");
    flow.rpc.send({ type: "extension_ui_response", id: flow.pendingInputId, value });
    flow.pendingInputId = null;
    this.#publish({ ...this.#state, phase: "browser", prompt: null });
  }

  /** Aborts an active flow, or dismisses a terminal done/error state. Always ends idle. */
  cancel(): void {
    // Even with no live child: dismisses done/error and invalidates any
    // in-flight post-login completion, so it cannot resurrect the state.
    this.#flowGeneration++;
    const flow = this.#flow;
    if (flow !== null) {
      if (flow.pendingInputId !== null) {
        flow.rpc.send({ type: "extension_ui_response", id: flow.pendingInputId, cancelled: true });
      }
      this.#settle(flow);
    }
    this.#publish(IDLE_PROVIDER_OAUTH_STATE);
  }

  /** Removes one stored credential via omp's rpc `logout`, then refreshes the rows. */
  async signOut(id: string, credentialId: number): Promise<ProviderSignOutResult> {
    this.#assertUsable();
    const spec = this.#specs.find((entry) => entry.id === id);
    if (spec === undefined) throw new Error(`unknown sign-in provider: ${id}`);
    if (this.#flow !== null) throw new Error("finish or cancel the sign-in first");
    const ompPath = this.deps.getOmpPath();
    if (ompPath === null) throw new Error("omp binary not found");
    const remainingSource = await logoutCredential({
      ompPath, providerId: spec.providerId, credentialId,
      scratchDir: this.deps.scratchDir, spawnProcess: this.deps.spawnProcess,
    });
    // The credential is already gone when the refresh fails: report the
    // snapshot main still holds rather than lose the mutation's result.
    const rows: ProviderOAuthStatus[] = await this.#refreshAfterMutation().catch(
      () => this.statuses(),
    );
    return { rows, remainingSource };
  }

  /** App teardown owns discovery as well as the human sign-in flow. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#flowGeneration++;
    this.#refreshGeneration++;
    this.#refreshFlight?.abort.abort();
    if (this.#flow !== null) this.#settle(this.#flow);
  }

  #onFrame(flow: ActiveFlow, frame: RpcFrame): void {
    if (flow.settled || typeof frame !== "object" || frame === null) return;
    const f = frame as Record<string, unknown>;
    if (f.type === "extension_ui_request" && typeof f.id === "string") {
      if (f.method === "open_url") {
        const url = typeof f.url === "string" ? f.url : "";
        if (url === "") {
          flow.rpc.send({ type: "extension_ui_response", id: f.id, cancelled: true });
          this.#fail(flow, "omp sent no sign-in URL");
          return;
        }
        // Reply before publishing: omp's callback wait is its own to time out (same as frame-reduction.ts).
        flow.rpc.send({ type: "extension_ui_response", id: f.id, confirmed: true });
        this.#publish({
          ...this.#state, phase: "browser", url,
          instructions: typeof f.instructions === "string" ? f.instructions : null,
        });
        this.deps.onOpenUrl?.(url);
        return;
      }
      if (f.method === "input") {
        flow.pendingInputId = f.id;
        this.#publish({
          ...this.#state, phase: "input",
          prompt: { title: typeof f.title === "string" ? f.title : "", placeholder: typeof f.placeholder === "string" ? f.placeholder : null },
        });
        return;
      }
      // setWidget/notify/setStatus/…: omp blocks on a reply; decline immediately.
      flow.rpc.send({ type: "extension_ui_response", id: f.id, cancelled: true });
      return;
    }
    if (f.type === "response" && f.command === "login") {
      if (f.success === true) {
        this.#settle(flow);
        // The refresh outlives the settle: a newer start() or a cancel()
        // in that window must not be clobbered by this completion, and a
        // failing read must surface as an error, not a stuck flow.
        const generation = this.#flowGeneration;
        void this.#refreshAfterMutation()
          .then(() => {
            if (this.#flowGeneration === generation) {
              this.#publish({ ...this.#state, phase: "done", prompt: null });
            }
          })
          .catch((err: unknown) => {
            if (this.#flowGeneration !== generation) return;
            const message = err instanceof Error ? err.message : String(err);
            this.#publish({ ...this.#state, phase: "error", prompt: null, error: `sign-in finished, but the account read failed: ${message}` });
          });
      } else {
        this.#fail(flow, typeof f.error === "string" ? f.error : "sign-in failed");
      }
    }
  }

  #fail(flow: ActiveFlow, error: string): void {
    if (flow.settled) return;
    this.#settle(flow);
    this.#publish({ ...this.#state, phase: "error", prompt: null, error });
  }

  #settle(flow: ActiveFlow): void {
    flow.settled = true;
    clearTimeout(flow.timer);
    flow.rpc.kill();
    if (this.#flow === flow) this.#flow = null;
  }

  #publish(state: ProviderOAuthState): void {
    this.#state = state;
    this.deps.send(state);
  }
}
