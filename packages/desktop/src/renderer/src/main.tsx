import type { HostBootstrap, HostBootstrapStatus } from "@omp-ui/core/host-bootstrap-channels";
import { HOST_PROTOCOL, REMOTE_WS_PATH } from "@omp-ui/server/protocol";
import {
  bootCopy,
  connectFailureMessage,
  mountReconnectBanner,
  renderConnectFailure,
  renderHostRecovery,
} from "../../web/boot-ui";
import { connectRemoteBackend } from "../../web/remote-backend";

// The desktop client's boot shim (issue #442 §11): connect first, render second. Preload exposes
// only the bootstrap; the backend is the same WebSocket client a browser uses, pointed at the
// host's local-control endpoint with the desktop credential. Order is load-bearing, exactly as in
// web/main.web.tsx: renderer/src/backend.ts reads window.ompBackend at module load, so app-entry
// is imported dynamically once the global exists. Nothing here constructs a backend of its own.

let booting = false;
/** Set while the recovery surface is up: the live updater it returned, fed by `onStatus`. */
let recovery: ((status: HostBootstrapStatus) => void) | null = null;

/** A status while the recovery surface is up: repaint it, and boot again once the host is ready. */
function observe(bootstrap: HostBootstrap, status: HostBootstrapStatus): void {
  if (recovery === null) return;
  recovery(status);
  if (status.phase === "ready") void boot(bootstrap);
}

async function boot(bootstrap: HostBootstrap): Promise<void> {
  if (booting) return;
  booting = true;
  try {
    const record = await bootstrap.connection();
    const connection = await connectRemoteBackend({
      endpoint: new URL(REMOTE_WS_PATH, record.endpoint).href,
      credential: record.desktopCredential,
      hello: {
        clientRole: "desktop",
        clientKind: "desktop",
        clientVersion: record.clientVersion,
        clientProtocol: HOST_PROTOCOL,
      },
    });
    recovery = null;
    window.ompBackend = connection.backend;
    // Only now is it safe to pull in the renderer: this import is what calls createRoot.
    await import("./app-entry");
    // A dropped socket means the host went away; the bootstrap knows when it is back.
    mountReconnectBanner(connection.onStatus, async () =>
      (await bootstrap.status()).phase === "ready" ? "up" : "down",
    );
  } catch (err) {
    await recover(bootstrap, connectFailureMessage(err));
  } finally {
    booting = false;
  }
}

/**
 * Bootstrap failed, or the host refused the connection: show what the bootstrap knows and the
 * three things a user can do about it. A `ready` status arriving later (a retry that worked, a
 * host that came back on its own) boots again without a reload.
 */
async function recover(bootstrap: HostBootstrap, message: string): Promise<void> {
  let status: HostBootstrapStatus;
  try {
    status = await bootstrap.status();
  } catch {
    // The bootstrap itself is unreachable: nothing to show but the failure and a reload.
    renderConnectFailure(message);
    return;
  }
  recovery = renderHostRecovery(status, message, {
    // retry() settles when the new pass does (ready or failed) and never rejects; the surface
    // follows it through onStatus, and the final status is read back in case no event fired.
    retry: () => void bootstrap.retry().then(() => bootstrap.status()).then((s) => observe(bootstrap, s)),
    stop: () => void bootstrap.stop().catch(() => {}),
    rollback: () => void bootstrap.rollback().catch(() => {}),
  });
}

const bootstrap = window.ompHostBootstrap;
if (bootstrap === undefined) {
  // The Electron page without its preload: nothing here can find or start a host.
  renderConnectFailure(bootCopy().noBootstrap);
} else {
  bootstrap.onStatus((status) => observe(bootstrap, status));
  void boot(bootstrap);
}
