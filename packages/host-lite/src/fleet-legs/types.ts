/**
 * Fleet member legs for the headless lite host (issue #1010): the seam
 * contract between the channel wiring in `register-fleet-legs.ts` and the
 * Node machinery that actually runs commands, hosts terminals, manages
 * projects, and samples this machine.
 *
 * The ladder semantics (rung checks, first-sight, the grant store, the raise
 * ceremony, the audit ring) are implemented here in `register-fleet-legs.ts`
 * against these seams — identical decision text to the desktop node
 * (`packages/desktop/src/main/fleet-server.ts`), because a lite member must
 * answer an owner exactly like a desktop member. Everything that touches a
 * process table, a PTY, git, or /proc rides a seam; production adapters live
 * in `adapters-node.ts` (the single TODO_INTEGRATION file).
 */
import type {
  ChannelTable,
  FleetAuditEntry,
  FleetDetachedExecStartOutcome,
  FleetExecOutcome,
  FleetExecPollOutcome,
  FleetFinishOutcome,
  FleetFinishRequest,
  FleetHostOs,
  FleetHostProject,
  FleetPackageManager,
  FleetProjectFilesOutcome,
  FleetProjectFilesRequest,
  FleetProjectManageOutcome,
  FleetRequester,
  FleetRung,
  FleetSendOutcome,
  FleetSendRequest,
  FleetTerminalOpenOutcome,
  HostResources,
  ProjectRecord,
  RegistrySettings,
  RequestHandlers,
} from "@omp-ui/core";

/**
 * The registry slice this module reads and writes — the same keys
 * FleetServer uses. A real `Registry` satisfies it structurally; tests pass a
 * plain object so grant persistence is observable without a data dir.
 */
export interface FleetLegsRegistry {
  getSetting<K extends FleetLegsSettingKey>(key: K): FleetLegsSettings[K];
  setSetting<K extends FleetLegsSettingKey>(key: K, value: FleetLegsSettings[K]): void;
  /** Registered projects; `fleet:projectFiles` refuses a path that is not one. */
  readonly projects: readonly ProjectRecord[];
}

/** The registry keys the member legs touch (grant store, ladder, roots, join credential). */
export type FleetLegsSettingKey =
  | "instanceId"
  | "modelFavorites"
  | "remoteToken"
  | "remotePasswordHash"
  | "remotePasswordSalt"
  | "fleetExecEnabled"
  | "fleetExecCeiling"
  | "fleetGrants"
  | "fleetProjectRoots";

export type FleetLegsSettings = Pick<RegistrySettings, FleetLegsSettingKey>;

/**
 * One bounded command spec — the same triple `fleet-shell.ts`'s
 * `FleetCommandSpec` carries. Redeclared here so this package does not import
 * desktop source for a shape.
 */
export interface FleetExecCommandSpec {
  command: string;
  /** Null runs in the node user's home directory. */
  cwd: string | null;
  /** Null uses the module default (bounded or detached cap); the seam clamps. */
  timeoutMs: number | null;
}

/**
 * The exec legs of the ladder: the bounded runner plus the detached-exec
 * owner. `start`/`poll` mirror `FleetDetachedExecs`' member-side surface —
 * the rung arrives already gated by the caller's ladder check, exactly as the
 * desktop node hands it in; only the dispatcher that started an exec may poll
 * it (the seam keeps that ownership rule).
 */
export interface FleetExecLegs {
  /** Bounded `fleet:exec` run: fixed shells, byte caps, hard timeout. Refusals are outcomes. */
  run(spec: FleetExecCommandSpec): Promise<FleetExecOutcome>;
  /** Detached start (`fleet:execDetach`); capacity refusals ride the outcome. */
  start(requester: FleetRequester, rung: FleetRung, spec: FleetExecCommandSpec): FleetDetachedExecStartOutcome;
  /** `fleet:execPoll`: wait/cancel on the requester's own execId. */
  poll(requester: FleetRequester, execId: string, waitMs: number, cancel: boolean): Promise<FleetExecPollOutcome>;
  /** Kill every running exec whose requester fails `stillAllowed` (ladder enforcement). */
  revokeWhere(stillAllowed: (requesterId: string) => boolean): void;
  /** Quit path: cancel every running exec. */
  dispose(): void;
}

/**
 * The member-side fleet terminal legs (`fleet:terminalOpen/Renew/End` and the
 * write/size notifies). Mirrors `FleetTerminals`: the rung arrives already
 * gated; only a dispatcher's own ids renew, end, write, or resize.
 */
export interface FleetTerminalLegs {
  open(
    requester: FleetRequester,
    rung: FleetRung,
    terminalId: string,
    cols: number,
    rows: number,
  ): FleetTerminalOpenOutcome;
  renew(requester: FleetRequester, terminalIds: readonly string[]): string[];
  end(requester: FleetRequester, terminalId: string): void;
  write(dispatcherId: string, terminalId: string, data: string): void;
  resize(dispatcherId: string, terminalId: string, cols: number, rows: number): void;
  revokeWhere(stillAllowed: (requesterId: string) => boolean): void;
  dispose(): void;
}

/**
 * The rung-3 project verbs (`fleet:projectManage`, `fleet:projectFiles`).
 * The ladder gate and the empty-roots refusal happen in the wiring; these
 * methods receive the already-gated work with the declared roots in hand.
 * `writeFiles` receives a path-registration predicate because registration is
 * registry state the seam cannot read itself.
 */
export interface FleetProjectLegs {
  /** Clone an https URL into the first declared root without a name clash; register the checkout. */
  clone(repositoryUrl: string, roots: readonly string[]): Promise<FleetProjectManageOutcome>;
  /** Register an existing git checkout that sits under a declared root. */
  register(rawPath: string, roots: readonly string[]): Promise<FleetProjectManageOutcome>;
  /** Project-copy writes into a registered checkout under a declared root; new files only. */
  writeFiles(
    req: FleetProjectFilesRequest,
    roots: readonly string[],
    isRegisteredPath: (realPath: string) => boolean,
  ): Promise<FleetProjectFilesOutcome>;
}

/**
 * The host-report probes (`fleet:hostReport`). `resources` is the CPU/memory
 * sample placement reads (plain Node: os.cpus() deltas plus /proc/meminfo on
 * Linux); the rest answer exactly like the desktop member so an owner's
 * normalizer sees one shape from every fleet machine. Omitted optional probes
 * answer null — the owner already treats null as "this member predates the
 * feature" (issue #1010 ships no app updater, so `packageFormat`/
 * `appLatestVersion`/`appUpdateStaged` are absent-not-denied nulls).
 */
export interface FleetHostReportLegs {
  /** CPU/mem sample; a throw fails the whole report and is retried on the next poll (owner-side backoff). */
  resources(): Promise<HostResources>;
  /** Registered projects with the placement facts (repository key, head, advisor defaults). */
  projects(): Promise<FleetHostProject[]>;
  /** Sessions running / turns in flight right now. */
  activity(): { liveSessions: number; runningTurns: number };
  /** OS name/version probe; a throw reports as null. */
  os?(): Promise<FleetHostOs>;
  /** Package-manager probe; a throw reports as null. */
  packageManagers?(): Promise<FleetPackageManager[]>;
  /** The managed omp binary's version; null when none resolves. */
  ompVersion?(): Promise<string | null>;
  /** The resolved omp binary path; null when none (placement refuses to spawn there). */
  ompPath?(): string | null;
  /** True when OMP_UI_OMP_PATH pins omp away from the managed copy. */
  ompPinned?(): boolean;
}

/**
 * Provider key rollout (`fleet:providerKeys`): writes one key into this
 * machine's own credential store; throws a user-facing reason on failure. The
 * value never reaches a log or the audit ring. Absent until the credentials
 * slice is wired — then the channel registers itself.
 */
export interface FleetProviderKeyLegs {
  install(envName: string, value: string): void;
}

/** One dispatcher's session delivery legs (`fleet:send`, `fleet:finish`). */
export interface FleetSessionLegs {
  /** Stage, then deliver or resume the dispatched session (SessionManager.fleetSend). */
  deliverSend(req: FleetSendRequest): Promise<FleetSendOutcome>;
  /** Settle, then release an already-landed worktree (SessionManager.fleetFinish). */
  deliverFinish(req: FleetFinishRequest): Promise<FleetFinishOutcome>;
}

/** Everything `registerFleetLegs` consumes. Only `registry` and `host` are unconditional. */
export interface FleetLegsDeps {
  registry: FleetLegsRegistry;
  /** The member's fleet label (the desktop truncates os.hostname() to FLEET_LABEL_MAX). */
  label?: string;
  /** This host's omp-ui version, reported as `version`. */
  version?: string;
  exec?: FleetExecLegs;
  terminals?: FleetTerminalLegs;
  project?: FleetProjectLegs;
  sessions?: FleetSessionLegs;
  providerKeys?: FleetProviderKeyLegs;
  host: FleetHostReportLegs;
  /** One call per audit entry, ring order preserved by the wiring; adapters persist it. */
  auditSink?: (entry: FleetAuditEntry) => void;
  /** Fires after a grant write so the composition root can re-broadcast state. */
  stateChanged?: () => void;
}

/** The registered member-leg table plus the lifecycle hooks the composition root owns. */
export interface FleetLegsHandle {
  /** Member-leg request handlers; channels this host cannot serve are ABSENT, not denied. */
  readonly request: Partial<RequestHandlers>;
  /** Member-leg notify handlers (the terminal write/size legs ride notifies). */
  readonly notify: Partial<ChannelTable["notify"]>;
  /** Re-check every dispatcher's running work against the current grants/ladder. */
  enforceLadder(): void;
  /** Quit path: cancel detached execs and end fleet terminals. */
  dispose(): void;
}
