import * as fs from "node:fs";
import * as path from "node:path";
import {
  dispatchNotify,
  dispatchRequest,
  NO_BREADCRUMBS,
  type AgentMode,
  type ChannelTable,
  type KeyCipher,
  type OwnedSessionRecord,
  type PlanFormat,
  type GlassChrome,
  type ProjectRecord,
  type RemoteBind,
  type SessionMode,
  type TranscriptWidth,
} from "@omp-ui/core";
import { HOST_PROTOCOL, type ConnectionContext } from "@omp-ui/server";
import type { AuthorityToken } from "../authority/authority";
import { HostApplication, type HostApplicationDeps, type HostPaths } from "../host-application";

/** The desktop client's connection id in these tests; any string a listener mints would do. */
export const DESKTOP_CONNECTION_ID = "conn-desktop";

/** A witness for tests that never claim `host.lock`: incarnation 0, touches no file. */
export function testAuthority(dataRoot: string): AuthorityToken {
  return { dataRoot, incarnation: 0 };
}

interface RegistrySettings {
  defaultMode: SessionMode;
  defaultAgentMode: AgentMode;
  defaultCompactionMethod: string | null;
  planFormat: PlanFormat;
  streamStallAbortSeconds: number;
  advisorAutoReply: boolean;
  stallAutoContinue: boolean;
  defaultAdvisor: boolean;
  modelFavorites: string[];
  skipDeleteConfirmation: boolean;
  sessionOrderFrozen: boolean;
  dismissedAppUpdateVersion: string | null;
  dismissedOmpUpdateVersion: string | null;
  themeId: string;
  fontFamilyId: string;
  transcriptWidth: TranscriptWidth;
  glassChrome: GlassChrome;
  localeId: string;
  appUpdateCheckOnLaunch: boolean;
  ompUpdateCheckOnLaunch: boolean;
  remoteEnabled: boolean;
  remoteBind: RemoteBind;
  remotePort: number;
  remoteToken: string;
  remotePasswordHash: string;
  remotePasswordSalt: string;
  instanceId: string;
}

interface RegistrySeed {
  schemaVersion: 1;
  settings: RegistrySettings;
  projects: ProjectRecord[];
  sessions: OwnedSessionRecord[];
}

interface RegistrySeedPatch {
  settings?: Partial<RegistrySettings>;
  projects?: ProjectRecord[];
  sessions?: OwnedSessionRecord[];
}

export function ownedSessionRecord(
  patch: Partial<OwnedSessionRecord> = {},
): OwnedSessionRecord {
  return {
    tabId: "tab-1",
    sessionId: null,
    lineageDir: "omp-ui--proj--11111111-2222-3333-4444-555555555555",
    projectCwd: "/proj",
    worktree: null,
    planImplementationSource: null,
    launchedAt: "2026-07-29T10:00:00.000Z",
    mode: "rpc-ui",
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    agentMode: "build",
    ...patch,
  };
}

export function seedRegistry(file: string, patch: RegistrySeedPatch = {}): void {
  const settings: RegistrySettings = {
    defaultMode: "rpc-ui",
    defaultAgentMode: "plan",
    planFormat: "html",
    defaultCompactionMethod: null,
    streamStallAbortSeconds: 180,
    advisorAutoReply: true,
    stallAutoContinue: true,
    defaultAdvisor: false,
    modelFavorites: [],
    skipDeleteConfirmation: false,
    // Default false so seeds without the marker exercise the one-time
    // recency freeze exactly like pre-#274 registries do.
    sessionOrderFrozen: false,
    dismissedAppUpdateVersion: null,
    dismissedOmpUpdateVersion: null,
    themeId: "graphite",
    fontFamilyId: "default",
    transcriptWidth: "wide",
    glassChrome: "subtle",
    localeId: "en",
    appUpdateCheckOnLaunch: true,
    ompUpdateCheckOnLaunch: true,
    remoteEnabled: false,
    remoteBind: "localhost",
    remotePort: 4677,
    remoteToken: "",
    remotePasswordHash: "",
    remotePasswordSalt: "",
    instanceId: "",
    ...patch.settings,
  };
  settings.modelFavorites = [...settings.modelFavorites];

  const data: RegistrySeed = {
    schemaVersion: 1,
    settings,
    projects: (patch.projects ?? []).map((project) => ({ ...project })),
    sessions: (patch.sessions ?? []).map((session) => ({ ...session })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** A desktop client's connection, as the local listener mints it for the desktop credential. */
export function desktopConnection(patch: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    id: DESKTOP_CONNECTION_ID,
    role: "desktop",
    local: true,
    control: false,
    clientKind: "desktop",
    clientVersion: "0.0.0",
    protocolVersion: HOST_PROTOCOL,
    ...patch,
  };
}

/** A remote connection with a protocol-2 hello behind it. */
export function remoteConnection(patch: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    id: "conn-remote",
    role: "browser",
    local: false,
    control: false,
    clientKind: "browser",
    clientVersion: "0.0.0",
    protocolVersion: HOST_PROTOCOL,
    ...patch,
  };
}

/** A reversible stand-in for the platform cipher: the key store round-trips, nothing is secret. */
export const TEST_CIPHER: KeyCipher = {
  available: true,
  backend: "test",
  encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
  decrypt: (blob) => blob.toString("utf8").replace(/^enc:/, ""),
};

/** Every store beside the registry, the way the host lays them out under its data root. */
export function hostPaths(registryFile: string, patch: Partial<HostPaths> = {}): HostPaths {
  const dataRoot = path.dirname(registryFile);
  return {
    dataRoot,
    registryFile,
    providerKeysFile: path.join(dataRoot, "provider-keys.json"),
    remoteInstancesFile: path.join(dataRoot, "remote-instances.json"),
    worktreesRoot: path.join(dataRoot, "worktrees"),
    oauthScratchDir: path.join(dataRoot, "oauth-login"),
    logDir: path.join(dataRoot, "logs"),
    webRoot: "",
    ...patch,
  };
}

/** Overrides for `hostDeps`; `paths` overrides individual stores rather than the whole layout. */
export type HostDepsPatch = Omit<Partial<HostApplicationDeps>, "paths"> & { paths?: Partial<HostPaths> };

/** Constructor deps for a host over `registryFile`: no verifier, silent breadcrumbs, the test cipher. */
export function hostDeps(
  registryFile: string,
  patch: HostDepsPatch = {},
): HostApplicationDeps {
  const { paths, ...rest } = patch;
  return {
    paths: hostPaths(registryFile, paths),
    hostVersion: "0.0.0",
    cipher: TEST_CIPHER,
    authority: testAuthority(path.dirname(registryFile)),
    verifier: null,
    breadcrumbs: NO_BREADCRUMBS,
    ...rest,
  };
}

export interface SentEvent {
  channel: string;
  args: unknown[];
}

/** One bound connection: its dispatchers and what its sink received. */
export interface BoundConnection {
  host: HostApplication;
  ctx: ConnectionContext;
  table: ChannelTable;
  /** Dispatches a request channel — or, for a notify channel, fires it — through the codecs. */
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  /** Events the connection's sink received: broadcasts, its role's, and its own. */
  sent: SentEvent[];
  unbind: () => void;
}

/**
 * Binds a connection the way a listener binds a socket: the table from
 * `host.handlers(ctx)`, and a sink hearing broadcasts, the connection's role,
 * and events addressed to its id.
 */
export function bindConnection(
  host: HostApplication,
  ctx: ConnectionContext = desktopConnection(),
): BoundConnection {
  const table = host.handlers(ctx);
  const sent: SentEvent[] = [];
  const unbind = host.addSink((scope, channel, args) => {
    const forConnection =
      scope.kind === "broadcast" ||
      (scope.kind === "role" && scope.role === ctx.role) ||
      (scope.kind === "connection" && scope.id === ctx.id);
    if (forConnection) sent.push({ channel, args });
  });
  return {
    host,
    ctx,
    table,
    invoke: (channel, ...args) => {
      if (Object.hasOwn(table.request, channel)) return dispatchRequest(table, channel, args);
      dispatchNotify(table, channel, args);
      return Promise.resolve(undefined);
    },
    sent,
    unbind,
  };
}

/** A host over `registryFile` with a desktop client's connection bound; the common test opening. */
export function testHost(
  registryFile: string,
  patch: HostDepsPatch = {},
): BoundConnection {
  return bindConnection(new HostApplication(hostDeps(registryFile, patch)));
}
