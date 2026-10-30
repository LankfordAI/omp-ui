/**
 * Open in VS Code over Remote-SSH (issue #995, ADR-0083), main side. Every
 * open re-derives the ssh target from the member's own Fleet row and accepts
 * only a path that member already reported as a project, session checkout,
 * or worktree, so a renderer (or a remote-access browser client) can make
 * this computer's VS Code connect only to a member it joined, at a checkout
 * that member published. Off unless `remoteVsCodeEnabled` is on.
 */
import {
  remoteVsCodeTarget,
  vscodeRemoteSshUrl,
  type FleetMachine,
  type RemoteInstanceSummary,
  type RemoteVsCodeTarget,
} from "@omp-ui/core";

export interface RemoteVsCodeOpenerDeps {
  /** The `remoteVsCodeEnabled` setting. */
  enabled(): boolean;
  /** RemoteInstances.summaries(). */
  remotes(): RemoteInstanceSummary[];
  /** FleetDispatcher.machine: the member's row with its cached port-22 probe. */
  machine(instanceId: string): Promise<FleetMachine | null>;
  /** ProjectOpener's cached `vscode:` handler probe. */
  vsCodeAvailable(): boolean;
  /** ProjectOpener.openRemoteUrlInVsCode. */
  openUrl(url: string, label: string): Promise<void>;
}

const REASON_TEXT: Record<Exclude<RemoteVsCodeTarget, { kind: "ready" }>["reason"], (at: string) => string> = {
  noVsCode: () => "VS Code is not available on this computer",
  noReport: (at) => `${at} has not sent a host report; reconnect it and try again`,
  badTarget: (at) => `${at} reports an ssh host or user VS Code cannot be given safely`,
  sshClosed: (at) => `SSH port 22 did not answer on ${at}`,
};

/** Every absolute path the instance reported for a project or session working tree. */
function reportedPaths(remote: RemoteInstanceSummary): Set<string> {
  const paths = new Set<string>();
  for (const group of remote.projects) {
    paths.add(group.project.path);
    for (const session of group.sessions) {
      paths.add(session.projectCwd);
      if (session.worktree != null) paths.add(session.worktree.path);
    }
  }
  return paths;
}

export class RemoteVsCodeOpener {
  readonly #deps: RemoteVsCodeOpenerDeps;

  constructor(deps: RemoteVsCodeOpenerDeps) {
    this.#deps = deps;
  }

  async target(instanceId: string): Promise<RemoteVsCodeTarget> {
    if (!this.#deps.vsCodeAvailable()) return remoteVsCodeTarget(null, false);
    return remoteVsCodeTarget(await this.#deps.machine(instanceId), true);
  }

  async open(instanceId: string, remotePath: string): Promise<void> {
    if (!this.#deps.enabled()) {
      throw new Error("Open in VS Code over SSH is off. Turn it on in Settings → Remote instances.");
    }
    const remote = this.#deps.remotes().find((r) => r.id === instanceId && r.status === "joined");
    if (remote === undefined) throw new Error("That remote instance is not joined.");
    if (!reportedPaths(remote).has(remotePath)) {
      throw new Error(`${remote.nickname} has no project or session at "${remotePath}".`);
    }
    const target = await this.target(instanceId);
    if (target.kind !== "ready") {
      throw new Error(`Could not open "${remotePath}" on ${remote.nickname}: ${REASON_TEXT[target.reason](target.address ?? remote.nickname)}.`);
    }
    await this.#deps.openUrl(vscodeRemoteSshUrl(target.host, target.user, remotePath), `"${remotePath}" on ${remote.nickname}`);
  }
}
