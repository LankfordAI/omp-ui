import { describe, expect, it, vi } from "vitest";
import type { FleetHostReport, FleetMachine, RemoteInstanceSummary, SessionSummary } from "@omp-ui/core";
import { RemoteVsCodeOpener, type RemoteVsCodeOpenerDeps } from "./remote-vscode-open";

const remote: RemoteInstanceSummary = {
  id: "r1",
  nickname: "box",
  url: "http://box.tailnet:4677",
  status: "joined",
  error: null,
  version: "1.0.0",
  modelFavorites: [],
  projects: [
    {
      project: { path: "/srv/app", name: "app" } as RemoteInstanceSummary["projects"][number]["project"],
      sessions: [
        {
          projectCwd: "/srv/app",
          worktree: { path: "/home/ada/.omp-ui/worktrees/app-1", branch: "omp-ui/app/1", base: "main" },
        } as SessionSummary,
      ],
    },
  ],
};

const machine: FleetMachine = {
  key: "r1",
  nickname: "box",
  status: "ready",
  error: null,
  preference: "normal",
  report: { user: "ada" } as FleetHostReport,
  receivedAt: 0,
  grantRung: null,
  address: "box.tailnet",
  sshReachable: true,
  maintenance: null,
};

function opener(patch: Partial<RemoteVsCodeOpenerDeps> = {}) {
  const openUrl = vi.fn<RemoteVsCodeOpenerDeps["openUrl"]>(async () => {});
  const deps: RemoteVsCodeOpenerDeps = {
    enabled: () => true,
    remotes: () => [remote],
    machine: async () => machine,
    vsCodeAvailable: () => true,
    openUrl,
    ...patch,
  };
  return { opener: new RemoteVsCodeOpener(deps), openUrl };
}

describe("RemoteVsCodeOpener (issue #995)", () => {
  it("opens a reported project or worktree path on the member's ssh target", async () => {
    const { opener: o, openUrl } = opener();
    await o.open("r1", "/home/ada/.omp-ui/worktrees/app-1");
    expect(openUrl).toHaveBeenCalledOnce();
    const url = openUrl.mock.calls[0]![0];
    const authority = url.slice("vscode://vscode-remote/ssh-remote+".length, url.indexOf("/", "vscode://vscode-remote/".length));
    expect(JSON.parse(Buffer.from(authority, "hex").toString("utf8"))).toEqual({ hostName: "box.tailnet", user: "ada" });
    expect(url.endsWith("/home/ada/.omp-ui/worktrees/app-1?windowId=_blank")).toBe(true);
  });

  it("refuses while the setting is off, for a path the member never reported, and for an unjoined member", async () => {
    await expect(opener({ enabled: () => false }).opener.open("r1", "/srv/app")).rejects.toThrow(/is off/);
    const { opener: o, openUrl } = opener();
    await expect(o.open("r1", "/etc")).rejects.toThrow(/no project or session/);
    await expect(o.open("r1", "/srv/app/../../etc")).rejects.toThrow(/no project or session/);
    await expect(opener({ remotes: () => [{ ...remote, status: "unreachable" }] }).opener.open("r1", "/srv/app")).rejects.toThrow(
      /not joined/,
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("names the closed port instead of launching VS Code", async () => {
    const { opener: o, openUrl } = opener({ machine: async () => ({ ...machine, sshReachable: false }) });
    await expect(o.open("r1", "/srv/app")).rejects.toThrow("SSH port 22 did not answer on box.tailnet");
    expect(openUrl).not.toHaveBeenCalled();
  });
});
