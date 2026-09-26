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
/** WHATWG serialises `[::ffff:127.x.y.z]` as compressed hex (`[::ffff:7f00:1]`); `[::ffff:0:0]` is the mapped wildcard. */
const LOOPBACK_V6_MAPPED_RE = /^\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/;

/**
 * Pure: loopback host + denied port → cancel. Hosts: 127.0.0.0/8, localhost,
 * [::1], the wildcards 0.0.0.0 and [::], and their IPv4-mapped IPv6 forms.
 */
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
    host === "localhost" ||
    host === "[::1]" ||
    host === "[::]" ||
    host === "0.0.0.0" ||
    LOOPBACK_V4_RE.test(host) ||
    LOOPBACK_V6_MAPPED_RE.test(host);
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

/** How long a minted tab-capture token stays redeemable; Electron documents ~10 s. */
const MEDIA_GRANT_MS = 10_000;

/** Serialized requester origin; file:// renderers (packaged app) all share one key. */
function originKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" ? "file:" : parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Single-use permission grants for the desktop renderer's tab capture of a pane
 * page (#651). Chromium asks the *captured* page's session for `media` with no
 * media types and the requester's security origin. Page-originated camera or
 * microphone requests name media types and stay denied.
 */
export function createMediaCaptureGrants(now: () => number = Date.now): MediaCaptureGrants {
  const grants = new Map<number, { origin: string; expires: number }>();
  return {
    /** Records one redeemable grant for `paneWebContentsId`, replacing any older one. */
    issue(paneWebContentsId: number, requesterUrl: string): void {
      const origin = originKey(requesterUrl);
      if (origin === null) return;
      grants.set(paneWebContentsId, { origin, expires: now() + MEDIA_GRANT_MS });
    },
    consume(
      paneWebContentsId: number,
      permission: string,
      details: { mediaTypes?: readonly string[]; securityOrigin?: string },
    ): boolean {
      const grant = grants.get(paneWebContentsId);
      if (grant === undefined || permission !== "media") return false;
      if (details.mediaTypes === undefined || details.mediaTypes.length !== 0) return false;
      if (details.securityOrigin === undefined || originKey(details.securityOrigin) !== grant.origin) return false;
      grants.delete(paneWebContentsId);
      return now() <= grant.expires;
    },
  };
}

export interface MediaCaptureGrants {
  issue(paneWebContentsId: number, requesterUrl: string): void;
  consume(
    paneWebContentsId: number,
    permission: string,
    details: { mediaTypes?: readonly string[]; securityOrigin?: string },
  ): boolean;
}

/** Installs the deny-everything handlers on the pane partition once (idempotent per Session). */
export function guardBrowserPaneSession(
  ses: Session,
  deniedPorts: () => ReadonlySet<number>,
  mediaGrants: MediaCaptureGrants,
): void {
  if (guarded.has(ses)) return;
  guarded.add(ses);
  ses.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(mediaGrants.consume(wc.id, permission, details as { mediaTypes?: string[]; securityOrigin?: string })),
  );
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: browserPaneRequestCancelled(details, deniedPorts()) });
  });
}
