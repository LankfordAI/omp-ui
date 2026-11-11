import { app, session, type WebContents, type WebPreferences } from "electron";
import { HTML_ARTIFACT_PARTITION, isHtmlArtifactRequestAllowed } from "@omp-ui/core";
import type { ArtifactGuestBroker } from "./artifact-guest-broker";

/*
 * The network boundary under an interactive HTML artifact (issue #994,
 * ADR-0082). The artifact's CSP blocks fetch, sockets, images, frames and
 * forms, but no CSP directive gates WebRTC: a sandboxed iframe alone still
 * sent STUN packets to a loopback UDP listener in this Electron. So the
 * renderer runs each artifact in a `<webview>` guest on one in-memory
 * partition, and this module makes that partition unable to reach anything:
 *
 * 1. A dead proxy for every scheme, loopback included (`<-loopback>` removes
 *    Chromium's implicit loopback bypass), and WebRTC's IP policy
 *    `disable_non_proxied_udp` on every guest: UDP that cannot ride the proxy
 *    is forbidden, and TCP must go through a proxy that carries nothing.
 * 2. A webRequest filter that cancels every request but data:/blob:/about:.
 * 3. Every permission denied (camera, microphone, notifications, ...), and
 *    downloads cancelled.
 * 4. The attach itself: only the locked partition, no node, nested webviews,
 *    renderer preloads/arguments, or dialogs. A main-bound one-use ticket alone
 *    grants the packaged minimal runtime preload. Every guest is confined at
 *    creation: no navigation off its document, no windows.
 */

/** A proxy address nothing listens on; port 9 is the discard port. */
const DEAD_PROXY = "http://127.0.0.1:9";

/** The guest preferences an admitted artifact attaches with, whatever the renderer asked for. */
export const ARTIFACT_GUEST_PREFERENCES: Readonly<WebPreferences> = {
  preload: undefined,
  additionalArguments: [],
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  disableDialogs: true,
  spellcheck: false,
  partition: HTML_ARTIFACT_PARTITION,
};

/**
 * Pure: whether a `<webview>` may attach. Only the artifact partition, only a
 * data:/blob:/about: document, and only once the partition is locked — so a
 * renderer compromised enough to mint a webview gets nothing but this session.
 */
export function artifactWebviewAdmitted(params: Record<string, string>, sessionLocked: boolean): boolean {
  return (
    sessionLocked &&
    params.partition === HTML_ARTIFACT_PARTITION &&
    isHtmlArtifactRequestAllowed(params.src ?? "")
  );
}

let sessionLocked = false;
let installed = false;

function lockArtifactSession(): void {
  const ses = session.fromPartition(HTML_ARTIFACT_PARTITION, { cache: false });
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isHtmlArtifactRequestAllowed(details.url) });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.on("will-download", (event) => event.preventDefault());
  void ses
    .setProxy({ mode: "fixed_servers", proxyRules: DEAD_PROXY, proxyBypassRules: "<-loopback>" })
    .then(() => {
      sessionLocked = true;
    })
    .catch((error: unknown) => {
      // Without the proxy the partition stays closed to attaches: artifacts
      // show nothing rather than run with a weaker boundary.
      console.error(`[html-artifact] could not lock the artifact partition: ${String(error)}`);
    });
}

/** Confines one guest at creation, before it loads anything. */
function confineGuest(guest: WebContents): void {
  guest.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  guest.setWindowOpenHandler(() => ({ action: "deny" }));
  guest.on("will-navigate", (event) => event.preventDefault());
  guest.on("will-redirect", (event) => event.preventDefault());
  guest.on("will-frame-navigate", (details) => {
    if (!isHtmlArtifactRequestAllowed(details.url)) details.preventDefault();
  });
}

/**
 * Installs the guard: the partition lockdown and guest confinement once per
 * app, and the attach gate on the app window that hosts the transcript.
 */
export function installHtmlArtifactGuard(host: WebContents, broker?: ArtifactGuestBroker): void {
  if (!installed) {
    installed = true;
    lockArtifactSession();
    app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() !== "webview") return;
      confineGuest(contents);
      // Escape focus reclaim for every artifact-partition guest, plain ones
      // included (#1130). A plain guest has no broker surface, so without this
      // an Escape pressed while focus sits inside it never reaches the host,
      // and a renderer-side focus() cannot pull native WebContents focus out
      // of an out-of-process guest. `before-input-event` sees real user input
      // only — guest JavaScript cannot fabricate it. Nothing else crosses: no
      // preload, no load(), no saveState().
      if (contents.session !== session.fromPartition(HTML_ARTIFACT_PARTITION)) return;
      const reclaimOnEscape = (_event2: unknown, input: { type: string; key: string }): void => {
        if (input.type !== "keyDown" || input.key !== "Escape") return;
        const hostFrame = contents.hostWebContents;
        if (hostFrame && !hostFrame.isDestroyed()) hostFrame.focus();
      };
      contents.on("before-input-event", reclaimOnEscape);
      contents.on("destroyed", () => contents.removeListener("before-input-event", reclaimOnEscape));
    });
  }
  host.on("will-attach-webview", (event, webPreferences, params) => {
    if (!artifactWebviewAdmitted(params, sessionLocked)) {
      event.preventDefault();
      return;
    }
    const runtime = broker?.admit(params);
    if (!runtime && broker?.isSurfaceDocument(params.src ?? "")) {
      event.preventDefault();
      return;
    }
    // Rebuild, rather than merge: no renderer preference, preloadURL, argument,
    // session, or future Electron preference is inherited by a managed guest.
    for (const key of Object.keys(webPreferences)) delete (webPreferences as Record<string, unknown>)[key];
    Object.assign(webPreferences, ARTIFACT_GUEST_PREFERENCES, runtime ?? {});
  });
}
