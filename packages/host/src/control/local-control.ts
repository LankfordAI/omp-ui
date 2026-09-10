import type { BreadcrumbSink } from "@omp-ui/core";
import {
  HOST_PROTOCOL,
  HOST_PROTOCOL_RANGE,
  REMOTE_CLOSE_REVOKED,
  startHostServer,
  tokenMatches,
  type ConnectionContext,
  type HostSurface,
  type UpgradeGrant,
} from "@omp-ui/server";
import {
  deleteHostRecord,
  mintControlCredential,
  mintDesktopCredential,
  writeHostRecord,
  type HostConnectionRecordV1,
} from "./connection-record";

export interface LocalControlDeps {
  surface: HostSurface;
  dataRoot: string;
  hostVersion: string;
  pid?: number;
  processStartMs: number;
  incarnation: number;
  now?: () => number;
  breadcrumbs: BreadcrumbSink;
}

/**
 * The host's loopback listener (issue #442 §10.4): the one place the desktop shell and the
 * control CLI attach. Its two credentials live only in memory and in `<dataRoot>/host.json`.
 */
export interface LocalControl {
  readonly record: HostConnectionRecordV1;
  /** Mints both credentials, republishes the record, and drops every attached client (4001). */
  rotateLocalCredentials(): Promise<void>;
  connections(): readonly ConnectionContext[];
  /** Stops listening and removes the record, so a client never dials a dead endpoint. */
  close(): Promise<void>;
}

const DESKTOP_GRANT: UpgradeGrant = { role: "desktop", local: true, control: false };
const CONTROL_GRANT: UpgradeGrant = { role: "browser", local: true, control: true };

export async function startLocalControl(deps: LocalControlDeps): Promise<LocalControl> {
  const { surface, dataRoot, hostVersion, breadcrumbs } = deps;
  const now = deps.now ?? Date.now;
  let desktopCredential = mintDesktopCredential();
  let controlCredential = mintControlCredential();

  const handle = await startHostServer({
    surface,
    bind: "loopback",
    port: 0,
    webRoot: "",
    // Only the two loopback credentials exist here. A remote token, a password session, or
    // nothing at all is refused: remote clients belong to the remote listener, not this one.
    authenticate: (presented) => {
      if (tokenMatches(desktopCredential, presented)) return DESKTOP_GRANT;
      if (tokenMatches(controlCredential, presented)) return CONTROL_GRANT;
      return null;
    },
    hostVersion,
    allowImplicitProtocol1: false,
    local: true,
    onEmitMiss: (scope, ch) => {
      breadcrumbs.record("emit-miss", {
        detail: `${scope.kind}:${"id" in scope ? scope.id : ""} ${ch}`,
      });
    },
  });

  let record: HostConnectionRecordV1 = {
    schemaVersion: 1,
    dataRoot,
    hostVersion,
    hostProtocol: HOST_PROTOCOL,
    protocolRange: HOST_PROTOCOL_RANGE,
    endpoint: `http://127.0.0.1:${handle.port}`,
    desktopCredential,
    controlCredential,
    pid: deps.pid ?? process.pid,
    processStartMs: deps.processStartMs,
    startedAtMs: now(),
    incarnation: deps.incarnation,
  };
  writeHostRecord(record);

  return {
    get record() {
      return record;
    },
    async rotateLocalCredentials() {
      const nextDesktop = mintDesktopCredential();
      const nextControl = mintControlCredential();
      // Publish before accepting: a client that reads the record must never hold a credential
      // the listener has not yet started honouring.
      record = { ...record, desktopCredential: nextDesktop, controlCredential: nextControl };
      writeHostRecord(record);
      desktopCredential = nextDesktop;
      controlCredential = nextControl;
      handle.closeConnections(() => true, REMOTE_CLOSE_REVOKED, "credential rotated");
    },
    connections: () => handle.connections(),
    async close() {
      await handle.close();
      deleteHostRecord(dataRoot);
    },
  };
}
