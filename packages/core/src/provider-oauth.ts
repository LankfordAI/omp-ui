import { runOmpOnce, type RunOmpOnceOptions } from "./omp-process";
import { OAUTH_PROVIDER_SPECS, oauthSpecById } from "./provider-catalog";
import { RpcClient, type RpcSpawnFn } from "./rpc/client";
import type { RpcFrame } from "./rpc/codec";
import type { ProviderOAuthState, ProviderOAuthStatus } from "./types";

export type OmpOnceRunner = (opts: RunOmpOnceOptions) => Promise<string | null>;

const LIST_TIMEOUT_MS = 10_000;
const LOGOUT_TIMEOUT_MS = 10_000;
/** omp's own rpc login handler gives the human 600 s per prompt; the whole flow gets the same. */
export const OAUTH_FLOW_TIMEOUT_MS = 600_000;

export const IDLE_PROVIDER_OAUTH_STATE: ProviderOAuthState = {
  providerId: null, phase: "idle", url: null, instructions: null, prompt: null, error: null,
};

/** `omp token <id> --list` prints `N. identity` per account; anything else is ignored. */
export function parseOAuthAccountList(stdout: string): string[] {
  const accounts: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\d+\. (.+)$/.exec(line.trim());
    if (m) accounts.push(m[1]!);
  }
  return accounts;
}

export interface ProviderOAuthDeps {
  getOmpPath: () => string | null;
  /** Scratch dir used as both --cwd and --session-dir for the bare child; created on demand. */
  scratchDir: string;
  send: (state: ProviderOAuthState) => void;
  /** Host-side browser launch for the open_url frame (desktop: openExternalSafe). */
  onOpenUrl?: (url: string) => void;
  run?: OmpOnceRunner;
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
 * Subscription (OAuth) sign-ins, owned by MainBackend. Two responsibilities:
 * a cached account list per catalogued provider (read through `omp token
 * --list`, so no token ever reaches this process), and the one app-wide
 * sign-in flow, which drives omp's rpc `login` command in a bare rpc-ui child.
 */
export class ProviderOAuth {
  /** One entry per catalogued provider id, refreshed in place (static keys, so a Record, not a Map). */
  #accounts: Record<string, string[]> = {};
  #state: ProviderOAuthState = IDLE_PROVIDER_OAUTH_STATE;
  #flow: ActiveFlow | null = null;

  constructor(private readonly deps: ProviderOAuthDeps) {}

  get state(): ProviderOAuthState { return this.#state; }

  statuses(): ProviderOAuthStatus[] {
    return OAUTH_PROVIDER_SPECS.map((spec) => ({
      id: spec.id, providerId: spec.providerId, label: spec.label, hint: spec.hint,
      accounts: this.#accounts[spec.providerId] ?? [],
    }));
  }

  /** Any catalogued subscription with at least one account — counts as a model provider for the spawn gate. */
  hasModelAccount(): boolean {
    return this.statuses().some((s) => s.accounts.length > 0);
  }

  /** Re-reads every catalogued provider's account list. A missing omp or a failing command reads as "no accounts". */
  async refresh(): Promise<ProviderOAuthStatus[]> {
    const ompPath = this.deps.getOmpPath();
    const run = this.deps.run ?? runOmpOnce;
    for (const spec of OAUTH_PROVIDER_SPECS) {
      const out = ompPath === null
        ? null
        : await run({ ompPath, argv: ["token", spec.providerId, "--list"], timeout: LIST_TIMEOUT_MS });
      this.#accounts[spec.providerId] = out === null ? [] : parseOAuthAccountList(out);
    }
    return this.statuses();
  }

  start(id: string): void {
    const spec = oauthSpecById(id);
    if (spec === undefined) throw new Error(`unknown subscription provider: ${id}`);
    if (this.#flow !== null) throw new Error("a subscription sign-in is already in progress");
    const ompPath = this.deps.getOmpPath();
    if (ompPath === null) throw new Error("omp binary not found");
    const flow: ActiveFlow = { providerId: spec.providerId, rpc: undefined as never, timer: undefined as never, pendingInputId: null, settled: false };
    this.#flow = flow;
    this.#publish({ ...IDLE_PROVIDER_OAUTH_STATE, providerId: spec.providerId, phase: "starting" });
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
    const flow = this.#flow;
    if (flow !== null) {
      if (flow.pendingInputId !== null) {
        flow.rpc.send({ type: "extension_ui_response", id: flow.pendingInputId, cancelled: true });
      }
      this.#settle(flow);
    }
    this.#publish(IDLE_PROVIDER_OAUTH_STATE);
  }

  async signOut(id: string): Promise<ProviderOAuthStatus[]> {
    const spec = oauthSpecById(id);
    if (spec === undefined) throw new Error(`unknown subscription provider: ${id}`);
    if (this.#flow !== null) throw new Error("finish or cancel the sign-in first");
    const ompPath = this.deps.getOmpPath();
    if (ompPath === null) throw new Error("omp binary not found");
    const out = await (this.deps.run ?? runOmpOnce)({
      ompPath, argv: ["auth-broker", "logout", spec.providerId], timeout: LOGOUT_TIMEOUT_MS,
    });
    if (out === null) throw new Error(`omp could not sign out of ${spec.label}`);
    return this.refresh();
  }

  /** App teardown: kill a half-finished child so it cannot outlive omp-ui. */
  dispose(): void {
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
        void this.refresh().then(() => this.#publish({ ...this.#state, phase: "done", prompt: null }));
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
