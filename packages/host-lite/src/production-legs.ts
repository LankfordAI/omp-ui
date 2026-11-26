import { CH, resolveProjectPath, resolveRepositoryKey, type Registry } from "@omp-ui/core";
import { registerFleetLegs, type FleetLegsHandle } from "./fleet-legs";
import {
  createAuditFileSink,
  createContainerUpdateLegs,
  createExecLegs,
  createHostReportLegs,
  createProjectLegs,
  createTerminalLegs,
} from "./fleet-legs/adapters-node";
import type { LiteBackend } from "./lite-backend";
import { isLiteContainerized } from "./production-sessions";
import type { LiteSessions } from "./seams";

/**
 * The production fleet member legs (issue #1010 integration): the one place that
 * builds S4's adapter seams on real node machinery and hands `registerFleetLegs`
 * a complete {@link FleetLegsHandle}. Kept out of `serve.ts` so the boot pipeline
 * stays deterministically testable (serve just threads whatever handle it is
 * given); the production CLI (`omp-ui-lite serve`) calls this and passes the result.
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
  env?: NodeJS.ProcessEnv;
}

export async function buildProductionFleetLegs(deps: ProductionFleetLegsDeps): Promise<FleetLegsHandle> {
  const { registry, sessions, backend, dataDir, version, bundlePath } = deps;
  const env = deps.env ?? process.env;
  const containerized = isLiteContainerized(env);
  const activity = () => sessions.activity?.() ?? { liveSessions: 0, runningTurns: 0 };
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
    // Route fleet clone/register through the bundle's unified registration path
    // (repositoryKey + head watcher + state:changed), with a fallback for bare
    // test fakes that do not expose sessions.addProject.
    project: createProjectLegs({
      addProject: async (dir) => {
        if (sessions.addProject !== undefined) {
          await sessions.addProject(dir);
          return;
        }
        const resolved = await resolveProjectPath(dir);
        const record = registry.addProject(resolved);
        const key = await resolveRepositoryKey(resolved).catch(() => null);
        if (key !== null && key !== record.repositoryKey) {
          registry.setProjectRepositoryKey(resolved, key);
        }
        const state = await backend.state();
        backend.emit(CH.onStateChanged, [state]);
      },
    }),
    ...(sessions.fleetSessions !== undefined ? { sessions: sessions.fleetSessions } : {}),
    ...(sessions.providerKeys !== undefined ? { providerKeys: sessions.providerKeys } : {}),
    host: createHostReportLegs({
      registry,
      activity,
      // Fail-closed exactly as the adapter doc demands: a guessed `true` ships
      // the owner's dispatch to a machine that cannot run it. No sessions seam
      // (bare registry member) therefore reports not-ready for every project.
      providerReady: (cwd) => sessions.providerReady?.(cwd) ?? false,
      env,
      packageFormat: containerized ? "container" : null,
    }),
    ...(containerized ? { update: createContainerUpdateLegs({ version, env, activity }) } : {}),
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
