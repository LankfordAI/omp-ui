import { connectRemoteBackend, type RemoteConnection } from "./remote-backend";

// The browser boot shim (issue #37). Order is load-bearing: renderer/src/backend.ts reads
// window.ompBackend eagerly at module load, so the global must be installed before anything in
// renderer/src is imported — hence the dynamic import below rather than a top-level one.

const WEB_COPY = {
  en: {
    connectFailure: "omp-ui could not connect",
    retry: "retry",
    reconnecting: "reconnecting to omp-ui…",
    sessionEnded: "session ended — tap to sign in again",
  },
  ko: {
    connectFailure: "omp-ui에 연결할 수 없습니다",
    retry: "다시 시도",
    reconnecting: "omp-ui에 다시 연결하는 중…",
    sessionEnded: "세션이 종료되었습니다. 탭하여 다시 로그인하세요",
  },
} as const;

function webCopy(): (typeof WEB_COPY)["en"] | (typeof WEB_COPY)["ko"] {
  try {
    return localStorage.getItem("omp-ui.localeId") === "ko" ? WEB_COPY.ko : WEB_COPY.en;
  } catch {
    return WEB_COPY.en;
  }
}

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
  title.textContent = webCopy().connectFailure;
  title.style.cssText = "margin:0;font-size:15px;font-weight:600;color:#e6ebf2";
  const detail = document.createElement("p");
  detail.textContent = message;
  detail.style.cssText = "margin:0;max-width:36rem;color:#8b95a3";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = webCopy().retry;
  retry.style.cssText =
    "border:1px solid #2a3038;background:#14171b;color:#c8d0da;border-radius:4px;padding:4px 12px;cursor:pointer;font:inherit";
  retry.addEventListener("click", () => location.reload());
  box.append(title, detail, retry);
  root.append(box);
}

/**
 * Fixed strip shown while the reliable socket is down. Recovery is status-driven:
 * the backend redials with backoff (issue #890) and reports re-pairing through
 * `onStatus(true)`, at which point `onResync` refetches authoritative state and
 * re-boots live transcripts in place — no reload, so composer drafts survive. The
 * healthz probe remains only to catch the revoked-credential case the socket never
 * announced (a hidden upgrade failure), and to keep offering the login page.
 */
function mountReconnectBanner(
  onStatus: (cb: (up: boolean) => void) => void,
  onResync: () => Promise<void>,
): void {
  const host = document.getElementById("remote-banner");
  if (!host) return;
  const strip = document.createElement("div");
  strip.textContent = webCopy().reconnecting;
  strip.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:2147483647;display:none;padding:calc(4px + env(safe-area-inset-top, 0px)) calc(12px + env(safe-area-inset-right, 0px)) 4px calc(12px + env(safe-area-inset-left, 0px));" +
    "background:#3a2a12;color:#e8c99a;font:12px/1.4 system-ui,sans-serif;text-align:center";
  host.append(strip);

  // Browser setInterval, so a plain number — no Node timer handle in this bundle.
  let probe: number | undefined;
  onStatus((up) => {
    if (up) {
      clearInterval(probe);
      probe = undefined;
      void onResync().then(() => {
        strip.style.display = "none";
      });
      return;
    }
    strip.textContent = webCopy().reconnecting;
    strip.style.display = "block";
    if (probe !== undefined) return;
    probe = window.setInterval(() => {
      void fetch("./healthz", { credentials: "same-origin" })
        .then((res) => {
          // The server is up but no longer accepts this credential — the password changed
          // or the token was regenerated. Offer the login page instead of waiting forever.
          // A healthy probe needs no action here: the backend's own redial reports
          // recovery through onStatus, and reload stays out of the picture entirely.
          if (res.status === 401) {
            strip.textContent = webCopy().sessionEnded;
            strip.style.cursor = "pointer";
            strip.addEventListener(
              "click",
              () => {
                location.href = "./login";
              },
              { once: true },
            );
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
  mountReconnectBanner(connection.onStatus, async () => {
    // Dynamic import is load-order-bearing: a top-level renderer import would
    // evaluate before window.ompBackend exists (see boot()'s ordering comment).
    const { useStore } = await import("../renderer/src/store");
    await useStore.getState().resyncAfterReconnect();
  });
}


void boot();
