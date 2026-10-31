import {
  CH,
  type BackendState,
  type ChannelTable,
  type ProjectGroup,
  type Registry,
  type RegistrySettings,
  type RemoteBind,
  type RemoteState,
  type SessionSummary,
} from "@omp-ui/core";
import {
  hashRemotePassword,
  mintRemoteToken,
  validateRemotePassword,
  type RemoteHost,
} from "@omp-ui/server";
import type { LiteSessions } from "./seams";

/**
 * The headless `lite` fleet member's RemoteHost (issue #1010): the ChannelTable
 * a joined owner talks to, built as the union of exactly three slices —
 *
 *  a. remote-access settings against this member's own Registry (the
 *     desktop's remote-handlers.ts glue, minus breadcrumbs);
 *  b. `instance:identity` with the member's stable id and version;
 *  c. `state:get`, merging LiteSessions.state() with the registry's own
 *     project grouping and modelFavorites exactly as MainBackend.buildState
 *     does — registry order, chats never in a group, favorites from the
 *     registry rather than whatever the sessions seam reported.
 *
 * Everything else the desktop table answers (sessions, providers, vaults,
 * updates, …) is ABSENT from the table, never stubbed with an error: the
 * transport's own `unknown channel …` rejection is what a joiner sees, which
 * is the same contract the desktop gives an older client.
 */

/** The live remote-access listener, owned by serve.ts; mirrors RemoteServerManager's surface. */
export interface RemoteController {
  readonly state: RemoteState;
  /** Reconcile the listener with persisted settings (no-op when the target is unchanged). */
  apply(): Promise<void>;
  /** Stop and start even when settings are unchanged (token rotation). */
  restart(): Promise<void>;
}

export interface LiteBackendDeps {
  registry: Registry;
  sessions: LiteSessions;
  /** Stable join identity (issue #416): what a joiner compares against its own to detect `self`. */
  instanceId: string;
  /** The member's omp-ui version, reported as identity.version. */
  version: string;
  remote: RemoteController;
}

type Sink = (channel: string, args: unknown[]) => void;

/** The settings subset BackendState broadcasts — remote credential and seed-marker keys excluded. */
type BroadcastSettings = Omit<
  RegistrySettings,
  | "memoryDefaultsSeeded"
  | "autoThinkingDefaultSeeded"
  | "hibernateManualDefaultSeeded"
  | "remoteEnabled"
  | "remoteBind"
  | "remotePort"
  | "remoteToken"
  | "remotePasswordHash"
  | "remotePasswordSalt"
  | "instanceId"
  | "reviewRoster"
  | "reviewRosterImported"
  | "chatLastModel"
  | "chatLastThinkingLevel"
  | "webhooksEnabled"
  | "mcpEndpointEnabled"
>;

/** Registry settings minus the omit list — what `state:get` and `state:changed` may carry. */
export function broadcastSettings(registry: Registry): BroadcastSettings {
  const snapshot = registry.settingsSnapshot();
  // Destructure-away, mirroring the type-level Omit at runtime: the token and
  // password hash must never ride a broadcast or a `state:get` answer.
  const {
    memoryDefaultsSeeded: _m1,
    autoThinkingDefaultSeeded: _m2,
    hibernateManualDefaultSeeded: _m3,
    remoteEnabled: _e,
    remoteBind: _b,
    remotePort: _p,
    remoteToken: _t,
    remotePasswordHash: _ph,
    remotePasswordSalt: _ps,
    instanceId: _id,
    reviewRoster: _rr,
    reviewRosterImported: _ri,
    chatLastModel: _cm,
    chatLastThinkingLevel: _cl,
    webhooksEnabled: _w,
    mcpEndpointEnabled: _mcp,
    ...broadcast
  } = snapshot;
  return broadcast;
}

export class LiteBackend implements RemoteHost {
  readonly #sinks = new Set<Sink>();
  readonly #table: ChannelTable;
  /** Serializes merged state:changed broadcasts so a slow seam can't interleave two. */
  #stateChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LiteBackendDeps) {
    // One sessions subscription for the backend's whole life. `state:changed`
    // is re-anchored through the same registry merge as `state:get` — joined
    // owners get the identical full BackendState the desktop broadcasts, never
    // the seam's unmerged view; every other channel rides out verbatim.
    // The unsubscribe is dead by construction once close() drops the backend.
    deps.sessions.on((channel, args) => {
      if (channel !== CH.onStateChanged) {
        this.emit(channel, args);
        return;
      }
      const broadcast = this.#stateChain.then(async () => {
        this.emit(channel, [await this.state()]);
      });
      this.#stateChain = broadcast.catch(() => {});
      void broadcast.catch((err: unknown) => {
        console.warn(`[host-lite] state:changed broadcast failed: ${String(err)}`);
      });
    });
    this.#table = this.#buildTable();
  }

  handlers(): ChannelTable {
    return this.#table;
  }

  addSink(sink: Sink): () => void {
    this.#sinks.add(sink);
    return () => this.#sinks.delete(sink);
  }

  /** Fan one host event out to every sink (the per-server transport fan-out). */
  emit(channel: string, args: unknown[]): void {
    for (const sink of this.#sinks) sink(channel, args);
  }

  /** The merged owner-facing BackendState: sessions rows over registry membership. */
  async state(): Promise<BackendState> {
    const base = await this.deps.sessions.state();
    return mergeRegistryState(this.deps.registry, base);
  }

  #buildTable(): ChannelTable {
    const { registry, remote } = this.deps;
    // Sessions channels first, core channels after: the core's `state:get`,
    // `instance:identity` and `remote:*` always win over a seam that tries to
    // shadow them (see seams.ts).
    const request = {
      ...this.deps.sessions.handlers,
      [CH.getState]: () => this.state(),
      [CH.getInstanceIdentity]: () => ({
        instanceId: this.deps.instanceId,
        version: this.deps.version,
      }),
      // Remote-access settings (packages/desktop/src/main/remote-handlers.ts,
      // ported without the breadcrumb sink — a lite member has no Electron log).
      [CH.getRemoteState]: () => remote.state,
      [CH.setRemoteEnabled]: async (on: boolean) => {
        registry.setSetting("remoteEnabled", on);
        await remote.apply();
      },
      [CH.setRemoteBind]: async (bind: RemoteBind) => {
        registry.setSetting("remoteBind", bind);
        await remote.apply();
      },
      [CH.setRemotePort]: async (port: number) => {
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new Error("port must be a whole number between 1024 and 65535");
        }
        registry.setSetting("remotePort", port);
        await remote.apply();
      },
      [CH.regenerateRemoteToken]: async () => {
        registry.setSetting("remoteToken", mintRemoteToken());
        await remote.restart();
      },
      [CH.setRemotePassword]: async (password: string) => {
        const problem = validateRemotePassword(password);
        if (problem !== null) throw new Error(problem);
        const { salt, hash } = hashRemotePassword(password);
        registry.setSettings({ remotePasswordHash: hash, remotePasswordSalt: salt });
        await remote.apply();
      },
      [CH.clearRemotePassword]: async () => {
        registry.setSettings({ remotePasswordHash: "", remotePasswordSalt: "" });
        await remote.apply();
      },
    };
    // The spread union cannot name every RequestHandlers key; the channel keys
    // this table installs are exactly the CH entries above plus S2's seam.
    return {
      request: request as ChannelTable["request"],
      // Notify channels belong to S2's LiteSessions when it lands. Until then an
      // empty table is the honest runtime shape — dispatchNotify ignores unknown
      // channels — the full-keys type simply cannot express "none are wired yet".
      notify: {} as ChannelTable["notify"],
    };
  }
}

/**
 * Registry-membership merge, mirroring MainBackend.buildState: groups follow
 * `registry.projects` order; within a group sessions follow registry record
 * order (non-chat only); summaries come from LiteSessions.state() keyed by
 * tabId — the merge never invents a summary S2 did not report. Chats pass
 * through untouched (host-local, ADR-0059). The registry's own settings are
 * law over whatever the seam returned (desktop builds every field from the
 * registry), and the credential/omitted keys are stripped from the seam's
 * object at runtime too: S2 is a separate slice, and `remoteToken` must never
 * ride a broadcast even in a misbehaving payload.
 */
export function mergeRegistryState(registry: Registry, base: BackendState): BackendState {
  const rows = new Map<string, SessionSummary>();
  for (const group of base.projects) {
    for (const session of group.sessions) rows.set(session.tabId, session);
  }
  const byProject = new Map<string, SessionSummary[]>();
  for (const record of registry.sessions) {
    if (record.chat) continue;
    const row = rows.get(record.tabId);
    if (row === undefined) continue;
    const bucket = byProject.get(record.projectCwd);
    if (bucket) bucket.push(row);
    else byProject.set(record.projectCwd, [row]);
  }
  const projects: ProjectGroup[] = registry.projects.map((project) => ({
    project,
    sessions: byProject.get(project.path) ?? [],
  }));
  const merged: Partial<BackendState> = { ...base };
  // Runtime boundary against S2 payloads: BackendBroadcastSettings omits these
  // twelve keys at the type level; strip them from the spread as well.
  for (const key of NEVER_BROADCAST_KEYS) delete (merged as Record<string, unknown>)[key];
  return {
    ...(merged as BackendState),
    ...broadcastSettings(registry),
    projects,
    modelFavorites: registry.getFavorites(),
    // A lite member is joined; it never joins anyone (the fleet is one level deep).
    remoteInstances: [],
  };
}

const NEVER_BROADCAST_KEYS: readonly string[] = [
  "remoteEnabled",
  "remoteBind",
  "remotePort",
  "remoteToken",
  "remotePasswordHash",
  "remotePasswordSalt",
  "instanceId",
  "webhooksEnabled",
  "mcpEndpointEnabled",
  "chatLastModel",
  "chatLastThinkingLevel",
  "reviewRoster",
];

/**
 * The default LiteSessions for a member whose sessions slice (S2) has not been
 * injected: an honest empty backend — the registry's settings broadcast with no
 * session rows anywhere. Injecting a real S2 replaces this wholesale; nothing
 * here pretends to run or list sessions.
 */
export function registryOnlySessions(registry: Registry): LiteSessions {
  return {
    handlers: {},
    state: () => ({
      ...broadcastSettings(registry),
      projects: [],
      chats: [],
      spawnGate: { model: null, advisorModel: null },
      remoteInstances: [],
      fleetPending: [],
      fleetTerminals: [],
    }),
    on: () => () => {},
    dispose: async () => {},
  };
}
