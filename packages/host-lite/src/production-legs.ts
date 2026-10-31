import { CH, type Registry } from "@omp-ui/core";
import { registerFleetLegs, type FleetLegsHandle } from "./fleet-legs";
import {
  createAuditFileSink,
  createExecLegs,
  createHostReportLegs,
  createProjectLegs,
  createTerminalLegs,
} from "./fleet-legs/adapters-node";
import type { LiteBackend } from "./lite-backend";
import type { LiteSessions } from "./seams";

/**
 * The production fleet member legs (issue #1010 integration): the one place that
 * builds S4's adapter seams on real node machinery and hands `registerFleetLegs`
 * a complete {@link FleetLegsHandle}. Kept out of `serve.ts` so the boot pipeline
 * stays deterministically testable (serve just threads whatever handle it is
 * given); the production CLI (`omp-lite serve`) calls this and passes the result.
 *
 * A failure here never kills the member: the caller degrades to a legs-absent
 * boot (owners see `unknown channel` on every fleet:*, exactly what an unupgraded
 * desktop gives), so a box with broken exec still joins and gets watched.
 */
export interface ProductionFleetLegsDeps {
  registry: Registry;
  sessions: LiteSessions;
  /** The live backend, for the terminal fan-out and grant-write rebroadcast. */
  backend: LiteBackend;
  /** Audit ring + file sink land under `<dataDir>/logs`. */
  dataDir: string;
  version: string;
  /** Session-bundle artifact override (tests build one on demand); production uses the installed default. */
  bundlePath?: string;
}

export async function buildProductionFleetLegs(deps: ProductionFleetLegsDeps): Promise<FleetLegsHandle> {
  const { registry, sessions, backend, dataDir, version, bundlePath } = deps;
  const auditSink = await createAuditFileSink(`${dataDir}/logs`, { ...(bundlePath !== undefined ? { bundlePath } : {}) });
  const [exec, terminals] = await Promise.all([
    createExecLegs({ ...(bundlePath !== undefined ? { bundlePath } : {}), onExecFinish: auditSink }),
    createTerminalLegs({
      // Member terminal events fan to joined owners' sockets, never a window.
      sendToClients: (channel, args) => backend.emit(channel, args),
      onTerminalEnd: auditSink,
      ...(bundlePath !== undefined ? { bundlePath } : {}),
    }),
  ]);
  return registerFleetLegs({
    registry,
    version,
    exec,
    terminals,
    // A lite member registers a dispatched project straight into its registry.
    project: createProjectLegs({ addProject: async (dir) => void registry.addProject(dir) }),
    host: createHostReportLegs({
      registry,
      activity: () => sessions.activity?.() ?? { liveSessions: 0, runningTurns: 0 },
      // Fail-closed exactly as the adapter doc demands: a guessed `true` ships
      // the owner's dispatch to a machine that cannot run it. No sessions seam
      // (bare registry member) therefore reports not-ready for every project.
      providerReady: (cwd) => sessions.providerReady?.(cwd) ?? false,
    }),
    auditSink,
    // A grant write changes placement-relevant state; re-broadcast the merged
    // full BackendState so owners' machine lists refresh without a poll.
    stateChanged: () => {
      void backend
        .state()
        .then((state) => backend.emit(CH.onStateChanged, [state]))
        .catch(() => {});
    },
  });
}
