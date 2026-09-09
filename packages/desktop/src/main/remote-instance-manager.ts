import { randomUUID } from "node:crypto";
import {
  assertNicknameUnique,
  defaultNickname,
  normalizeInstanceUrl,
  REMOTE_PROXY_CHANNELS,
  REMOTE_TAB_EVENTS,
  validateNickname,
  type BackendState,
  type InstanceIdentity,
  type ProjectGroup,
  type RemoteInstanceInput,
  type RemoteInstancePatch,
  type RemoteInstanceRecord,
  type RemoteInstanceStatus,
  type RemoteInstanceStore,
  type RemoteInstanceSummary,
} from "@omp-ui/core";
import {
  connectInstanceClient,
  InstanceConnectError,
  signInForCredential,
  type InstanceClient,
} from "@omp-ui/server";

// Main-process client side of remote instances (issue #416): one ws client per joined
// omp-ui, the credential held here and never handed to a renderer, the remote's own
// `projects` and favorite model list (issue #440) projected into local state as
// `remoteInstances[i].projects` / `.modelFavorites`, and tab-scoped traffic routed by
// tabId → instance (remote-route.ts). Mirrors RemoteServerManager's shape: packages/server
// owns the transport, this class owns the per-instance state machine the renderer renders.

export interface RemoteInstanceManagerDeps {
  store: RemoteInstanceStore;
  /** This app's own identity; a remote answering with it is `self`. */
  localInstanceId: () => string;
  localVersion: string;
  /** Mirrors a remote tab event into local sinks unchanged (MainBackend.send). */
  send: (channel: string, args: unknown[]) => void;
  /** Rebuilds and fans out BackendState (MainBackend.broadcast). */
  broadcast: () => Promise<void>;
  /** Test seams. */
  connect?: typeof connectInstanceClient;
  signIn?: typeof signInForCredential;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

/** Retry schedule after a lost or refused connection: 1s doubling to a 30s ceiling. */
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;

const CREDENTIAL_UNREADABLE = "stored credential could not be read";
const CREDENTIAL_REJECTED = "credential rejected — sign in again";
const CONNECTION_LOST = "connection lost";
const REMOTE_TOO_OLD = "remote omp-ui is older than this app and cannot be joined";

interface Entry {
  record: RemoteInstanceRecord;
  status: RemoteInstanceStatus;
  error: string | null;
  version: string | null;
  /** Open socket; null while connecting, after a loss, or in a terminal status. */
  client: InstanceClient | null;
  /** The remote's own registry groups, kept dimmed across a loss so tabs stay mounted. */
  projects: ProjectGroup[];
  /** The remote's own favorite model list (issue #440), kept across a loss like projects. */
  modelFavorites: string[];
  tabIds: Set<string>;
  /** Consecutive failed connects since the last join; drives the backoff. */
  attempt: number;
  timer: NodeJS.Timeout | null;
  generation: number;
}

export class RemoteInstanceManager {
  /** Insertion order is store order, which is also the `ownerOf` tie-break order. */
  readonly #entries = new Map<string, Entry>();
  /** Which instance each client last viewed a tab of, so a switch away can clear it there. */
  readonly #lastInstanceByClient = new Map<string, string>();
  /** Tab ids already reported as claimed by two instances; each is warned once. */
  readonly #warnedDuplicates = new Set<string>();
  #stopped = false;

  readonly #connect: typeof connectInstanceClient;
  readonly #signIn: typeof signInForCredential;
  readonly #setTimer: NonNullable<RemoteInstanceManagerDeps["setTimer"]>;
  readonly #clearTimer: NonNullable<RemoteInstanceManagerDeps["clearTimer"]>;

  constructor(private readonly deps: RemoteInstanceManagerDeps) {
    this.#connect = deps.connect ?? connectInstanceClient;
    this.#signIn = deps.signIn ?? signInForCredential;
    this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    for (const record of deps.store.list()) this.#entries.set(record.id, this.#newEntry(record));
  }

  /** Dials every stored record. Called once from index.ts after the embedded server starts. */
  start(): void {
    for (const entry of this.#entries.values()) void this.#dial(entry);
  }

  summaries(): RemoteInstanceSummary[] {
    const out: RemoteInstanceSummary[] = [];
    for (const e of this.#entries.values()) {
      out.push({
        id: e.record.id,
        nickname: e.record.nickname,
        url: e.record.url,
        status: e.status,
        error: e.error,
        version: e.version,
        projects: e.projects,
        modelFavorites: e.modelFavorites,
      });
    }
    return out;
  }

  /**
   * The instance whose registry owns `tabId`, or null for a local tab. A tab of an unreachable
   * instance still resolves to it: the request must fail as "not joined", not as a local
   * unknown tab. Two instances claiming one id resolve to the first joined, else the first.
   */
  ownerOf(tabId: string): string | null {
    let fallback: string | null = null;
    for (const e of this.#entries.values()) {
      if (!e.tabIds.has(tabId)) continue;
      if (e.status === "joined") return e.record.id;
      fallback ??= e.record.id;
    }
    return fallback;
  }

  /** Validates, signs in or adopts the token, stores, connects. Nothing is stored on failure. */
  async add(input: RemoteInstanceInput): Promise<void> {
    const { origin, token } = normalizeInstanceUrl(input.url);
    const nickname =
      input.nickname.trim() === "" ? defaultNickname(origin) : validateNickname(input.nickname);
    assertNicknameUnique(nickname, this.deps.store.list(), null);
    const credential = await this.#credentialFor(origin, token, input.secret);
    const record: RemoteInstanceRecord = {
      id: randomUUID(),
      nickname,
      url: origin,
      addedAt: new Date().toISOString(),
    };
    this.deps.store.add(record, credential);
    const entry = this.#newEntry(record);
    this.#entries.set(record.id, entry);
    await this.#dial(entry);
  }

  /** A nickname change is a rename in place; a url or secret change stores and reconnects. */
  async update(id: string, patch: RemoteInstancePatch): Promise<void> {
    const entry = this.#entry(id);
    const nickname = patch.nickname === undefined ? undefined : validateNickname(patch.nickname);
    if (nickname !== undefined) assertNicknameUnique(nickname, this.deps.store.list(), id);

    const reconnect = patch.url !== undefined || patch.secret !== undefined;
    let url: string | undefined;
    let credential: string | undefined;
    if (reconnect) {
      const { origin, token } = normalizeInstanceUrl(patch.url ?? entry.record.url);
      url = origin;
      if (patch.secret !== undefined) {
        credential = await this.#credentialFor(origin, token, patch.secret);
      } else if (token !== null) {
        credential = token;
      }
    }

    // Every check above passed: one write, then the in-memory record follows the store.
    this.deps.store.update(id, { nickname, url, credential });
    const stored = this.deps.store.list().find((r) => r.id === id);
    if (stored) entry.record = stored;
    if (reconnect) {
      entry.attempt = 0;
      await this.#dial(entry);
    } else {
      this.#set(entry, {});
    }
  }

  /** Disconnects and forgets the record with its credential. Idempotent. */
  async remove(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    this.deps.store.remove(id);
    if (!entry) return;
    this.#cancelTimer(entry);
    this.#detach(entry);
    this.#entries.delete(id);
    this.#forgetViewed(id);
    await this.deps.broadcast();
  }

  /** Resets the backoff and dials now, from any status. */
  async reconnect(id: string): Promise<void> {
    const entry = this.#entry(id);
    entry.attempt = 0;
    await this.#dial(entry);
  }

  /** Forwards one allowlisted request to a joined instance. */
  request(id: string, channel: string, args: unknown[]): Promise<unknown> {
    const entry = this.#entries.get(id);
    if (!entry) return Promise.reject(new Error(`unknown instance ${id}`));
    if (entry.status !== "joined" || entry.client === null) {
      return Promise.reject(new Error(`${entry.record.nickname} is not joined`));
    }
    if (!REMOTE_PROXY_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`channel ${channel} is not proxied`));
    }
    return entry.client.request(channel, args);
  }

  /** Same gate as {@link request}; a notify that fails it is dropped, as notifies always are. */
  notify(id: string, channel: string, args: unknown[]): void {
    if (!REMOTE_PROXY_CHANNELS.has(channel)) return;
    this.#joined(id)?.notify(channel, args);
  }

  /** The open socket of a joined instance, or null. */
  #joined(id: string): InstanceClient | null {
    const entry = this.#entries.get(id);
    return entry !== undefined && entry.status === "joined" ? entry.client : null;
  }

  /**
   * Mirrors a client's viewed-tab report to the owning instance (hibernation bookkeeping,
   * issue #271): the instance it moved away from hears `null`, the one it moved to hears the tab.
   * `tab:viewed` is main's own to forward — it is not on the renderer-facing proxy allowlist.
   */
  forwardViewed(clientId: string, tabId: string | null): void {
    const next = tabId === null ? null : this.ownerOf(tabId);
    const previous = this.#lastInstanceByClient.get(clientId) ?? null;
    if (previous !== null && previous !== next) {
      this.#joined(previous)?.notify("tab:viewed", [clientId, null]);
    }
    if (next !== null) this.#joined(next)?.notify("tab:viewed", [clientId, tabId]);
    if (next === null) this.#lastInstanceByClient.delete(clientId);
    else this.#lastInstanceByClient.set(clientId, next);
  }

  /** Closes every socket and cancels every retry; nothing reconnects afterwards. */
  stop(): void {
    this.#stopped = true;
    for (const entry of this.#entries.values()) {
      this.#cancelTimer(entry);
      this.#detach(entry);
    }
  }

  #newEntry(record: RemoteInstanceRecord): Entry {
    return {
      record,
      status: "connecting",
      error: null,
      version: null,
      client: null,
      projects: [],
      modelFavorites: [],
      tabIds: new Set(),
      attempt: 0,
      timer: null,
      generation: 0,
    };
  }

  #entry(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`unknown instance ${id}`);
    return entry;
  }

  /**
   * The credential to store: the token itself, the `?t=` from a pasted token URL when the
   * secret field was left empty, or the session credential the remote's /login hands back.
   */
  async #credentialFor(
    origin: string,
    urlToken: string | null,
    secret: RemoteInstanceInput["secret"],
  ): Promise<string> {
    const value = secret.value.trim();
    if (value === "") {
      if (urlToken !== null) return urlToken;
      throw new Error(secret.kind === "token" ? "access token is empty" : "password is empty");
    }
    return secret.kind === "token" ? value : this.#signIn(origin, value);
  }

  /** Every status change goes through here so the renderer never misses one. */
  #set(
    entry: Entry,
    patch: Partial<Pick<Entry, "status" | "error" | "version">>,
  ): void {
    Object.assign(entry, patch);
    void this.deps.broadcast().catch((err: unknown) => {
      console.warn(
        `[remote-instances] broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  #cancelTimer(entry: Entry): void {
    if (entry.timer === null) return;
    this.#clearTimer(entry.timer);
    entry.timer = null;
  }

  /** Drops the socket without treating its close as a loss: the close callback checks identity. */
  #detach(entry: Entry): void {
    const client = entry.client;
    entry.client = null;
    client?.close();
  }

  #forgetViewed(instanceId: string): void {
    for (const [clientId, id] of this.#lastInstanceByClient) {
      if (id === instanceId) this.#lastInstanceByClient.delete(clientId);
    }
  }

  /** True while this attempt is still the one the entry is waiting on. */
  #current(entry: Entry, generation: number): boolean {
    return (
      !this.#stopped &&
      this.#entries.get(entry.record.id) === entry &&
      entry.generation === generation
    );
  }

  /** One connect attempt end to end; resolves once the entry has settled on a status. Never throws. */
  async #dial(entry: Entry): Promise<void> {
    const generation = ++entry.generation;
    this.#cancelTimer(entry);
    this.#detach(entry);
    this.#set(entry, { status: "connecting", error: null });

    const credential = this.deps.store.credential(entry.record.id);
    if (credential === null) {
      this.#set(entry, { status: "needs-sign-in", error: CREDENTIAL_UNREADABLE });
      return;
    }

    let client: InstanceClient;
    try {
      client = await this.#connect(entry.record.url, credential);
    } catch (err) {
      if (!this.#current(entry, generation)) return;
      if (err instanceof InstanceConnectError && err.failure.kind === "unauthorized") {
        this.#set(entry, { status: "needs-sign-in", error: CREDENTIAL_REJECTED });
        return;
      }
      this.#lost(entry, err instanceof Error ? err.message : String(err));
      return;
    }
    if (!this.#current(entry, generation)) {
      client.close();
      return;
    }

    entry.client = client;
    client.onEvent((channel, args) => {
      if (entry.client === client) this.#onEvent(entry, channel, args);
    });
    client.onClose(() => {
      if (entry.client !== client) return;
      entry.client = null;
      this.#lost(entry, CONNECTION_LOST);
    });

    let identity: InstanceIdentity;
    try {
      identity = await client.request<InstanceIdentity>("instance:identity", []);
    } catch (err) {
      // A close mid-handshake rejects the request and then fires onClose, which owns that path.
      if (entry.client !== client) return;
      const message = err instanceof Error ? err.message : String(err);
      this.#detach(entry);
      if (message.startsWith("unknown channel")) {
        this.#set(entry, { status: "incompatible", error: REMOTE_TOO_OLD });
      } else {
        this.#lost(entry, message);
      }
      return;
    }
    if (entry.client !== client) return;
    if (identity.instanceId === this.deps.localInstanceId()) {
      this.#detach(entry);
      this.#set(entry, { status: "self", error: null, version: identity.version });
      return;
    }

    let state: BackendState;
    try {
      state = await client.request<BackendState>("state:get", []);
    } catch (err) {
      if (entry.client !== client) return;
      this.#detach(entry);
      this.#lost(entry, err instanceof Error ? err.message : String(err));
      return;
    }
    // Owner-state projection (issue #440): only the remote's own registry projects
    // and favorite model list fold in — its `remoteInstances` and every other
    // app-scoped field (settings, providers) never do, so a mutual join (A↔B)
    // is two directed edges and never a loop.
    this.#adopt(entry, state.projects);
    entry.modelFavorites = this.#favorites(state.modelFavorites);
    entry.attempt = 0;
    this.#set(entry, { status: "joined", error: null, version: identity.version });
  }

  #onEvent(entry: Entry, channel: string, args: unknown[]): void {
    if (channel === "state:changed") {
      // Each field of the remote's owner state lands independently (issue #440):
      // a valid projects array rebuilds tab ownership, a valid favorites array
      // only swaps the list. A missing or malformed later field never erases
      // the last good value; an event carrying neither is ignored.
      const partial = args[0] as Partial<BackendState> | undefined;
      const projects = partial?.projects;
      const favorites = partial?.modelFavorites;
      const hasProjects = Array.isArray(projects);
      const hasFavorites = Array.isArray(favorites);
      if (hasProjects) this.#adopt(entry, projects as ProjectGroup[]);
      if (hasFavorites) entry.modelFavorites = this.#favorites(favorites);
      if (hasProjects || hasFavorites) this.#set(entry, {});
      return;
    }
    if (REMOTE_TAB_EVENTS.has(channel)) this.deps.send(channel, args);
    // App-scoped events (updates, remote-access state, provider flows) describe the remote
    // app, not ours, and are dropped.
  }

  /**
   * Sanitizes the remote's favorite model list (issue #440): only string
   * entries survive, and anything that is not an array at all yields [].
   */
  #favorites(raw: unknown): string[] {
    return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string") : [];
  }

  #adopt(entry: Entry, projects: ProjectGroup[]): void {
    entry.projects = projects;
    const tabIds = new Set<string>();
    for (const group of projects) for (const session of group.sessions) tabIds.add(session.tabId);
    entry.tabIds = tabIds;
    for (const tabId of tabIds) {
      if (this.#warnedDuplicates.has(tabId)) continue;
      for (const other of this.#entries.values()) {
        if (other === entry || !other.tabIds.has(tabId)) continue;
        this.#warnedDuplicates.add(tabId);
        console.warn(
          `[remote-instances] tab ${tabId} is claimed by both "${other.record.nickname}" and ` +
            `"${entry.record.nickname}"; routing it to whichever is joined first`,
        );
        break;
      }
    }
  }

  /** Connection refused or lost: projects stay so tabs remain mounted; a capped backoff retries. */
  #lost(entry: Entry, message: string): void {
    this.#forgetViewed(entry.record.id);
    this.#set(entry, { status: "unreachable", error: message });
    if (this.#stopped) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** entry.attempt, RETRY_CAP_MS);
    entry.attempt += 1;
    entry.timer = this.#setTimer(() => {
      entry.timer = null;
      void this.#dial(entry);
    }, delay);
  }
}
