import { describe, expect, it } from "vitest";
import type { FleetHostReport, FleetMachine } from "./fleet";
import { remoteSshAuthority, remoteVsCodeTarget, vscodeRemoteSshUrl } from "./remote-vscode";

function member(patch: Partial<FleetMachine> = {}, user: string | null = "ada"): FleetMachine {
  return {
    key: "r1",
    nickname: "box",
    status: "ready",
    error: null,
    preference: "normal",
    report: { user } as FleetHostReport,
    receivedAt: 0,
    grantRung: null,
    address: "box.tailnet",
    sshReachable: true,
    maintenance: null,
    ...patch,
  };
}

/** Remote-SSH's own HostInfo.parse (ms-vscode-remote.remote-ssh 0.129), JSON-hex branch. */
function parseAuthority(authority: string): { hostName: string; user?: string } {
  const body = authority.replace(/^ssh-remote\+/, "");
  try {
    const parsed = JSON.parse(Buffer.from(body, "hex").toString("utf8")) as { hostName?: string; user?: string };
    if (parsed?.hostName) return parsed as { hostName: string; user?: string };
  } catch {
    // falls through to the plain host form, as Remote-SSH does
  }
  return { hostName: body };
}

describe("remoteVsCodeTarget (issue #995)", () => {
  it("is ready only for a reported member whose port 22 answered", () => {
    expect(remoteVsCodeTarget(member(), true)).toEqual({ kind: "ready", host: "box.tailnet", user: "ada" });
    expect(remoteVsCodeTarget(member({ sshReachable: false }), true)).toMatchObject({ reason: "sshClosed" });
    expect(remoteVsCodeTarget(member({ sshReachable: null }), true)).toMatchObject({ reason: "sshClosed" });
    expect(remoteVsCodeTarget(member({ status: "unreachable", report: null }), true)).toMatchObject({ reason: "noReport" });
    expect(remoteVsCodeTarget(null, true)).toMatchObject({ reason: "noReport", address: null });
    expect(remoteVsCodeTarget(member(), false)).toMatchObject({ reason: "noVsCode" });
  });

  it("refuses a host or user that ssh could read as an option or VS Code as URL syntax", () => {
    for (const address of ["-oProxyCommand=x", "box tailnet", "box/evil", "box@x", "box%2f", "box?x"]) {
      expect(remoteVsCodeTarget(member({ address }), true)).toMatchObject({ reason: "badTarget" });
    }
    for (const user of ["-oProxyCommand=x", "ada lovelace", "ada@box", "ada:pw", "a/b"]) {
      expect(remoteVsCodeTarget(member({}, user), true)).toMatchObject({ reason: "badTarget" });
    }
    expect(remoteVsCodeTarget(member({ address: "fd00::7" }, null), true)).toEqual({ kind: "ready", host: "fd00::7", user: null });
  });
});

describe("vscodeRemoteSshUrl (issue #995)", () => {
  it("writes an authority Remote-SSH parses back to the same host and user", () => {
    for (const [host, user] of [
      ["box.tailnet", "ada"],
      ["Box.Tailnet", null],
      ["fd00::7", "ada"],
      ["10.0.0.5", null],
    ] as const) {
      expect(parseAuthority(remoteSshAuthority(host, user))).toEqual(user === null ? { hostName: host } : { hostName: host, user });
    }
    expect(remoteSshAuthority("box.tailnet", null)).toBe("ssh-remote+box.tailnet");
  });

  it("keeps the authority at the first slash and encodes every path segment", () => {
    const url = vscodeRemoteSshUrl("box", null, "/srv/My App/#1?/雪");
    expect(url).toBe("vscode://vscode-remote/ssh-remote+box/srv/My%20App/%231%3F/%E9%9B%AA?windowId=_blank");
    // VS Code splits authority from path at the path's first separator.
    const path = new URL(url).pathname;
    expect(path.slice(1, path.indexOf("/", 1))).toBe("ssh-remote+box");
  });
});
