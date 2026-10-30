/**
 * Open in VS Code over Remote-SSH (issue #995, ADR-0083): the pure half. Main
 * decides from a member's Fleet row whether this computer's VS Code can reach
 * it over ssh, and builds the `vscode://vscode-remote/ssh-remote+…` URL VS
 * Code's protocol handler turns into a Remote-SSH folder window. omp-ui opens
 * no ssh connection and holds no keys: VS Code's Remote-SSH extension uses the
 * user's own ssh config and agent.
 */
import type { FleetMachine } from "./fleet";
import type { RemoteVsCodeTarget } from "./types";

/**
 * A DNS name or IPv4 address (alphanumeric first, then letters, digits, dot,
 * hyphen), or an IPv6 literal (hex digits, colons, dots; no zone id). Never a
 * leading `-`, so the host can never read as an ssh option — Remote-SSH
 * refuses one itself (`assertValidHost`), this keeps it out of the URL.
 */
const SSH_HOST = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|[0-9A-Fa-f]*:[0-9A-Fa-f:.]*)$/;
/** A POSIX-portable login name: letters, digits, dot, underscore, hyphen; never a leading `-`. */
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_HOST = 253;
const MAX_USER = 64;

/**
 * Whether `machine` (the member's Fleet row, null when unknown) can open in
 * this computer's VS Code over Remote-SSH. `vsCode` is this computer's
 * `vscode:` handler probe. Ready only when the member reported, its join host
 * and login user pass the ssh-safe character check, and port 22 answered this
 * computer's probe.
 */
export function remoteVsCodeTarget(machine: FleetMachine | null, vsCode: boolean): RemoteVsCodeTarget {
  const address = machine?.address ?? null;
  if (!vsCode) return { kind: "unavailable", reason: "noVsCode", address };
  if (machine === null || machine.status !== "ready" || machine.report === null || address === null) {
    return { kind: "unavailable", reason: "noReport", address };
  }
  const user = machine.report.user;
  const hostOk = address.length <= MAX_HOST && SSH_HOST.test(address);
  const userOk = user === null || (user.length <= MAX_USER && SSH_USER.test(user));
  if (!hostOk || !userOk) return { kind: "unavailable", reason: "badTarget", address };
  if (machine.sshReachable !== true) return { kind: "unavailable", reason: "sshClosed", address };
  return { kind: "ready", host: address, user };
}

/**
 * A path as VS Code protocol-URL segments, each percent-encoded so no segment
 * reads as URL syntax. Backslashes become slashes, a missing leading slash is
 * added, and a Windows drive (`C:`) is kept unencoded and lower-cased — the
 * form both `vscode://file/` and a Remote-SSH Windows host expect.
 */
export function vscodeUrlPath(projectPath: string): string {
  let normalized = projectPath.replaceAll("\\", "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  return normalized
    .split("/")
    .map((segment, index) =>
      index === 1 && /^[A-Za-z]:$/.test(segment) ? `${segment[0]!.toLowerCase()}:` : encodeURIComponent(segment),
    )
    .join("/");
}

/**
 * The Remote-SSH authority for `host` and `user`, exactly as Remote-SSH's own
 * `HostInfo.toAuthorityString` writes it (ms-vscode-remote.remote-ssh
 * 0.129): a lower-case host with no user is the bare host; anything else is
 * the hex of `{"hostName","user"}` JSON, which `HostInfo.parse` reads first.
 * Matching it keeps the window keyed the same as a manual connection.
 */
export function remoteSshAuthority(host: string, user: string | null): string {
  if (user === null && host.toLowerCase() === host && !/[/\\+]/.test(host)) return `ssh-remote+${host}`;
  const json = JSON.stringify(user === null ? { hostName: host } : { hostName: host, user });
  return `ssh-remote+${Array.from(new TextEncoder().encode(json), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * `vscode://vscode-remote/<authority><path>?windowId=_blank`: VS Code's
 * protocol handler splits the authority off at the path's first `/` and
 * opens the rest as a folder on that remote (VS Code 1.140
 * `getWindowOpenableFromProtocolUrl`). `windowId=_blank` opens a new window.
 */
export function vscodeRemoteSshUrl(host: string, user: string | null, remotePath: string): string {
  return `vscode://vscode-remote/${remoteSshAuthority(host, user)}${vscodeUrlPath(remotePath)}?windowId=_blank`;
}
