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
  FLEET_RUNGS,
  LOCAL_MACHINE_KEY,
  PLACEMENT_WEIGHT,
  choosePlacement,
  deriveFleetTitle,
  eligibleMachineCount,
  fleetMachineName,
  fleetMemberAddress,
  fleetSessionState,
  fleetToolExecPollRequest,
  fleetToolExecRequest,
  fleetToolMachineKey,
  mintBranchName,
  parseFleetDispatchRequest,
  parseFleetHostOs,
  parseFleetPackageManagers,
  validateFleetTitle,
  worktreeBranchPrefix,
  type FleetDispatchOutcome,
  type FleetDispatchRequest,
  type FleetDispatchResult,
  type FleetHostProject,
  type FleetHostReport,
  type FleetMachine,
  type FleetPendingDispatch,
  type NewRpcSpawnRequest,
  type PlacementCandidate,
  type PlacementPreference,
  type FleetToolExecArgs,
  type FleetToolExecPollArgs,
  type FleetToolProjectArgs,
  type RemoteInstanceSummary,
  type SessionSummary,
  type FleetDetachedExecRequest,
  type FleetDetachedExecStartOutcome,
  type FleetExecOutcome,
  type FleetExecPollOutcome,
  type FleetExecPollRequest,
  type FleetExecRequest,
  type FleetGrantRaiseOutcome,
  type FleetGrantRaiseRequest,
  type FleetProjectManageOutcome,
  type FleetProjectManageRequest,
  type FleetProviderKeyEntry,
  type FleetProviderKeysOutcome,
  type FleetProviderKeysRequest,
  type FleetRequester,
  type FleetRung,
} from "@omp-ui/core";

/** A joined member's report must arrive inside this window, or the member reads as an error. */
const HOST_REPORT_TIMEOUT_MS = 4_000;
/** The rung probe races this window; an older or slow peer reads grantRung null. */
const GRANT_PROBE_TIMEOUT_MS = 4_000;
/** Each status summary races this window; a slow owner reads "summary unavailable". */
const SUMMARY_TIMEOUT_MS = 5_000;
/** Exec/project/grant calls race this bound: inside the 60 s host-answer watchdog. */
const MEMBER_CALL_DEADLINE_MS = 45_000;
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
  spawnLocal(req: NewRpcSpawnRequest): Promise<{ tabId: string }>;
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

export class FleetDispatcher {
  readonly #deps: FleetDispatcherDeps;
  readonly #now: () => number;
  readonly #uuid: () => string;
  /** Unknown outcomes by dispatchId; in memory only (BackendState.fleetPending). */
  readonly #pending = new Map<string, FleetPendingDispatch>();
  /** Cached port-22 probes by member address (issue #904). */
  readonly #sshProbes = new Map<string, { at: number; value: Promise<boolean> }>();

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
      }),
    );
    const remotes = this.#deps
      .remotes()
      .filter((remote) => remote.status !== "self")
      .map((remote) => this.#remoteMachine(remote, preferences[remote.id] ?? "normal"));
    return Promise.all([local, ...remotes]);
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
    };
    if (remote.status !== "joined") return machine;
    // The port probe runs beside the report request, so a filtered port never
    // stretches machines() past the slower of the two bounds.
    const ssh = machine.address === null ? Promise.resolve(null) : this.#sshReachable(machine.address);
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
        };
      }
      const [grantRung, sshReachable] = await Promise.all([this.#probeRung(remote.id), ssh]);
      // A member that predates #904 sends neither user nor projectRoots; one
      // that predates #905 sends neither os nor packageManagers.
      const normalized: FleetHostReport = {
        ...report,
        user: typeof report.user === "string" && report.user !== "" ? report.user : null,
        projectRoots: Array.isArray(report.projectRoots) ? report.projectRoots : null,
        os: parseFleetHostOs(report.os),
        packageManagers: parseFleetPackageManagers(report.packageManagers),
      };
      return { ...machine, status: "ready", error: null, report: normalized, receivedAt: this.#now(), grantRung, sshReachable };
    } catch (err) {
      const message = messageOf(err);
      if (message.includes("unknown channel")) {
        return {
          ...machine,
          status: "unsupported",
          error: "update omp-ui on this instance to use Fleet",
          sshReachable: await ssh,
        };
      }
      return { ...machine, status: "error", error: message, sshReachable: await ssh };
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
    who: { kind: "user" } | { kind: "agent"; sourceTabId: string },
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
      sourceTabId: who.kind === "agent" ? who.sourceTabId : null,
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
          fleet: { dispatchId, batchId, title, prompt: req.prompt, requestedBy },
        };
        const local = target.machineKey === LOCAL_MACHINE_KEY;
        const work = local
          ? this.#deps.spawnLocal(spawn)
          : (this.#deps.request(target.machineKey, CH.spawnSession, [spawn]) as Promise<{ tabId: string }>);
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
            return { ...base, status: "started", tabId: answer.tabId };
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
    if (pendingAdded) await this.#deps.broadcast();
    return { batchId, outcomes };
  }

  #resolveTargets(req: FleetDispatchRequest, machines: FleetMachine[]): ResolvedTarget[] {
    const byKey = new Map(machines.map((m) => [m.key, m]));
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
      .filter((h) => h.project.providerReady)
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
        `Only ${eligibleMachineCount(candidates, now)} fleet machines can take this work now (needs: same repository, a ready model provider, CPU under 95%, more than 5% memory free). Choose machines manually.`,
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
  async statusText(sel: { batchId: string } | { dispatchId: string }): Promise<string> {
    const matches = (f: { batchId: string | null; dispatchId: string }): boolean =>
      "batchId" in sel ? f.batchId === sel.batchId : f.dispatchId === sel.dispatchId;
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
        const head = `- ${fleetMachineName({ nickname })} · ${summary.title} · ${state} (dispatch ${summary.fleet!.dispatchId}, tab ${summary.tabId})`;
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
