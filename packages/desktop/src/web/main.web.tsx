import { HOST_PROTOCOL } from "@omp-ui/server/protocol";
import { connectFailureMessage, mountReconnectBanner, renderConnectFailure } from "./boot-ui";
import { connectRemoteBackend, type RemoteConnection } from "./remote-backend";

// The browser boot shim (issue #37). Order is load-bearing: renderer/src/backend.ts reads
// window.ompBackend eagerly at module load, so the global must be installed before anything in
// renderer/src is imported — hence the dynamic import below rather than a top-level one.

async function boot(): Promise<void> {
  let connection: RemoteConnection;
  try {
    connection = await connectRemoteBackend({
      hello: {
        clientRole: "browser",
        clientKind: "browser",
        clientVersion: __APP_VERSION__,
        clientProtocol: HOST_PROTOCOL,
      },
    });
  } catch (err) {
    // An incompatible verdict is final for this bundle — the host's reason is shown as-is and no
    // reconnect probe runs; every other failure reads the same way with its own message.
    renderConnectFailure(connectFailureMessage(err));
    return;
  }
  window.ompBackend = connection.backend;
  // No window.ompDesktop: a browser client has no adapter, so every client effect is hidden (#454).
  // Only now is it safe to pull in the renderer: this import is what calls createRoot.
  await import("../renderer/src/app-entry");
  mountReconnectBanner(connection.onStatus, async () => {
    const res = await fetch("./healthz", { credentials: "same-origin" });
    if (res.ok) return "up";
    // The host is up but no longer accepts this credential — the password changed or the token
    // was regenerated.
    return res.status === 401 ? "signed-out" : "down";
  });
}

void boot();
