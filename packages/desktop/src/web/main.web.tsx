import { connectRemoteBackend, type RemoteConnection } from "./remote-backend";

// The browser boot shim (issue #37). Order is load-bearing: renderer/src/backend.ts reads
// window.ompBackend eagerly at module load, so the global must be installed before anything in
// renderer/src is imported — hence the dynamic import below rather than a top-level one.

/**
 * Fallback for a failed connect. Deliberately raw DOM with inline styles: it must not depend on
 * the renderer, its stylesheet, or React, any of which could be the thing that failed.
 */
function renderConnectFailure(message: string): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";
  const box = document.createElement("div");
  box.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;" +
    "height:100dvh;background:#0a0b0d;color:#c8d0da;font:14px/1.5 system-ui,sans-serif;padding:24px;text-align:center";
  const title = document.createElement("h1");
  title.textContent = "omp-ui could not connect";
  title.style.cssText = "margin:0;font-size:15px;font-weight:600;color:#e6ebf2";
  const detail = document.createElement("p");
  detail.textContent = message;
  detail.style.cssText = "margin:0;max-width:36rem;color:#8b95a3";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "retry";
  retry.style.cssText =
    "border:1px solid #2a3038;background:#14171b;color:#c8d0da;border-radius:4px;padding:4px 12px;cursor:pointer;font:inherit";
  retry.addEventListener("click", () => location.reload());
  box.append(title, detail, retry);
  root.append(box);
}

/**
 * Fixed strip shown while the socket is down, plus a probe that reloads once the server answers
 * again. A reload rather than an in-place resync is deliberate: bootRpcTab already refetches
 * transcript history from omp, so a reload is a correct and complete resync with no synthetic
 * frames to invent.
 */
function mountReconnectBanner(onStatus: (cb: (up: boolean) => void) => void): void {
  const host = document.getElementById("remote-banner");
  if (!host) return;
  const strip = document.createElement("div");
  strip.textContent = "reconnecting to omp-ui…";
  strip.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:2147483647;display:none;padding:calc(4px + env(safe-area-inset-top, 0px)) calc(12px + env(safe-area-inset-right, 0px)) 4px calc(12px + env(safe-area-inset-left, 0px));" +
    "background:#3a2a12;color:#e8c99a;font:12px/1.4 system-ui,sans-serif;text-align:center";
  host.append(strip);

  // Browser setInterval, so a plain number — no Node timer handle in this bundle.
  let probe: number | undefined;
  onStatus((up) => {
    if (up) {
      strip.style.display = "none";
      clearInterval(probe);
      probe = undefined;
      return;
    }
    strip.style.display = "block";
    if (probe !== undefined) return;
    probe = window.setInterval(() => {
      void fetch("./healthz", { credentials: "same-origin" })
        .then((res) => {
          if (res.ok) {
            location.reload();
            return;
          }
          // The server is up but no longer accepts this cookie — the token was regenerated.
          // Saying so beats "reconnecting…" forever, since no amount of waiting will help.
          if (res.status === 401) {
            strip.textContent = "this token was revoked — get a fresh link from omp-ui";
            clearInterval(probe);
            probe = undefined;
          }
        })
        .catch(() => {
          // Still down — the next tick tries again.
        });
    }, 2_000);
  });
}

async function boot(): Promise<void> {
  let connection: RemoteConnection;
  try {
    connection = await connectRemoteBackend();
  } catch (err) {
    renderConnectFailure(err instanceof Error ? err.message : String(err));
    return;
  }
  window.ompBackend = connection.backend;
  // Only now is it safe to pull in the renderer: this import is what calls createRoot.
  await import("../renderer/src/main");
  mountReconnectBanner(connection.onStatus);
}

void boot();
