import * as net from "node:net";
import { readModelsFileProviderBaseUrl } from "./models-file";
import { ompChildEnv, spawnOmpOneShot, type OmpOneShotProcess, type OmpOneShotSpawn } from "./omp-process";
import type { ModelHold, NotFoundModelHold, UnreachableModelHold } from "./types";

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
): Promise<UnreachableModelHold | null> {
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
  return { reason: "unreachable", model, provider, endpoint: `${host}:${address.port}` };
}

/** The refusal a held session answers a turn with. */
export function modelHoldNotice(hold: ModelHold): string {
  if (hold.reason === "not-found") {
    return `omp could not find ${hold.model}, so this session started on a fallback model: ${hold.message} Pick a model to send.`;
  }
  return `${hold.provider} (${hold.endpoint}) is not reachable, so this session started without ${hold.model}. Pick a model to send.`;
}

/**
 * omp's boot warning when the `modelRoles.default` pin does not resolve and it
 * falls back to a model of its own choosing (#970). omp ≥ 18.14 rejects a
 * provider-qualified near match here, so a pin saved under an older catalog
 * lands in this branch; the session then runs on a model the user never chose.
 * The warning may be prefixed by an earlier one (`<a>. Default model …`).
 */
const DEFAULT_MODEL_NOT_FOUND_RE = /Default model (\S+) not found\. Using \S+/;

/** The not-found hold one omp stderr line describes, or null. */
export function parseModelNotFoundWarning(line: string): NotFoundModelHold | null {
  const match = DEFAULT_MODEL_NOT_FOUND_RE.exec(line);
  if (match === null) return null;
  return { reason: "not-found", model: match[1]!, message: line.replace(/^Warning:\s*/, "").trim() };
}

/** Long enough for omp to load its catalog; it fails a bad selector in under a second. */
export const MODEL_SELECTOR_PROBE_MS = 10_000;

export interface ModelSelectorProbeOpts {
  ompPath: string;
  /** The project dir, so omp layers the same config the session does. */
  cwd: string;
  selector: string;
  spawn?: OmpOneShotSpawn;
  timeoutMs?: number;
}

/**
 * omp's own error for a selector, with its "Did you mean …?" suggestions —
 * the text omp prints when `--model` cannot resolve. The boot warning for a
 * stale `modelRoles.default` pin carries no suggestions, so a not-found hold
 * asks omp's `--model` resolver once. A bare rpc boot with every discovery
 * switch off and stdin closed: a bad selector exits non-zero before ready, a
 * good one boots and exits on EOF. Resolves null when omp accepts the
 * selector, prints no "not found" line, or does not answer in time.
 */
export function readModelSelectorError(opts: ModelSelectorProbeOpts): Promise<string | null> {
  const argv = [
    "--mode=rpc",
    "--cwd",
    opts.cwd,
    "--no-session",
    "--no-tools",
    "--no-lsp",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--model",
    opts.selector,
  ];
  let child: OmpOneShotProcess;
  try {
    child = (opts.spawn ?? spawnOmpOneShot)(opts.ompPath, argv, ompChildEnv(opts.ompPath));
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, opts.timeoutMs ?? MODEL_SELECTOR_PROBE_MS);
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.onSpawnError(() => finish(null));
    child.onExit((code) => {
      if (code === 0) return finish(null);
      const line = stderr.split("\n").find((l) => / not found/.test(l));
      finish(line === undefined ? null : line.trim());
    });
  });
}
