/**
 * Fleet dispatch, dispatching side (issue #899, ADR-0061): reads every fleet
 * member's host report, resolves a request to concrete targets, and sends one
 * `session:spawn` per target carrying the prompt. The owning instance delivers
 * the prompt itself; this side never retries, and an outcome it could not
 * learn waits in memory until a session with that dispatchId shows up.
 */
import { randomUUID } from "node:crypto";
import {
  CH,
  FLEET_APP_NO_RELEASE_DETAIL,
  FLEET_EXEC_POLL_WAIT_MAX_MS,
  FLEET_RUNGS,
  FLEET_STATUS_WAIT_MAX_MS,
  LOCAL_MACHINE_KEY,
  PLACEMENT_WEIGHT,
  choosePlacement,
  deriveFleetTitle,
  eligibleMachineCount,
  fleetChildSettled,
  fleetRungAtLeast,
  fleetChoiceText,
  fleetMachineName,
  fleetMemberAddress,
  fleetSessionState,
  fleetToolExecPollRequest,
  fleetToolExecRequest,
  fleetToolMachineKey,
  fleetToolUpdateRequest,
  mintBranchName,
  parseFleetDispatchRequest,
  parseFleetHostOs,
  parseFleetModelChoice,
  parseFleetModelFavorites,
  parseFleetPackageManagers,
  parseFleetUpdateFacts,
  validateFleetTitle,
  worktreeBranchPrefix,
  type FleetAgentUpdateAnswer,
  type FleetDispatchOutcome,
  type FleetDispatchRequest,
  type FleetDispatchResult,
  type FleetDetachedExecRequest,
  type FleetDetachedExecStartOutcome,
  type FleetExecOutcome,
  type FleetExecPollOutcome,
  type FleetExecPollRequest,
  type FleetExecRequest,
  type FleetGrantRaiseOutcome,
  type FleetGrantRaiseRequest,
  type FleetHostProject,
  type FleetHostReport,
  type FleetMachine,
  type FleetMaintenanceRecord,
  type FleetPendingDispatch,
  type FleetProjectFilesOutcome,
  type FleetProjectFilesRequest,
  type FleetProjectManageOutcome,
  type FleetProjectManageRequest,
  type FleetProviderKeyEntry,
  type FleetProviderKeysOutcome,
  type FleetProviderKeysRequest,
  type FleetSendOutcome,
  type FleetSendRequest,
  type FleetFinishOutcome,
  type FleetFinishRequest,
  type FleetRequester,
  type FleetRung,
  type FleetToolExecArgs,
  type FleetToolExecPollArgs,
  type FleetToolSendArgs,
  type FleetToolFinishArgs,
  type FleetToolProjectArgs,
  type FleetToolUpdateArgs,
  type FleetUpdateAck,
  type FleetUpdateMemberRequest,
  type FleetUpdatePollOutcome,
  type FleetUpdatePollRequest,
  type FleetUpdateRequest,
  type FleetUpdateAllMember,
  type FleetUpdateAllRun,
  type FleetUpdateAllStart,
  type FleetUpdateAllStep,
  type NewRpcSpawnRequest,
  type PlacementCandidate,
  type PlacementPreference,
  type RemoteInstanceSummary,
  type SessionSummary,
  type SpawnAnswer,
  type ProjectCopyRead,
  type ProjectCopyResult,
} from "@omp-ui/core";

/** A joined member's report must arrive inside this window, or the member reads as an error. */
const HOST_REPORT_TIMEOUT_MS = 4_000;
/** The rung probe races this window; an older or slow peer reads grantRung null. */
const GRANT_PROBE_TIMEOUT_MS = 4_000;
/** Each status summary races this window; a slow owner reads "summary unavailable". */
const SUMMARY_TIMEOUT_MS = 5_000;
/** Exec/project/grant calls race this bound: inside the 60 s host-answer watchdog. */
const MEMBER_CALL_DEADLINE_MS = 45_000;
/** One maintenance poll races this bound beside the slower host-report wait, so a wedged member never stretches machines() past report time + 40 s. */
const MAINTENANCE_POLL_DEADLINE_MS = 40_000;
/**
 * The user-path ceiling for one spawn answer (issue #907): a wedged remote
 * session:spawn must settle as "unknown" — pending row plus retry — instead
 * of holding the New session dialog forever. A legit spawn settles in
 * milliseconds; the worst legit case rides the git worktree ceiling
 * (ADD_TIMEOUT_MS = 60 s, packages/core/src/worktree.ts) plus relay and
 * boot writes, so 90 s leaves ~30 s of margin. The agent path keeps its own
 * tighter bound (AGENT_FLEET_DEADLINE_MS, 45 s, inside the 60 s host-answer
 * watchdog).
 */
const USER_FLEET_DEADLINE_MS = 90_000;
const TIMED_OUT = Symbol("timed out");
/** One TCP probe per host per window (issue #904): the Fleet view polls every 5 s and every tool call reads machines(). */
const SSH_PROBE_TTL_MS = 15_000;

export interface FleetDispatcherDeps {
  localReport(): Promise<FleetHostReport>;
  /** sessions.spawn */
  spawnLocal(req: NewRpcSpawnRequest): Promise<SpawnAnswer>;
  /** remoteInstances.summaries() */
  remotes(): RemoteInstanceSummary[];
  /** remoteInstances.request */
  request(id: string, channel: string, args: unknown[]): Promise<unknown>;
  /** The registry's fleetPlacement setting. */
  preferences(): Record<string, PlacementPreference>;
  requesterBase(): { instanceId: string; label: string };
  /** fleet.dispatchId over the local registry and every remote summary's sessions. */
  knownDispatchIds(): Set<string>;
  /** Every session of this app and its joined members, for the status tool. */
  fleetSessions(): Promise<Array<{ machineKey: string; nickname: string | null; summary: SessionSummary }>>;
  localSummary(tabId: string): Promise<string>;
  broadcast(): Promise<void>;
  /** ssh-probe.ts probeSshPort; never rejects. */
  probeSsh(host: string): Promise<boolean>;
  /** ProviderKeys.rolloutValue on this machine (issue #905); throws on unknown names. */
  providerKeyValue(envName: string): string | null;
  /** FleetWakeCoordinator.watch (issue #957): records an agent dispatch's non-failed outcomes for the dispatcher's wake-up. */
  watchAgentDispatch(sourceTabId: string, dispatches: Array<{ dispatchId: string; machineKey: string }>): void;
  /** Resolves after the next completed state broadcast, or after `timeoutMs`. */
  nextBroadcast(timeoutMs: number): Promise<void>;
  /** FleetServer.send on this machine (issue #959). */
  sendLocal(req: FleetSendRequest): Promise<FleetSendOutcome>;
  /** FleetServer.finish on this machine (issue #978). */
  finishLocal(req: FleetFinishRequest): Promise<FleetFinishOutcome>;
  /** readProjectCopyFiles on this machine (issue #992): re-scans the checkout and reads the picked files' bytes. */
  readProjectCopy(projectCwd: string, picked: readonly string[]): Promise<ProjectCopyRead>;
  now?: () => number;
  uuid?: () => string;
}

/** One resolved target: where the copy goes, or why it cannot. */
interface ResolvedTarget {
  machine: FleetMachine | null;
  machineKey: string;
  projectCwd: string;
  project: FleetHostProject | null;
  failure: string | null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `work`, or TIMED_OUT once `ms` pass first; a rejection still rejects. Executor
 *  form, not Promise.withResolvers: the node tsconfig lib is ES2022 (system-open.ts). */
function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** exec, detached exec, and poll all refuse this computer: the agent has its own tools there. */
const EXEC_LOCAL_REFUSAL = "exec runs only on fleet members; use your own tools on this computer";

/** A member that predates #905 answers the detached-exec channels with "unknown channel". */
function detachedExecUpdate<Outcome extends { status: string }>(outcome: Outcome, name: string): Outcome {
  if (outcome.status === "refused" && "reason" in outcome && typeof outcome.reason === "string" && outcome.reason.includes("unknown channel")) {
    return { ...outcome, reason: `${name} runs an omp-ui without detached exec; update omp-ui there` };
  }
  return outcome;
}

/** Fleet update verbs all refuse this computer: its own Settings → Updates owns it. */
const UPDATE_LOCAL_REFUSAL = "this computer updates itself from Settings → Updates";

/** A member that predates the fleet update channels answers them with "unknown channel". */
function fleetUpdateSkew<Ack extends { status: string }>(ack: Ack, name: string): Ack {
  if (ack.status === "refused" && "reason" in ack && typeof ack.reason === "string" && ack.reason.includes("unknown channel")) {
    return { ...ack, reason: `${name} runs an omp-ui without fleet updates; update omp-ui there` };
  }
  return ack;
}

/** The last-job map's key: one poll pointer per machine and target. */
function updateJobKey(machineKey: string, target: "omp" | "app"): string {
  return `${machineKey}|${target}`;
}

/** The member's update ack becomes the agent's answer; refusals ride the answer, never an error. */
function agentAnswerOf(ack: FleetUpdateAck): FleetAgentUpdateAnswer {
  if (ack.status === "refused") return { kind: "refused", reason: ack.reason };
  if ("check" in ack) return { kind: "check", check: ack.check };
  if ("jobId" in ack) return { kind: "started", jobId: ack.jobId };
  return { kind: "applied", detail: ack.detail };
}

/** Why Update all leaves a member out before asking it anything (issue #990); null to ask. */
function updateAllSkipReason(machine: FleetMachine): string | null {
  if (machine.status !== "ready") return machine.error ?? machine.status;
  if (machine.grantRung === null || !fleetRungAtLeast(machine.grantRung, "full")) {
    return machine.grantRung === null
      ? "this app's fleet access there is unknown; Update all needs Full control"
      : `this app holds fleet access "${machine.grantRung}" there; Update all needs Full control`;
  }
  return null;
}

/** One Update all leg as the same local request the Update versions… dialog sends. */
function updateAllRequest(target: "omp" | "app", action: FleetUpdateRequest["action"]): FleetUpdateRequest {
  return { target, action, version: null, allowLiveSessions: false };
}

export class FleetDispatcher {
  readonly #deps: FleetDispatcherDeps;
  readonly #now: () => number;
  readonly #uuid: () => string;
  /** Unknown outcomes by dispatchId; in memory only (BackendState.fleetPending). */
  readonly #pending = new Map<string, FleetPendingDispatch>();
  /** Cached port-22 probes by member address (issue #904). */
  readonly #sshProbes = new Map<string, { at: number; value: Promise<boolean> }>();
  /** The last Fleet maintenance this dispatcher started on each member (fleet remote version update), keyed by machineKey: the chip this machine shows. */
  readonly #maintenance = new Map<string, FleetMaintenanceRecord>();
  /** Finished jobs whose settling machines() poll already carried them; dropped after one more poll shows them. */
  readonly #settledShowing = new Set<string>();
  /** Job ids the update tool started per machine|target, so "poll again with the same arguments" never double-starts. */
  readonly #updateJobs = new Map<string, string>();
  /** The current or last Update all run (issue #990); in memory, replaced by the next start. */
  #updateAll: FleetUpdateAllRun | null = null;

  constructor(deps: FleetDispatcherDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#uuid = deps.uuid ?? randomUUID;
  }

  /** This app first, then every joined member in store order; a member that is this app is skipped. */
  machines(): Promise<FleetMachine[]> {
    const preferences = this.#deps.preferences();
    const local = this.#deps.localReport().then(
      (report): FleetMachine => ({
        key: LOCAL_MACHINE_KEY,
        nickname: null,
        status: "ready",
        error: null,
        preference: preferences[LOCAL_MACHINE_KEY] ?? "normal",
        report,
        receivedAt: this.#now(),
        grantRung: null,
        address: null,
        sshReachable: null,
        maintenance: null,
      }),
      (err: unknown): FleetMachine => ({
        key: LOCAL_MACHINE_KEY,
        nickname: null,
        status: "error",
        error: messageOf(err),
        preference: preferences[LOCAL_MACHINE_KEY] ?? "normal",
        report: null,
        receivedAt: null,
        grantRung: null,
        address: null,
        sshReachable: null,
        maintenance: null,
      }),
    );
    const others = this.#deps.remotes().filter((remote) => remote.status !== "self");
    // A member that deregistered has no row left to poll from and nothing to
    // answer with: drop its entry here (a transiently unjoined member keeps
    // it — the job may still be running there, and the chip returns with it).
    for (const key of [...this.#maintenance.keys()]) {
      if (!others.some((remote) => remote.id === key)) this.#dropMaintenance(key);
    }
    const remotes = others.map((remote) => this.#remoteMachine(remote, preferences[remote.id] ?? "normal"));
    return Promise.all([local, ...remotes]);
  }

  /**
   * One joined member's row, read the way machines() reads it (host report,
   * cached port-22 probe); null for an unknown id or this app's own entry.
   * Open in VS Code over Remote-SSH (issue #995) asks for one member only.
   */
  async machine(instanceId: string): Promise<FleetMachine | null> {
    const remote = this.#deps.remotes().find((r) => r.id === instanceId && r.status !== "self");
    if (remote === undefined) return null;
    return this.#remoteMachine(remote, this.#deps.preferences()[remote.id] ?? "normal");
  }

  async #remoteMachine(remote: RemoteInstanceSummary, preference: PlacementPreference): Promise<FleetMachine> {
    const machine: FleetMachine = {
      key: remote.id,
      nickname: remote.nickname,
      status: "unreachable",
      error: remote.error ?? remote.status,
      preference,
      report: null,
      receivedAt: null,
      grantRung: null,
      address: fleetMemberAddress(remote.url),
      sshReachable: null,
      maintenance: null,
    };
    if (remote.status !== "joined") return machine;
    // The port probe and the maintenance poll run beside the report request,
    // so neither stretches machines() past the slower of their bounds. Only a
    // member with a recorded job is polled; this computer never rides here.
    const ssh = machine.address === null ? Promise.resolve(null) : this.#sshReachable(machine.address);
    const maintenance =
      this.#maintenance.get(remote.id) === undefined ? Promise.resolve(null) : this.#maintenancePoll(remote.id);
    try {
      const report = await within(
        this.#deps.request(remote.id, CH.fleetHostReport, []) as Promise<FleetHostReport>,
        HOST_REPORT_TIMEOUT_MS,
      );
      if (report === TIMED_OUT) {
        return {
          ...machine,
          status: "error",
          error: `no host report within ${HOST_REPORT_TIMEOUT_MS / 1000} s`,
          sshReachable: await ssh,
          maintenance: await maintenance,
        };
      }
      const [grantRung, sshReachable, maintenanceRecord] = await Promise.all([
        this.#probeRung(remote.id),
        ssh,
        maintenance,
      ]);
      // A member that predates #904 sends neither user nor projectRoots; one
      // that predates #905 sends neither os nor packageManagers; one that
      // predates the fleet update channels sends none of the version facts;
      // one that predates #956 sends no modelFavorites.
      const normalized: FleetHostReport = {
        ...report,
        user: typeof report.user === "string" && report.user !== "" ? report.user : null,
        projectRoots: Array.isArray(report.projectRoots) ? report.projectRoots : null,
        os: parseFleetHostOs(report.os),
        packageManagers: parseFleetPackageManagers(report.packageManagers),
        ...parseFleetUpdateFacts(report),
        modelFavorites: parseFleetModelFavorites(report.modelFavorites),
      };
      return {
        ...machine,
        status: "ready",
        error: null,
        report: normalized,
        receivedAt: this.#now(),
        grantRung,
        sshReachable,
        maintenance: maintenanceRecord,
      };
    } catch (err) {
      const message = messageOf(err);
      const sshReachable = await ssh;
      // A member we cannot reach at all keeps no live chip: the poll answer
      // (or its loss) drops the entry silently, job still on the member.
      await maintenance;
      if (message.includes("unknown channel")) {
        return { ...machine, status: "unsupported", error: "update omp-ui on this instance to use Fleet", sshReachable };
      }
      return { ...machine, status: "error", error: message, sshReachable };
    }
  }

  /** One cached probe per host: the Fleet view polls every 5 s and every tool call reads machines(). */
  #sshReachable(host: string): Promise<boolean> {
    const now = this.#now();
    const hit = this.#sshProbes.get(host);
    if (hit !== undefined && now - hit.at < SSH_PROBE_TTL_MS) return hit.value;
    const value = this.#deps.probeSsh(host);
    this.#sshProbes.set(host, { at: now, value });
    return value;
  }

  /** The claimed identity every fleet channel carries (issue #901). */
  requester(kind: FleetRequester["kind"], sourceTabId: string | null): FleetRequester {
    return { ...this.#deps.requesterBase(), kind, sourceTabId };
  }

  /** This dispatcher's rung on a member (issue #901); null for older/silent peers. */
  async #probeRung(machineKey: string): Promise<FleetRung | null> {
    try {
      const answer = await within(
        this.#deps.request(machineKey, CH.fleetGrantRung, [this.requester("user", null)]),
        GRANT_PROBE_TIMEOUT_MS,
      );
      if (answer === TIMED_OUT || answer === null || typeof answer !== "object" || !("rung" in answer)) return null;
      const rung = answer.rung;
      return typeof rung === "string" && (FLEET_RUNGS as readonly string[]).includes(rung) ? (rung as FleetRung) : null;
    } catch {
      return null;
    }
  }

  async dispatch(
    raw: FleetDispatchRequest,
    who:
      | { kind: "user" }
      | { kind: "webhook" }
      | { kind: "agent"; sourceTabId: string }
      | { kind: "mcp"; sourceTabId: string },
    opts: { deadlineMs?: number } = {},
  ): Promise<FleetDispatchResult> {
    // The channel codec already parsed a user request; the agent path arrives unparsed.
    const req = parseFleetDispatchRequest(raw);
    const machines = await this.machines();
    const targets = this.#resolveTargets(req, machines);
    const title = validateFleetTitle(req.title?.trim() || deriveFleetTitle(req.prompt));
    const batchId = req.retryOf !== undefined ? req.retryOf.batchId : targets.length > 1 ? this.#uuid() : null;
    const requestedBy = {
      ...this.#deps.requesterBase(),
      kind: who.kind,
      sourceTabId: who.kind === "agent" || who.kind === "mcp" ? who.sourceTabId : null,
    };
    let pendingAdded = false;
    const outcomes = await Promise.all(
      targets.map(async (target): Promise<FleetDispatchOutcome> => {
        const dispatchId = req.retryOf?.dispatchId ?? this.#uuid();
        const base = { dispatchId, machineKey: target.machineKey, projectCwd: target.projectCwd };
        if (target.failure !== null || target.project === null) {
          return { ...base, status: "failed", message: target.failure ?? "no project" };
        }
        const spawn: NewRpcSpawnRequest = {
          origin: "new",
          mode: "rpc-ui",
          projectCwd: target.projectCwd,
          cols: 80,
          rows: 24,
          advisor: target.project.advisor,
          advisorModel: target.project.advisorModel,
          planMode: req.planMode,
          worktree:
            req.workspace === "worktree"
              ? {
                  mint: {
                    branch: mintBranchName(worktreeBranchPrefix(target.projectCwd)),
                    baseRef: null,
                    baseBranch: null,
                  },
                }
              : null,
          fleet: {
            dispatchId,
            batchId,
            title,
            prompt: req.prompt,
            requestedBy,
            ...(req.model === undefined ? {} : { model: req.model }),
            ...(req.thinkingLevel === undefined ? {} : { thinkingLevel: req.thinkingLevel }),
          },
        };
        const local = target.machineKey === LOCAL_MACHINE_KEY;
        const work = local
          ? this.#deps.spawnLocal(spawn)
          : (this.#deps.request(target.machineKey, CH.spawnSession, [spawn]) as Promise<SpawnAnswer>);
        // Every dispatch is bounded (issue #907): the caller's deadline wins,
        // the user path defaults to USER_FLEET_DEADLINE_MS. A wedged answer
        // settles as "unknown" below instead of hanging the New session
        // dialog; a local spawn rides the same bound, but its worst legit
        // case (~65 s on the git ceiling) stays under the default.
        const deadlineMs = opts.deadlineMs ?? USER_FLEET_DEADLINE_MS;
        let unknown: string;
        try {
          const answer = await within(work, deadlineMs);
          if (answer !== TIMED_OUT) {
            this.#pending.delete(dispatchId);
            return { ...base, status: "started", tabId: answer.tabId, choice: parseFleetModelChoice(answer.choice) };
          }
          unknown = `no answer within ${Math.round(deadlineMs / 1000)} s; the session may still start`;
        } catch (err) {
          const message = messageOf(err);
          if (local || !message.includes("remote connection lost")) return { ...base, status: "failed", message };
          unknown = `${message}; the session may have started`;
        }
        // Never retried here: the owner dedupes by dispatchId, so only a manual retry re-sends.
        this.#pending.set(dispatchId, {
          dispatchId,
          batchId,
          machineKey: target.machineKey,
          nickname: target.machine?.nickname ?? null,
          projectCwd: target.projectCwd,
          title,
          since: new Date(this.#now()).toISOString(),
          message: unknown,
        });
        pendingAdded = true;
        return { ...base, status: "unknown", message: unknown };
      }),
    );
    if (who.kind === "agent") {
      try {
        this.#deps.watchAgentDispatch(
          who.sourceTabId,
          outcomes.filter((o) => o.status !== "failed").map((o) => ({ dispatchId: o.dispatchId, machineKey: o.machineKey })),
        );
      } catch (err) {
        console.warn(`[fleet] ${who.sourceTabId}: recording the dispatch for wake-up failed:`, err);
      }
    }
    if (pendingAdded) await this.#deps.broadcast();
    return { batchId, outcomes };
  }

  #resolveTargets(req: FleetDispatchRequest, machines: FleetMachine[]): ResolvedTarget[] {
    const byKey = new Map(machines.map((m) => [m.key, m]));
    const wantsChoice = req.model !== undefined || req.thinkingLevel !== undefined;
    const SKEW = (name: string) => `${name} runs an omp-ui without dispatch model selection; update omp-ui there`;
    if (req.targets.kind === "explicit") {
      return req.targets.picks.map((pick): ResolvedTarget => {
        const machine = byKey.get(pick.machineKey) ?? null;
        const target: ResolvedTarget = { machine, ...pick, project: null, failure: null };
        if (machine === null) return { ...target, failure: `no fleet machine ${pick.machineKey}` };
        const name = fleetMachineName(machine);
        if (machine.status !== "ready" || machine.report === null) {
          return { ...target, failure: `${name} is not ready (${machine.status}${machine.error ? `: ${machine.error}` : ""})` };
        }
        const project = machine.report.projects.find((p) => p.path === pick.projectCwd);
        if (project === undefined) return { ...target, failure: `${name} has no project ${pick.projectCwd}` };
        if (!project.providerReady) return { ...target, failure: `no model provider on ${name}` };
        if (wantsChoice && machine.report.modelFavorites === null) return { ...target, failure: SKEW(name) };
        return { ...target, project };
      });
    }
    const { reference, count } = req.targets;
    const refMachine = byKey.get(reference.machineKey);
    const refProject = refMachine?.report?.projects.find((p) => p.path === reference.projectCwd);
    if (refMachine === undefined || refMachine.status !== "ready" || refProject === undefined) {
      throw new Error(`${reference.projectCwd} is not a ready project on that fleet machine`);
    }
    const key = refProject.repositoryKey;
    const holders: Array<{ machine: FleetMachine; project: FleetHostProject }> = [];
    if (key === null) {
      holders.push({ machine: refMachine, project: refProject });
    } else {
      for (const machine of machines) {
        if (machine.status !== "ready" || machine.report === null) continue;
        const project =
          machine === refMachine ? refProject : machine.report.projects.find((p) => p.repositoryKey === key && p.providerReady);
        if (project !== undefined) holders.push({ machine, project });
      }
    }
    const candidates: PlacementCandidate[] = holders
      .filter((h) => h.project.providerReady && (!wantsChoice || h.machine.report!.modelFavorites !== null))
      .map((h) => ({
        machineKey: h.machine.key,
        projectCwd: h.project.path,
        weight: PLACEMENT_WEIGHT[h.machine.preference],
        report: h.machine.report,
        receivedAt: h.machine.receivedAt,
      }));
    const now = this.#now();
    const picked = choosePlacement(candidates, now, count);
    if (picked.length === 0) {
      throw new Error(
        `Only ${eligibleMachineCount(candidates, now)} fleet machines can take this work now (needs: same repository, a ready model provider${wantsChoice ? ", an omp-ui that supports model selection" : ""}, CPU under 95%, more than 5% memory free). Choose machines manually.`,
      );
    }
    return picked.map((c) => {
      const holder = holders.find((h) => h.machine.key === c.machineKey)!;
      return { machine: holder.machine, machineKey: c.machineKey, projectCwd: c.projectCwd, project: holder.project, failure: null };
    });
  }

  /** Unknown outcomes still unresolved; an entry drops once a session carries its dispatchId. */
  pending(): FleetPendingDispatch[] {
    if (this.#pending.size === 0) return [];
    const known = this.#deps.knownDispatchIds();
    for (const id of this.#pending.keys()) if (known.has(id)) this.#pending.delete(id);
    return [...this.#pending.values()];
  }

  dismissPending(dispatchId: string): void {
    this.#pending.delete(dispatchId);
  }

  /** The omp-ui_fleet_status answer: one line per matching session, then unresolved outcomes. */
  async statusText(sel: { batchId: string } | { dispatchId: string }, waitMs = 0): Promise<string> {
    const matches = (f: { batchId: string | null; dispatchId: string }): boolean =>
      "batchId" in sel ? f.batchId === sel.batchId : f.dispatchId === sel.dispatchId;
    if (waitMs > 0) {
      // Busy: working, or idle/dormant before its first run finished (a fresh child is idle with no transcript yet).
      // The wait ends only when some session leaves busy — settles or starts awaiting an answer.
      const signature = async (): Promise<{ key: string; busy: boolean }> => {
        const states = (await this.#deps.fleetSessions())
          .filter((s) => s.summary.fleet != null && matches(s.summary.fleet))
          .map((s) => {
            const state = fleetSessionState(s.summary);
            const busy = state === "working" || ((state === "idle" || state === "dormant") && !fleetChildSettled(s.summary));
            return { id: s.summary.fleet!.dispatchId, state: busy ? "busy" : state };
          });
        const pending = this.pending().filter(matches);
        return {
          key: [...states.map((s) => `${s.id}=${s.state}`), ...pending.map((p) => `${p.dispatchId}=busy`)].sort().join("|"),
          busy: states.some((s) => s.state === "busy") || pending.length > 0,
        };
      };
      const first = await signature();
      const deadline = this.#now() + Math.min(waitMs, FLEET_STATUS_WAIT_MAX_MS);
      while (first.busy) {
        const left = deadline - this.#now();
        if (left <= 0) break;
        await this.#deps.nextBroadcast(left);
        if ((await signature()).key !== first.key) break;
      }
    }
    const sessions = (await this.#deps.fleetSessions()).filter((s) => {
      // An older remote's summary carries no fleet field at all.
      const fleet = s.summary.fleet as SessionSummary["fleet"] | undefined;
      return fleet != null && matches(fleet);
    });
    const pending = this.pending().filter(matches);
    if (sessions.length === 0 && pending.length === 0) {
      return "batchId" in sel
        ? `No fleet dispatch matches batch ${sel.batchId}.`
        : `No fleet dispatch matches dispatch ${sel.dispatchId}.`;
    }
    const lines = await Promise.all(
      sessions.map(async ({ machineKey, nickname, summary }) => {
        const state = fleetSessionState(summary);
        const head = `- ${fleetMachineName({ nickname })} · ${summary.title} · ${state} (dispatch ${summary.fleet!.dispatchId}, tab ${summary.tabId}${fleetChoiceText({ model: summary.model ?? null, thinkingLevel: summary.thinkingLevel ?? null })})`;
        if (state === "working") return head;
        const read =
          machineKey === LOCAL_MACHINE_KEY
            ? this.#deps.localSummary(summary.tabId)
            : this.#deps.request(machineKey, CH.fleetSessionSummary, [summary.tabId]);
        const text = await within(read, SUMMARY_TIMEOUT_MS).catch(() => TIMED_OUT);
        return `${head}\n\n${typeof text === "string" ? text.trim() : "summary unavailable"}\n`;
      }),
    );
    for (const p of pending) {
      lines.push(
        `- ${fleetMachineName(p)} · ${p.title} · outcome unknown (dispatch ${p.dispatchId}, since ${p.since}): ${p.message}`,
      );
    }
    return lines.join("\n");
  }

  /**
   * `omp-ui_fleet_send` (issue #959): a message to a child this session
   * dispatched — or, with kind "mcp", one an MCP client started (ADR-0080);
   * then `tabId` is the client id. Pre-checked here; the owner re-checks the requester.
   */
  async send(tabId: string, args: FleetToolSendArgs, kind: "agent" | "mcp" = "agent"): Promise<FleetSendOutcome> {
    const s = (await this.#deps.fleetSessions()).find((x) => x.summary.fleet?.dispatchId === args.dispatchId);
    if (s === undefined) {
      return this.pending().some((p) => p.dispatchId === args.dispatchId)
        ? { status: "refused", reason: "that dispatch's outcome is still unknown" }
        : { status: "refused", reason: `no dispatched session has dispatch ${args.dispatchId}` };
    }
    const requester = this.requester(kind, tabId);
    const by = s.summary.fleet!.requestedBy;
    if (by.kind !== kind || by.instanceId !== requester.instanceId || by.sourceTabId !== requester.sourceTabId) {
      return {
        status: "refused",
        reason: kind === "mcp" ? "only the MCP client that started this session can send to it" : "only the session that dispatched this work can send to it",
      };
    }
    const req: FleetSendRequest = { requester, dispatchId: args.dispatchId, message: args.message, mode: args.mode };
    if (s.machineKey === LOCAL_MACHINE_KEY) return this.#deps.sendLocal(req);
    return this.#memberCall<FleetSendOutcome>(s.machineKey, CH.fleetSend, [req], fleetMachineName({ nickname: s.nickname ?? s.machineKey }));
  }

  /**
   * `omp-ui_fleet_finish` (issue #978): clean up an already-landed worktree
   * session this session dispatched. Pre-checked here; the owner re-checks
   * the requester and every git fact.
   */
  async finish(tabId: string, args: FleetToolFinishArgs): Promise<FleetFinishOutcome> {
    const s = (await this.#deps.fleetSessions()).find((x) => x.summary.fleet?.dispatchId === args.dispatchId);
    if (s === undefined) {
      return this.pending().some((p) => p.dispatchId === args.dispatchId)
        ? { status: "refused", reason: "that dispatch's outcome is still unknown" }
        : { status: "refused", reason: `no dispatched session has dispatch ${args.dispatchId}` };
    }
    const requester = this.requester("agent", tabId);
    const by = s.summary.fleet!.requestedBy;
    if (by.instanceId !== requester.instanceId || by.sourceTabId !== requester.sourceTabId) {
      return { status: "refused", reason: "only the session that dispatched this work can finish it" };
    }
    const req: FleetFinishRequest = { requester, dispatchId: args.dispatchId };
    if (s.machineKey === LOCAL_MACHINE_KEY) return this.#deps.finishLocal(req);
    return this.#memberCall<FleetFinishOutcome>(s.machineKey, CH.fleetFinish, [req], fleetMachineName({ nickname: s.nickname ?? s.machineKey }));
  }

  /**
   * `omp-ui_fleet_exec` (issue #901): one bounded command on a member. This
   * computer is refused — the agent has its own tools there. The owner holds
   * the ladder; refusals ride the outcome, never an error.
   */
  async exec(tabId: string, args: FleetToolExecArgs): Promise<FleetExecOutcome> {
    const machines = await this.machines();
    const translated = fleetToolExecRequest(args, machines);
    if (!translated.ok) return { status: "refused", reason: translated.reason };
    if (translated.machineKey === LOCAL_MACHINE_KEY) {
      return { status: "refused", reason: EXEC_LOCAL_REFUSAL };
    }
    const name = fleetMachineName(machines.find((m) => m.key === translated.machineKey) ?? { nickname: translated.machineKey });
    const requester = this.requester("agent", tabId);
    const req: FleetExecRequest = { ...translated.request, requester };
    return this.#memberCall(translated.machineKey, CH.fleetExec, [req], name);
  }

  /**
   * `omp-ui_fleet_exec` with detach (issue #905): the member starts the
   * command under its own 30 min cap and answers with an execId at once.
   */
  async execDetach(tabId: string, args: FleetToolExecArgs): Promise<FleetDetachedExecStartOutcome> {
    const machines = await this.machines();
    const translated = fleetToolExecRequest(args, machines);
    if (!translated.ok) return { status: "refused", reason: translated.reason };
    if (translated.machineKey === LOCAL_MACHINE_KEY) return { status: "refused", reason: EXEC_LOCAL_REFUSAL };
    const name = fleetMachineName(machines.find((m) => m.key === translated.machineKey) ?? { nickname: translated.machineKey });
    const req: FleetDetachedExecRequest = { ...translated.request, requester: this.requester("agent", tabId) };
    const answer = await this.#memberCall<FleetDetachedExecStartOutcome>(translated.machineKey, CH.fleetExecDetach, [req], name);
    return detachedExecUpdate(answer, name);
  }

  /** `omp-ui_fleet_exec_poll` (issue #905): the member answers only the dispatcher that started the exec. */
  async execPoll(tabId: string, args: FleetToolExecPollArgs): Promise<FleetExecPollOutcome> {
    const machines = await this.machines();
    const translated = fleetToolExecPollRequest(args, machines);
    if (!translated.ok) return { status: "refused", reason: translated.reason };
    if (translated.machineKey === LOCAL_MACHINE_KEY) return { status: "refused", reason: EXEC_LOCAL_REFUSAL };
    const name = fleetMachineName(machines.find((m) => m.key === translated.machineKey) ?? { nickname: translated.machineKey });
    const req: FleetExecPollRequest = { ...translated.request, requester: this.requester("agent", tabId) };
    const answer = await this.#memberCall<FleetExecPollOutcome>(translated.machineKey, CH.fleetExecPoll, [req], name);
    return detachedExecUpdate(answer, name);
  }

  /** `omp-ui_fleet_project` (issue #901): rung-3 clone/register on a member. */
  async projectManage(tabId: string, args: FleetToolProjectArgs): Promise<FleetProjectManageOutcome> {
    const machines = await this.machines();
    const resolved = fleetToolMachineKey(args.machine, machines);
    if (!resolved.ok) return { status: "refused", reason: resolved.reason };
    if (resolved.machineKey === LOCAL_MACHINE_KEY) {
      return { status: "refused", reason: "project manage runs on fleet members; use your own tools on this computer" };
    }
    const name = fleetMachineName(machines.find((m) => m.key === resolved.machineKey) ?? { nickname: resolved.machineKey });
    const requester = this.requester("agent", tabId);
    const req: FleetProjectManageRequest =
      args.verb === "clone"
        ? { requester, verb: "clone", repositoryUrl: args.repositoryUrl ?? "" }
        : { requester, verb: "register", path: args.path ?? "" };
    return this.#memberCall(resolved.machineKey, CH.fleetProjectManage, [req], name);
  }

  /**
   * The grant-raise ceremony (issue #901) against member `machineKey`: the
   * freshly typed secret only — the stored encrypted credential is never read.
   */
  async requestGrant(machineKey: string, rung: FleetRung, secret: string): Promise<FleetGrantRaiseOutcome> {
    const remote = this.#deps.remotes().find((r) => r.id === machineKey && r.status !== "self");
    if (remote === undefined) return { ok: false, reason: "no joined fleet instance has that id" };
    if (remote.status !== "joined") return { ok: false, reason: `${fleetMachineName(remote)} is not joined` };
    const req: FleetGrantRaiseRequest = { requester: this.requester("user", null), targetRung: rung, credential: secret };
    try {
      const answer = await within(this.#deps.request(machineKey, CH.fleetGrantRaise, [req]), MEMBER_CALL_DEADLINE_MS);
      if (answer === TIMED_OUT) return { ok: false, reason: `no answer from ${fleetMachineName(remote)} within ${MEMBER_CALL_DEADLINE_MS / 1000} s` };
      return answer as FleetGrantRaiseOutcome;
    } catch (err) {
      return { ok: false, reason: messageOf(err) };
    }
  }

  /**
   * Provider key rollout (issue #905) to member `machineKey`, user-initiated
   * only. Values are read here, in main, and travel main-to-main; no value
   * ever enters a refusal, failure reason, or log line.
   */
  async rolloutProviderKeys(machineKey: string, envNames: string[]): Promise<FleetProviderKeysOutcome> {
    if (machineKey === LOCAL_MACHINE_KEY) return { status: "refused", reason: "Provider keys already live on this computer" };
    const remote = this.#deps.remotes().find((r) => r.id === machineKey && r.status !== "self");
    if (remote === undefined) return { status: "refused", reason: "no joined fleet instance has that id" };
    const name = fleetMachineName(remote);
    if (remote.status !== "joined") return { status: "refused", reason: `${name} is not joined` };
    const keys: FleetProviderKeyEntry[] = [];
    const localFailed: Array<{ envName: string; reason: string }> = [];
    for (const envName of new Set(envNames)) {
      let value: string | null;
      try {
        value = this.#deps.providerKeyValue(envName);
      } catch (err) {
        localFailed.push({ envName, reason: messageOf(err) });
        continue;
      }
      if (value === null) localFailed.push({ envName, reason: "not set on this computer" });
      else keys.push({ envName, value });
    }
    if (keys.length === 0) return { status: "refused", reason: "none of the chosen keys is set on this computer" };
    const req: FleetProviderKeysRequest = { requester: this.requester("user", null), keys };
    try {
      const answer = await within(
        this.#deps.request(machineKey, CH.fleetProviderKeys, [req]) as Promise<FleetProviderKeysOutcome>,
        MEMBER_CALL_DEADLINE_MS,
      );
      if (answer === TIMED_OUT) return { status: "refused", reason: `no answer from ${name} within ${MEMBER_CALL_DEADLINE_MS / 1000} s` };
      if (answer.status !== "accepted") return answer;
      return { ...answer, failed: [...localFailed, ...answer.failed] };
    } catch (err) {
      const message = messageOf(err);
      return {
        status: "refused",
        reason: message.includes("unknown channel") ? `${name} runs an omp-ui without Provider key rollout; update omp-ui there` : message,
      };
    }
  }

  /**
   * Project copy (issue #992) to member `machineKey`, user-initiated only:
   * the member clones this checkout's web remote over https into one of its
   * declared project roots and registers it (the rung-3 clone verb), then
   * receives the picked gitignored files main-to-main. File bytes are read
   * here and never reach a renderer, a log line, or a reason.
   */
  async copyProject(machineKey: string, projectCwd: string, picked: string[]): Promise<ProjectCopyResult> {
    if (machineKey === LOCAL_MACHINE_KEY) return { status: "refused", reason: "this project already lives on this computer" };
    const remote = this.#deps.remotes().find((r) => r.id === machineKey && r.status !== "self");
    if (remote === undefined) return { status: "refused", reason: "no joined fleet instance has that id" };
    const name = fleetMachineName(remote);
    if (remote.status !== "joined") return { status: "refused", reason: `${name} is not joined` };
    let read: ProjectCopyRead;
    try {
      read = await this.#deps.readProjectCopy(projectCwd, picked);
    } catch (err) {
      return { status: "refused", reason: messageOf(err) };
    }
    const { repositoryUrl, remote: reach } = read.preview;
    if (repositoryUrl === null) {
      return {
        status: "refused",
        reason: `this checkout has no web remote ${name} can clone; ask an agent to provision ${name} over its own ssh instead`,
      };
    }
    const requester = this.requester("user", null);
    const clone: FleetProjectManageRequest = { requester, verb: "clone", repositoryUrl };
    const cloned = await this.#memberCall<FleetProjectManageOutcome>(machineKey, CH.fleetProjectManage, [clone], name);
    if (cloned.status !== "accepted") {
      // ADR-0064: a member clones with no credential of its own, so a private
      // or SSH-only repository is provisioned by an agent over the user's ssh.
      const note = /git clone failed|timed out/.test(cloned.reason)
        ? `. If the repository is private${reach === "ssh" ? " or reachable only over SSH" : ""}, ask an agent to provision ${name} over its own ssh instead`
        : "";
      return { status: "refused", reason: `${cloned.reason}${note}` };
    }
    const result = {
      status: "copied" as const,
      path: cloned.path,
      headCommit: cloned.headCommit,
      filesWritten: [] as string[],
      filesFailed: [...read.failed],
    };
    if (read.files.length === 0) return result;
    const req: FleetProjectFilesRequest = { requester, path: cloned.path, files: read.files };
    const written = await this.#memberCall<FleetProjectFilesOutcome>(machineKey, CH.fleetProjectFiles, [req], name);
    if (written.status !== "accepted") {
      const reason = written.reason.includes("unknown channel")
        ? `${name} runs an omp-ui without Project copy; update omp-ui there`
        : written.reason;
      result.filesFailed.push(...read.files.map((f) => ({ path: f.path, reason })));
      return result;
    }
    result.filesWritten = written.written;
    result.filesFailed.push(...written.failed);
    return result;
  }

  /**
   * Fleet remote version update to member `machineKey`, user-initiated: the
   * member runs the maintenance on itself and this side only records the job
   * it started, so `machines()` can show one chip. This computer is refused —
   * its own Settings → Updates owns it. Refusals ride the ack, never an error.
   */
  async updateMachine(
    machineKey: string,
    req: FleetUpdateRequest,
    who: { kind: "user" } | { kind: "agent"; sourceTabId: string } = { kind: "user" },
  ): Promise<FleetUpdateAck> {
    if (machineKey === LOCAL_MACHINE_KEY) return { status: "refused", reason: UPDATE_LOCAL_REFUSAL };
    const remote = this.#deps.remotes().find((r) => r.id === machineKey && r.status !== "self");
    if (remote === undefined) return { status: "refused", reason: "no joined fleet instance has that id" };
    const name = fleetMachineName(remote);
    if (remote.status !== "joined") return { status: "refused", reason: `${name} is not joined` };
    const memberReq: FleetUpdateMemberRequest = {
      ...req,
      requester: this.requester(who.kind, who.kind === "agent" ? who.sourceTabId : null),
    };
    let ack: FleetUpdateAck;
    try {
      const answer = await within(
        this.#deps.request(machineKey, CH.fleetUpdateMember, [memberReq]) as Promise<FleetUpdateAck>,
        MEMBER_CALL_DEADLINE_MS,
      );
      if (answer === TIMED_OUT) return { status: "refused", reason: `no answer from ${name} within ${MEMBER_CALL_DEADLINE_MS / 1000} s` };
      ack = answer;
    } catch (err) {
      const message = messageOf(err);
      return {
        status: "refused",
        reason: message.includes("unknown channel") ? `${name} runs an omp-ui without fleet updates; update omp-ui there` : message,
      };
    }
    if (ack.status === "accepted" && "jobId" in ack) {
      this.#maintenance.set(machineKey, {
        jobId: ack.jobId,
        target: req.target,
        state: "running",
        progress: null,
        detail: null,
        at: this.#now(),
      });
      this.#settledShowing.delete(machineKey);
      this.#updateJobs.set(updateJobKey(machineKey, req.target), ack.jobId);
    }
    return fleetUpdateSkew(ack, name);
  }

  /**
   * `omp-ui_fleet_update` (fleet remote version update): check, start, or
   * poll one member's maintenance. A repeat call with the arguments that
   * started a still-running job polls that job instead of starting another;
   * the member holds the ladder, and refusals ride the answer.
   */
  async update(tabId: string, args: FleetToolUpdateArgs): Promise<FleetAgentUpdateAnswer> {
    const machines = await this.machines();
    const translated = fleetToolUpdateRequest(args, machines);
    if (!translated.ok) return { kind: "refused", reason: translated.reason };
    if (translated.machineKey === LOCAL_MACHINE_KEY) return { kind: "refused", reason: UPDATE_LOCAL_REFUSAL };
    const machineKey = translated.machineKey;
    const name = fleetMachineName(machines.find((m) => m.key === machineKey) ?? { nickname: machineKey });
    const jobKey = updateJobKey(machineKey, args.target);
    const lastJobId = this.#updateJobs.get(jobKey);
    if (lastJobId !== undefined && args.action !== "apply") {
      const polled = await this.#memberCall<FleetUpdatePollOutcome>(
        machineKey,
        CH.fleetUpdatePoll,
        [{ requester: this.requester("agent", tabId), jobId: lastJobId, waitMs: 0 }],
        name,
      );
      if (polled.status === "refused") {
        // A member that never answered stays a refusal — a second doomed
        // call would not answer either. Any other refusal means the job is
        // gone (member restarted, id aged out): clear the pointer and the
        // action below proceeds fresh.
        const reason = fleetUpdateSkew(polled, name).reason;
        if (/^no answer from /.test(reason)) return { kind: "refused", reason };
        this.#updateJobs.delete(jobKey);
      } else if (polled.state === "running") {
        return { kind: "poll", state: polled.state, progress: polled.progress, detail: polled.detail };
      } else {
        // The job this call would have started already settled: answer the
        // finish (the host bridge renders the final detail) and drop the pointer.
        this.#updateJobs.delete(jobKey);
        return { kind: "poll", state: polled.state, progress: polled.progress, detail: polled.detail };
      }
    }
    // The translator already mapped the tool's "update" to the wire's "stage";
    // the member audits the agent's tab through the claimed identity.
    return agentAnswerOf(await this.updateMachine(machineKey, translated.request, { kind: "agent", sourceTabId: tabId }));
  }

  /**
   * Update all (issue #990): the per-member update `updateMachine` runs, on
   * every joined member at once — the omp binary first, then omp-ui staged
   * and armed to install at that member's next quit (ADR-0066: nothing here
   * restarts a member). A member this app does not hold Full control on, or
   * one that is not ready, is skipped with the reason; the member's own gate
   * (master switch, pin, package format, one job at a time) answers the rest.
   * Answers at once with the run; `updateAllStatus` reads its progress.
   */
  async updateAll(): Promise<FleetUpdateAllStart> {
    if (this.#updateAll !== null && this.#updateAll.finishedAt === null) {
      return { status: "refused", reason: "an Update all run is already in progress" };
    }
    const machines = (await this.machines()).filter((m) => m.key !== LOCAL_MACHINE_KEY);
    if (machines.length === 0) return { status: "refused", reason: "no fleet member is joined" };
    const run: FleetUpdateAllRun = {
      runId: this.#uuid(),
      startedAt: this.#now(),
      finishedAt: null,
      members: machines.map((machine): FleetUpdateAllMember => {
        const skip = updateAllSkipReason(machine);
        return {
          machineKey: machine.key,
          nickname: machine.nickname,
          state: skip === null ? "queued" : "skipped",
          step: null,
          progress: null,
          omp: null,
          app: null,
          reason: skip,
        };
      }),
    };
    this.#updateAll = run;
    const legs = run.members
      .filter((m) => m.state === "queued")
      .map((m) =>
        this.#updateAllMember(m).catch((err: unknown) => {
          m.state = "failed";
          m.step = null;
          m.reason = messageOf(err);
        }),
      );
    void Promise.all(legs).then(() => {
      run.finishedAt = this.#now();
    });
    return { status: "accepted", run: structuredClone(run) };
  }

  /** A copy of the current or last Update all run; null before the first. */
  updateAllStatus(): FleetUpdateAllRun | null {
    return this.#updateAll === null ? null : structuredClone(this.#updateAll);
  }

  /** One member's two steps in order; the app step runs even when the omp step failed. */
  async #updateAllMember(member: FleetUpdateAllMember): Promise<void> {
    const name = fleetMachineName({ nickname: member.nickname ?? member.machineKey });
    member.state = "running";
    member.step = "omp";
    const omp = await this.#updateAllOmp(member, name);
    if (omp === null) return;
    member.omp = omp;
    member.step = "app";
    member.progress = null;
    member.app = await this.#updateAllApp(member, name);
    member.step = null;
    member.progress = null;
    member.state = member.omp.kind === "failed" || member.app.kind === "failed" ? "failed" : "done";
  }

  /** The omp step; null when the member's gate refused the first check (the whole member is skipped). */
  async #updateAllOmp(member: FleetUpdateAllMember, name: string): Promise<FleetUpdateAllStep | null> {
    const checked = await this.updateMachine(member.machineKey, updateAllRequest("omp", "check"));
    if (checked.status === "refused") {
      member.state = "skipped";
      member.step = null;
      member.reason = checked.reason;
      return null;
    }
    if (!("check" in checked) || checked.check.target !== "omp") return { kind: "failed", reason: `${name} answered the omp check without one` };
    const check = checked.check;
    if (check.pinned) return { kind: "skipped", reason: "omp is pinned by OMP_UI_OMP_PATH there" };
    if (check.latestVersion === null) return { kind: "skipped", reason: `${name} could not look up the newest omp release` };
    if (check.installedVersion !== null && !check.updateAvailable) return { kind: "current", version: check.installedVersion };
    const started = await this.updateMachine(member.machineKey, updateAllRequest("omp", "stage"));
    if (started.status === "refused") return { kind: "skipped", reason: started.reason };
    if (!("jobId" in started)) return { kind: "failed", reason: `${name} started no omp job` };
    const settled = await this.#updateAllSettle(member, started.jobId, name);
    if (settled.state === "succeeded") return { kind: "updated", version: check.latestVersion, detail: settled.detail };
    return { kind: "failed", reason: settled.detail ?? settled.state };
  }

  /** The omp-ui step: stage through the member's own updater, then arm install-at-next-quit. */
  async #updateAllApp(member: FleetUpdateAllMember, name: string): Promise<FleetUpdateAllStep> {
    const checked = await this.updateMachine(member.machineKey, updateAllRequest("app", "check"));
    if (checked.status === "refused") return { kind: "skipped", reason: checked.reason };
    if (!("check" in checked) || checked.check.target !== "app") return { kind: "failed", reason: `${name} answered the omp-ui check without one` };
    let latest = checked.check.latestVersion;
    if (!checked.check.staged) {
      const started = await this.updateMachine(member.machineKey, updateAllRequest("app", "stage"));
      if (started.status === "refused") return { kind: "skipped", reason: started.reason };
      if (!("jobId" in started)) return { kind: "failed", reason: `${name} started no omp-ui job` };
      const settled = await this.#updateAllSettle(member, started.jobId, name);
      if (settled.state !== "succeeded") {
        // An up-to-date train settles the staging job failed with the shared detail.
        if (settled.detail === FLEET_APP_NO_RELEASE_DETAIL) return { kind: "current", version: checked.check.currentVersion };
        return { kind: "failed", reason: settled.detail ?? settled.state };
      }
      // The job's detail reads "app staged <version>".
      latest = /(\d+\.\d+\.\d+\S*)$/.exec(settled.detail ?? "")?.[1] ?? latest;
    } else if (checked.check.installOnQuit) {
      return { kind: "updated", version: latest, detail: "already staged and armed for the next quit" };
    }
    // Accepting the Update all gate is the "Install when I quit" choice for
    // members with live sessions: they keep running until that member quits.
    const armed = await this.updateMachine(member.machineKey, { ...updateAllRequest("app", "apply"), allowLiveSessions: true });
    if (armed.status === "refused") return { kind: "failed", reason: armed.reason };
    return { kind: "updated", version: latest, detail: "staged; installs at that machine's next quit" };
  }

  /**
   * Long-poll one started job until it settles. The member caps a job at
   * 10 minutes, so this always ends; a refusal (the job is gone) or three
   * unanswered polls in a row read as a failure.
   */
  async #updateAllSettle(
    member: FleetUpdateAllMember,
    jobId: string,
    name: string,
  ): Promise<{ state: "succeeded" | "failed" | "revoked"; detail: string | null }> {
    let misses = 0;
    for (;;) {
      const polled = await this.#memberCall<FleetUpdatePollOutcome>(
        member.machineKey,
        CH.fleetUpdatePoll,
        [{ requester: this.requester("user", null), jobId, waitMs: FLEET_EXEC_POLL_WAIT_MAX_MS }],
        name,
      );
      if (polled.status === "refused") {
        if (/^no answer from /.test(polled.reason) && ++misses < 3) continue;
        return { state: "failed", detail: fleetUpdateSkew(polled, name).reason };
      }
      misses = 0;
      if (polled.state !== "running") return { state: polled.state, detail: polled.detail };
      member.progress = polled.progress?.percent ?? null;
    }
  }

  /** Forget one member's chip and its survival flag; the member's own job is untouched. */
  #dropMaintenance(machineKey: string): void {
    this.#maintenance.delete(machineKey);
    this.#settledShowing.delete(machineKey);
  }

  /**
   * One immediate poll of the recorded job while building a machine row;
   * null when no chip should show. A refusal, timeout, or lost member drops
   * the entry silently — the job itself stays on the member's registry.
   */
  async #maintenancePoll(machineKey: string): Promise<FleetMaintenanceRecord | null> {
    const entry = this.#maintenance.get(machineKey);
    if (entry === undefined) return null;
    const req: FleetUpdatePollRequest = { requester: this.requester("user", null), jobId: entry.jobId, waitMs: 0 };
    let answer: FleetUpdatePollOutcome | typeof TIMED_OUT;
    try {
      answer = await within(
        this.#deps.request(machineKey, CH.fleetUpdatePoll, [req]) as Promise<FleetUpdatePollOutcome>,
        MAINTENANCE_POLL_DEADLINE_MS,
      );
    } catch {
      answer = TIMED_OUT;
    }
    if (answer === TIMED_OUT || answer.status !== "accepted") {
      this.#dropMaintenance(machineKey);
      return null;
    }
    const record: FleetMaintenanceRecord = {
      jobId: answer.jobId,
      target: entry.target,
      state: answer.state,
      progress: answer.progress?.percent ?? null,
      detail: answer.detail,
      at: this.#now(),
    };
    const shownOnce = this.#settledShowing.has(machineKey);
    if (record.state === "running") {
      this.#maintenance.set(machineKey, record);
      this.#settledShowing.delete(machineKey);
      return record;
    }
    // A settled job rides exactly one more machines() poll — enough for the
    // view to catch succeeded/failed/revoked after the transition poll showed
    // it once — and then drops here. The job itself stays on the member.
    this.#maintenance.set(machineKey, record);
    this.#settledShowing.add(machineKey);
    if (shownOnce) this.#dropMaintenance(machineKey);
    return record;
  }

  /** One member call inside the agent deadline; every failure reads as a refusal. */
  async #memberCall<Outcome>(machineKey: string, channel: string, args: unknown[], name: string): Promise<Outcome | { status: "refused"; reason: string }> {
    try {
      const answer = await within(this.#deps.request(machineKey, channel, args), MEMBER_CALL_DEADLINE_MS);
      if (answer === TIMED_OUT) return { status: "refused", reason: `no answer from ${name} within ${MEMBER_CALL_DEADLINE_MS / 1000} s` };
      return answer as Outcome;
    } catch (err) {
      return { status: "refused", reason: messageOf(err) };
    }
  }
}
