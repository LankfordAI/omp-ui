import type { AppUpdateState, ProjectOpenAvailability, ProjectOpenTarget } from "./types";
import {
  event,
  notify,
  request,
  type BackendTransport,
  type EventChannel,
  type NotifyChannel,
  type RequestChannel,
} from "./backend-channels";
import {
  arrayOf,
  bool,
  nullable,
  projectOpenTargetCodec,
  str,
  type ArgCodec,
} from "./backend-arg-codecs";

/**
 * The renderer ↔ desktop-client seam (issue #454). A client effect is an action only the
 * UI client can perform on its own machine (#444): window chrome, path and project opening,
 * external links, save dialogs, the banner gate, and the client's own artifact update.
 * The host never implements any of these; a browser client has no adapter at all.
 */
export const DESKTOP_CHANNELS = {
  setWindowChrome: {
    channel: "desktop:setChrome",
    ...request<[background: string, symbol: string], void>([str(), str()]),
  },
  openPath: { channel: "desktop:openPath", ...request<[absPath: string], void>([str()]) },
  showPathInFolder: {
    channel: "desktop:showInFolder",
    ...request<[absPath: string], void>([str()]),
  },
  openExternal: { channel: "desktop:openExternal", ...request<[url: string], void>([str()]) },
  getProjectOpenAvailability: {
    channel: "desktop:projectOpenAvailability",
    ...request<[], ProjectOpenAvailability>([]),
  },
  openProject: {
    channel: "desktop:openProject",
    ...request<[projectPath: string, target: ProjectOpenTarget], void>([
      str(),
      projectOpenTargetCodec,
    ]),
  },
  chooseSavePath: {
    channel: "desktop:chooseSavePath",
    ...request<[defaultName: string, extensions: string[]], string | null>([
      str(),
      arrayOf(str()),
    ]),
  },
  /** This window's viewed tab, for its own banner gate (#453). Distinct from the host's tab:viewed. */
  viewedTab: {
    channel: "desktop:viewedTab",
    ...notify<[tabId: string | null]>([nullable(str())]),
  },
  /** A banner click in this client: surface the tab here and nowhere else (#453). */
  onSurfaceTab: { channel: "desktop:surfaceTab", ...event<[tabId: string]>() },
  getAppUpdateState: {
    channel: "desktop:update:getState",
    ...request<[], AppUpdateState>([]),
  },
  checkAppUpdate: { channel: "desktop:update:check", ...request<[], AppUpdateState>([]) },
  downloadAppUpdate: { channel: "desktop:update:download", ...request<[], void>([]) },
  openAppUpdateReleaseNotes: {
    channel: "desktop:update:openNotes",
    ...request<[], void>([]),
  },
  showAppUpdateDownload: {
    channel: "desktop:update:showDownload",
    ...request<[], void>([]),
  },
  /** No confirmation step: quitting the client stops no session (#455 §4). */
  restartForAppUpdate: { channel: "desktop:update:restart", ...request<[], void>([]) },
  setAppUpdateInstallOnQuit: {
    channel: "desktop:update:installOnQuit",
    ...request<[on: boolean], void>([bool()]),
  },
  dismissAppUpdate: {
    channel: "desktop:update:dismiss",
    ...request<[version: string, remember: boolean], void>([str(), bool()]),
  },
  onAppUpdateState: {
    channel: "desktop:update:state",
    ...event<[state: AppUpdateState]>(),
  },
} as const;

export type DesktopChannelSpec = typeof DESKTOP_CHANNELS;
export type DesktopMethodName = keyof DesktopChannelSpec;

/** Channel strings keyed by method name, like CH for the backend. */
export const DCH = Object.fromEntries(
  Object.entries(DESKTOP_CHANNELS).map(([m, d]) => [m, d.channel]),
) as { readonly [M in DesktopMethodName]: DesktopChannelSpec[M]["channel"] };

type Method<D> =
  D extends RequestChannel<infer A, infer R>
    ? (...args: A) => Promise<R>
    : D extends NotifyChannel<infer A>
      ? (...args: A) => void
      : D extends EventChannel<infer A>
        ? (cb: (...args: A) => void) => void
        : never;

/** The one client-effect surface. Present only inside a desktop client. */
export type DesktopAdapter = {
  readonly [M in DesktopMethodName]: Method<DesktopChannelSpec[M]>;
};

const codecsByChannel = new Map<string, readonly ArgCodec<unknown>[]>();
for (const d of Object.values(DESKTOP_CHANNELS)) {
  if (d.kind !== "event") {
    codecsByChannel.set(d.channel, d.args as readonly ArgCodec<unknown>[]);
  }
}

/** Codecs by channel, for the main-side dispatcher (cutover); unused by the prototype's aliases. */
export const desktopArgCodecs: ReadonlyMap<string, readonly ArgCodec<unknown>[]> = codecsByChannel;

/**
 * Same loop as makeBackendClient (backend-channels.ts); the cutover generalizes both into
 * one makeChannelClient(spec, transport).
 */
export function makeDesktopAdapter(transport: BackendTransport): DesktopAdapter {
  const client: Record<string, (...args: never[]) => unknown> = {};
  for (const [method, d] of Object.entries(DESKTOP_CHANNELS)) {
    switch (d.kind) {
      case "request":
        client[method] = (...args) => transport.request<never[], never>(d.channel, args);
        break;
      case "notify":
        client[method] = (...args) => transport.notify(d.channel, args);
        break;
      case "event":
        client[method] = (...args) => transport.on(d.channel, args[0]);
        break;
    }
  }
  return client as DesktopAdapter;
}
