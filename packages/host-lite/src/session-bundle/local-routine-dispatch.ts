import { randomUUID } from "node:crypto";
import {
  LOCAL_MACHINE_KEY,
  deriveFleetTitle,
  mintBranchName,
  parseFleetDispatchRequest,
  parseFleetModelChoice,
  validateFleetTitle,
  worktreeBranchPrefix,
  type FleetDispatchOutcome,
  type FleetDispatchRequest,
  type FleetDispatchResult,
  type NewRpcSpawnRequest,
  type Registry,
  type SessionRoutine,
  type SpawnAnswer,
} from "@omp-ui/core";

/**
 * Local-only RoutineScheduler dispatcher for Host Lite (issue #1368, ADR-0100).
 *
 * Mirrors `FleetDispatcher.dispatch` for local routine fires (`LOCAL_MACHINE_KEY`)
 * without needing owner-side remote-instance machinery. Races `spawnLocal`
 * against `deadlineMs` and settles any late-resolving orphan spawn so no
 * unlinked routine run can survive a deadline timeout.
 */
export interface LocalRoutineDispatchDeps {
  registry: Pick<Registry, "projects" | "getSetting">;
  instanceId: () => string;
  machineLabel: () => string;
  providerReady: (projectCwd: string) => boolean;
  spawnLocal: (req: NewRpcSpawnRequest) => Promise<SpawnAnswer>;
  /** Reaps a session whose spawn resolved after deadlineMs so no unlinked routine run survives. */
  settleOrphan: (tabId: string) => Promise<unknown>;
  uuid?: () => string;
}

const TIMED_OUT = Symbol("local-routine-dispatch-timeout");

export function createLocalRoutineDispatch(
  deps: LocalRoutineDispatchDeps,
): (
  raw: FleetDispatchRequest,
  who: { kind: "routine"; routine: SessionRoutine },
  opts: { deadlineMs: number },
) => Promise<FleetDispatchResult> {
  const uuid = deps.uuid ?? randomUUID;

  return async (raw, who, opts): Promise<FleetDispatchResult> => {
    const req = parseFleetDispatchRequest(raw);
    if (req.targets.kind !== "explicit") {
      throw new Error("routines only target local projects");
    }

    const title = validateFleetTitle(req.title?.trim() || deriveFleetTitle(req.prompt));
    const requestedBy = {
      instanceId: deps.instanceId(),
      label: deps.machineLabel(),
      kind: "routine" as const,
      sourceTabId: null,
    };

    const outcomes = await Promise.all(
      req.targets.picks.map(async (pick): Promise<FleetDispatchOutcome> => {
        const dispatchId = uuid();
        const base = { dispatchId, machineKey: pick.machineKey, projectCwd: pick.projectCwd };

        if (pick.machineKey !== LOCAL_MACHINE_KEY) {
          return { ...base, status: "failed", message: "routines only target local projects" };
        }

        const project = deps.registry.projects.find((p) => p.path === pick.projectCwd);
        if (project === undefined) {
          return { ...base, status: "failed", message: `this computer has no project ${pick.projectCwd}` };
        }

        if (!deps.providerReady(pick.projectCwd)) {
          return { ...base, status: "failed", message: "no model provider on this computer" };
        }

        // Advisor inheritance matches Host Lite's fleet-legs/adapters-node.ts:
        // deliberately omits desktop's advisorDefaults() probe so omp uses its own default when unpinned.
        const advisor = project.lastAdvisor ?? deps.registry.getSetting("defaultAdvisor");
        const advisorModel = project.defaultAdvisorModel ?? project.lastAdvisorModel ?? null;

        const spawn: NewRpcSpawnRequest = {
          origin: "new",
          mode: "rpc-ui",
          projectCwd: pick.projectCwd,
          cols: 80,
          rows: 24,
          advisor,
          advisorModel,
          planMode: req.planMode,
          private: true,
          worktree:
            req.workspace === "worktree"
              ? {
                  mint: {
                    branch: mintBranchName(worktreeBranchPrefix(pick.projectCwd)),
                    baseRef: null,
                    baseBranch: null,
                  },
                }
              : null,
          fleet: {
            dispatchId,
            batchId: null,
            title,
            prompt: req.prompt,
            requestedBy,
            ...(req.model === undefined ? {} : { model: req.model }),
            ...(req.thinkingLevel === undefined ? {} : { thinkingLevel: req.thinkingLevel }),
            routine: who.routine,
          },
        };

        const spawnPromise = deps.spawnLocal(spawn);
        const deadline = Promise.withResolvers<typeof TIMED_OUT>();
        const timer = setTimeout(() => deadline.resolve(TIMED_OUT), opts.deadlineMs);
        timer.unref?.();

        let timedOut = false;
        try {
          const race = await Promise.race([spawnPromise, deadline.promise]);
          if (race === TIMED_OUT) {
            timedOut = true;
            void spawnPromise.then(
              (late) => {
                void deps.settleOrphan(late.tabId).catch((err: unknown) => {
                  console.warn(`[host-lite] failed to settle late routine spawn ${late.tabId}:`, err);
                });
              },
              () => {
                // Late rejection after timeout: nothing spawned to settle.
              },
            );
            return {
              ...base,
              status: "unknown",
              message: `no answer within ${Math.round(opts.deadlineMs / 1000)} s; the session may still start`,
            };
          }
          return {
            ...base,
            status: "started",
            tabId: race.tabId,
            choice: parseFleetModelChoice(race.choice),
          };
        } catch (err) {
          if (timedOut) {
            return {
              ...base,
              status: "unknown",
              message: `no answer within ${Math.round(opts.deadlineMs / 1000)} s; the session may still start`,
            };
          }
          return { ...base, status: "failed", message: err instanceof Error ? err.message : String(err) };
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    return { batchId: null, outcomes };
  };
}
