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
  LOCAL_MACHINE_KEY,
  PLACEMENT_WEIGHT,
  choosePlacement,
  deriveFleetTitle,
  eligibleMachineCount,
  fleetMachineName,
  fleetSessionState,
  mintBranchName,
  parseFleetDispatchRequest,
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
  type RemoteInstanceSummary,
  type SessionSummary,
} from "@omp-ui/core";

/** A joined member's report must arrive inside this window, or the member reads as an error. */
const HOST_REPORT_TIMEOUT_MS = 4_000;
/** Each status summary races this window; a slow owner reads "summary unavailable". */
const SUMMARY_TIMEOUT_MS = 5_000;
const TIMED_OUT = Symbol("timed out");

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

export class FleetDispatcher {
  readonly #deps: FleetDispatcherDeps;
  readonly #now: () => number;
  readonly #uuid: () => string;
  /** Unknown outcomes by dispatchId; in memory only (BackendState.fleetPending). */
  readonly #pending = new Map<string, FleetPendingDispatch>();

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
      }),
      (err: unknown): FleetMachine => ({
        key: LOCAL_MACHINE_KEY,
        nickname: null,
        status: "error",
        error: messageOf(err),
        preference: preferences[LOCAL_MACHINE_KEY] ?? "normal",
        report: null,
        receivedAt: null,
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
    };
    if (remote.status !== "joined") return machine;
    try {
      const report = await within(
        this.#deps.request(remote.id, CH.fleetHostReport, []) as Promise<FleetHostReport>,
        HOST_REPORT_TIMEOUT_MS,
      );
      if (report === TIMED_OUT) {
        return { ...machine, status: "error", error: `no host report within ${HOST_REPORT_TIMEOUT_MS / 1000} s` };
      }
      return { ...machine, status: "ready", error: null, report, receivedAt: this.#now() };
    } catch (err) {
      const message = messageOf(err);
      if (message.includes("unknown channel")) {
        return { ...machine, status: "unsupported", error: "update omp-ui on this instance to use Fleet" };
      }
      return { ...machine, status: "error", error: message };
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
        let unknown: string;
        try {
          const answer = opts.deadlineMs === undefined ? await work : await within(work, opts.deadlineMs);
          if (answer !== TIMED_OUT) {
            this.#pending.delete(dispatchId);
            return { ...base, status: "started", tabId: answer.tabId };
          }
          unknown = `no answer within ${Math.round(opts.deadlineMs! / 1000)} s; the session may still start`;
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
}
