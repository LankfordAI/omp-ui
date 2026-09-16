import type { Session } from "electron";
import { isAllowedBrowserPaneSubframeUrl, isAllowedBrowserPaneTopLevelUrl } from "@omp-ui/core";

/**
 * The browser pane's partition guard (#531). The two decisions are pure so the
 * host's tests exercise them without a Session; `guardBrowserPaneSession`
 * installs them on the one app-wide partition exactly once (the plan
 * verifier's `guardSession` minus its asset allow-list).
 */

/** Default port of a scheme whose URL carries none; other schemes have no port to compare. */
const DEFAULT_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
  "ws:": 80,
  "wss:": 443,
};

const LOOPBACK_V4_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Pure: loopback host + denied port → cancel. Hosts: 127.0.0.0/8, localhost, [::1], 0.0.0.0. */
export function isDeniedLoopbackRequest(url: string, deniedPorts: ReadonlySet<number>): boolean {
  if (deniedPorts.size === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  const loopback =
    host === "localhost" || host === "[::1]" || host === "0.0.0.0" || LOOPBACK_V4_RE.test(host);
  if (!loopback) return false;
  const port = parsed.port === "" ? DEFAULT_PORTS[parsed.protocol] : Number(parsed.port);
  return port !== undefined && deniedPorts.has(port);
}

/**
 * Pure: the onBeforeRequest decision for one request (#531 layer 3). Main
 * frames follow the top-level allow-list, subframes the subframe one, and
 * every resource type is cancelled when it points at a denied loopback port.
 * `resourceType` uses Electron's spelling (`mainFrame`/`subFrame`).
 */
export function browserPaneRequestCancelled(
  details: { url: string; resourceType: string },
  deniedPorts: ReadonlySet<number>,
): boolean {
  if (details.resourceType === "mainFrame" && !isAllowedBrowserPaneTopLevelUrl(details.url)) {
    return true;
  }
  if (details.resourceType === "subFrame" && !isAllowedBrowserPaneSubframeUrl(details.url)) {
    return true;
  }
  return isDeniedLoopbackRequest(details.url, deniedPorts);
}

const guarded = new WeakSet<Session>();

/** Installs the deny-everything handlers on the pane partition once (idempotent per Session). */
export function guardBrowserPaneSession(ses: Session, deniedPorts: () => ReadonlySet<number>): void {
  if (guarded.has(ses)) return;
  guarded.add(ses);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: browserPaneRequestCancelled(details, deniedPorts()) });
  });
}
