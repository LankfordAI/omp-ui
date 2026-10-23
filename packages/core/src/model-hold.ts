import * as net from "node:net";
import { readModelsFileProviderBaseUrl } from "./models-file";
import type { ModelHold } from "./types";

/**
 * The spawn-time reachability probe behind a model hold (#932). omp blocks
 * its boot on the pinned model's provider discovery, and an endpoint that
 * drops packets (a LAN gateway seen from off-network) stalls that boot past
 * omp-ui's ready timeout, so no fresh session can start at all. A short TCP
 * connect to the provider's models.yml `baseUrl` answers "reachable?" before
 * the spawn; an unreachable one boots unpinned and the session is held.
 *
 * Only providers with a models.yml `baseUrl` are probed: built-in cloud
 * providers have no endpoint here and are never held.
 */

/** Long enough for a LAN or VPN handshake, short enough to sit inside spawn. */
export const MODEL_HOLD_PROBE_MS = 1500;

/** `host:port` of an http(s) URL, defaulting the port by scheme; null if unparseable. */
export function endpointAddress(baseUrl: string): { host: string; port: number } | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  // URL keeps IPv6 hosts bracketed; net.connect wants them bare.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return host === "" ? null : { host, port };
}

/** True when a TCP connection to the address opens within the deadline. */
export function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export interface ModelHoldDeps {
  baseUrlFor?: (providerId: string) => string | null;
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

/**
 * The hold a spawn pinned to `model` (a `provider/id` selector) needs, or null
 * when its provider has no models.yml endpoint or the endpoint answers.
 */
export async function resolveModelHold(
  model: string,
  deps: ModelHoldDeps = {},
): Promise<ModelHold | null> {
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const provider = model.slice(0, slash);
  const baseUrl = (deps.baseUrlFor ?? ((id) => readModelsFileProviderBaseUrl(id)))(provider);
  if (baseUrl === null) return null;
  const address = endpointAddress(baseUrl);
  if (address === null) return null;
  const reachable = await (deps.probe ?? probeTcp)(address.host, address.port, MODEL_HOLD_PROBE_MS);
  if (reachable) return null;
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return { model, provider, endpoint: `${host}:${address.port}` };
}
