import { event, request, type BackendTransport } from "./backend-channels";
import { makeChannelClient, type ChannelClient } from "./channel-client";
import type { ArgCodec } from "./backend-arg-codecs";

/**
 * The preload bootstrap surface (issue #442 §11): how the Electron renderer
 * learns where the persistent host is before it has any backend at all. Main
 * resolves, probes, installs, and submits supervisor work; the renderer only
 * awaits `connection()` and then dials the WebSocket itself. Separate from both
 * `OmpBackend` and the desktop adapter — it exists only inside a desktop client
 * and is absent in browsers.
 */

/** What the renderer needs to dial the host's local control endpoint. */
export interface HostBootstrapConnection {
  /** `http://127.0.0.1:<port>` — the origin from `host.json`, no path. */
  endpoint: string;
  desktopCredential: string;
  /** This Electron build's version, for the desktop hello. */
  clientVersion: string;
  hostVersion: string;
}

export type HostBootstrapPhase = "probing" | "installing" | "starting" | "ready" | "failed";

export type HostSupervisorKind = "systemd-user" | "launchd-agent" | "windows-task";

export interface HostBootstrapStatus {
  phase: HostBootstrapPhase;
  /** Human-readable detail; on `failed`, the reason. */
  message: string | null;
  dataRoot: string;
  /** The desktop client's own log dir (`<userData>/logs`). */
  clientLogDir: string;
  /** `<dataRoot>/logs` — where the supervisor-started host writes. */
  hostLogDir: string;
  hostVersion: string | null;
  hostPid: number | null;
  /** Which supervisor identity a start was submitted through; null before any submission. */
  supervisor: HostSupervisorKind | null;
  /** The previous host version a rollback would restore, when the host reports one. */
  rollbackVersion: string | null;
}

export const HOST_BOOTSTRAP_CHANNELS = {
  /** Resolves once the host is reachable; rejects with the failed status message otherwise. */
  connection: {
    channel: "bootstrap:connection",
    ...request<[], HostBootstrapConnection>([]),
  },
  /** Runs the resolve → install → start sequence again from the top. */
  retry: { channel: "bootstrap:retry", ...request<[], void>([]) },
  status: { channel: "bootstrap:status", ...request<[], HostBootstrapStatus>([]) },
  /** Asks the live host to stop through its control credential; rejects when no record exists. */
  stop: { channel: "bootstrap:stop", ...request<[], void>([]) },
  /** Asks the live host to roll back to its previous version; rejects when no record exists. */
  rollback: { channel: "bootstrap:rollback", ...request<[], void>([]) },
  onStatus: { channel: "bootstrap:status", ...event<[status: HostBootstrapStatus]>() },
} as const;

export type HostBootstrapChannelSpec = typeof HOST_BOOTSTRAP_CHANNELS;
export type HostBootstrapMethodName = keyof HostBootstrapChannelSpec;

/** Channel strings keyed by method name, like DCH for the desktop adapter. */
export const BCH = Object.fromEntries(
  Object.entries(HOST_BOOTSTRAP_CHANNELS).map(([m, d]) => [m, d.channel]),
) as { readonly [M in HostBootstrapMethodName]: HostBootstrapChannelSpec[M]["channel"] };

/** `window.ompHostBootstrap`: present only inside a desktop client. */
export type HostBootstrap = ChannelClient<HostBootstrapChannelSpec>;

const codecsByChannel = new Map<string, readonly ArgCodec<unknown>[]>();
for (const d of Object.values(HOST_BOOTSTRAP_CHANNELS)) {
  if (d.kind !== "event") {
    codecsByChannel.set(d.channel, d.args as readonly ArgCodec<unknown>[]);
  }
}

/** Codecs by channel, for main's bootstrap dispatcher. */
export const hostBootstrapArgCodecs: ReadonlyMap<string, readonly ArgCodec<unknown>[]> =
  codecsByChannel;

/** The bootstrap surface, built from the shared spec like makeDesktopAdapter. */
export function makeHostBootstrap(transport: BackendTransport): HostBootstrap {
  return makeChannelClient(HOST_BOOTSTRAP_CHANNELS, transport);
}
