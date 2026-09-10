import type { OmpBackend } from "@omp-ui/core/types";
import { makeBackendClient } from "@omp-ui/core/backend-channels";

// The only module touching window.ompBackend (ADR-0002) — components import
// this, never the global.
export const backend: OmpBackend = window.ompBackend;

const instanceBackends = new Map<string, OmpBackend>();

/**
 * A backend addressed to one joined remote instance (issue #416). Requests
 * and notifies ride the local backend's proxy channels; the host forwards the
 * allowlisted ones to that instance. Events never come this way — the host
 * mirrors a remote's tab events onto the local backend, so `on` is
 * a programming error, not a fallback.
 */
export function instanceBackend(instanceId: string): OmpBackend {
  let client = instanceBackends.get(instanceId);
  if (client === undefined) {
    client = makeBackendClient({
      request: <Args extends unknown[], Result>(channel: string, args: Args) =>
        backend.remoteInstanceRequest(instanceId, channel, args) as Promise<Result>,
      notify: (channel, args) => backend.remoteInstanceNotify(instanceId, channel, args),
      on: () => {
        throw new Error("events are delivered on the local backend");
      },
    });
    instanceBackends.set(instanceId, client);
  }
  return client;
}

/** The backend that owns a project path: the local one for null, else the instance's. */
export function backendFor(instanceId: string | null): OmpBackend {
  return instanceId === null ? backend : instanceBackend(instanceId);
}

/**
 * One display form for a failed call. The host answers over the WebSocket with the bare message;
 * the desktop adapter still rides ipcRenderer.invoke, which wraps main-process errors (#16
 * precedent) — unwrap that so both read the same.
 */
export function displayMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}
