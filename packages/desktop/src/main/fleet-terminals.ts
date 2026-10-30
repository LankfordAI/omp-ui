/**
 * Fleet terminal owner, member side (issue #991, ADR-0084): the login shells
 * this machine runs for dispatchers that hold the Terminal rung. Each one is a
 * PTY under the dispatcher-minted id, kept alive only while its dispatcher
 * renews the lease; a lapsed lease, a lost rung, or quitting ends it. Nothing
 * is written to disk and no shell outlives this process.
 */
import * as os from "node:os";
import {
  FLEET_MEMBER_TERMINAL_DATA,
  FLEET_MEMBER_TERMINAL_EXIT,
  FLEET_TERMINAL_CELLS_MAX,
  FLEET_TERMINAL_LEASE_MS,
  FLEET_TERMINALS_MAX,
  spawnShell,
  type FleetRequester,
  type FleetRung,
  type FleetTerminalOpenOutcome,
  type PtyHandle,
} from "@omp-ui/core";
import { messageOf } from "./fleet-shell";

/** Why a terminal ended, for the owner's audit line. */
export type FleetTerminalEndReason = "exited" | "closed" | "lease" | "revoked" | "quit";

export interface FleetTerminalRecordOnMember {
  terminalId: string;
  requester: FleetRequester;
  rung: FleetRung;
}

export interface FleetTerminalsDeps {
  /** Fans an event out to this machine's socket clients, never to its own window. */
  sendToClients: (channel: string, args: unknown[]) => void;
  /** Called once per terminal end (FleetServer audits it). */
  onEnd: (rec: FleetTerminalRecordOnMember, reason: FleetTerminalEndReason, exitCode: number | null) => void;
  /** Test seams. */
  spawn?: typeof spawnShell;
  homeDir?: () => string;
  leaseMs?: number;
}

interface HostedTerminal {
  rec: FleetTerminalRecordOnMember;
  handle: PtyHandle;
  detachData: () => void;
  lease: NodeJS.Timeout;
  /** Set before a kill so the exit names why the shell went away. */
  stopping: FleetTerminalEndReason | null;
  /** Armed by the first kill; forces the end if the shell outlives the hangup. */
  escalation: NodeJS.Timeout | undefined;
}

const clampCells = (n: number): number => Math.min(FLEET_TERMINAL_CELLS_MAX, Math.max(1, Math.floor(n)));

/**
 * How long a shell gets to exit on SIGHUP before SIGKILL. An interactive zsh
 * ignores both SIGHUP and SIGTERM from node-pty (observed with zsh 5.9 on
 * Fedora), so a polite kill alone never ends it.
 */
const KILL_GRACE_MS = 2_000;

export class FleetTerminals {
  readonly #deps: FleetTerminalsDeps;
  readonly #leaseMs: number;
  readonly #terminals = new Map<string, HostedTerminal>();

  constructor(deps: FleetTerminalsDeps) {
    this.#deps = deps;
    this.#leaseMs = deps.leaseMs ?? FLEET_TERMINAL_LEASE_MS;
  }

  /** Starts the login shell in the home directory; the caller has already checked the rung. */
  open(requester: FleetRequester, rung: FleetRung, terminalId: string, cols: number, rows: number): FleetTerminalOpenOutcome {
    if (this.#terminals.has(terminalId)) return { status: "refused", reason: "a terminal with that id is already open here" };
    if (this.#terminals.size >= FLEET_TERMINALS_MAX) {
      return { status: "refused", reason: `${FLEET_TERMINALS_MAX} fleet terminals are already open on this machine; close one first` };
    }
    let handle: PtyHandle;
    try {
      handle = (this.#deps.spawn ?? spawnShell)({
        id: terminalId,
        cwd: (this.#deps.homeDir ?? os.homedir)(),
        cols: clampCells(cols),
        rows: clampCells(rows),
      });
    } catch (err) {
      return { status: "refused", reason: `the shell failed to start here: ${messageOf(err)}` };
    }
    const rec: FleetTerminalRecordOnMember = { terminalId, requester, rung };
    const detachData = handle.onData((data) => this.#deps.sendToClients(FLEET_MEMBER_TERMINAL_DATA, [terminalId, data]));
    const hosted: HostedTerminal = { rec, handle, detachData, lease: this.#arm(terminalId), stopping: null, escalation: undefined };
    this.#terminals.set(terminalId, hosted);
    handle.onExit(({ exitCode }) => {
      if (this.#terminals.get(terminalId) !== hosted) return;
      this.#terminals.delete(terminalId);
      clearTimeout(hosted.lease);
      clearTimeout(hosted.escalation);
      hosted.detachData();
      this.#deps.sendToClients(FLEET_MEMBER_TERMINAL_EXIT, [terminalId, exitCode]);
      this.#deps.onEnd(rec, hosted.stopping ?? "exited", exitCode);
    });
    return { status: "accepted" };
  }

  /** Re-arms the lease on the requester's own running terminals and answers which of the asked ids still run. */
  renew(requester: FleetRequester, terminalIds: readonly string[]): string[] {
    const alive: string[] = [];
    for (const id of terminalIds) {
      const hosted = this.#owned(requester.instanceId, id);
      if (hosted === undefined || hosted.stopping !== null) continue;
      clearTimeout(hosted.lease);
      hosted.lease = this.#arm(id);
      alive.push(id);
    }
    return alive;
  }

  /** Ends one of the requester's own terminals; another dispatcher's id is ignored. */
  end(requester: FleetRequester, terminalId: string): void {
    const hosted = this.#owned(requester.instanceId, terminalId);
    if (hosted !== undefined) this.#stop(hosted, "closed");
  }

  write(dispatcherId: string, terminalId: string, data: string): void {
    const hosted = this.#owned(dispatcherId, terminalId);
    if (hosted !== undefined && hosted.stopping === null) hosted.handle.write(data);
  }

  resize(dispatcherId: string, terminalId: string, cols: number, rows: number): void {
    const hosted = this.#owned(dispatcherId, terminalId);
    if (hosted !== undefined && hosted.stopping === null) hosted.handle.resize(clampCells(cols), clampCells(rows));
  }

  /** Ends every terminal whose dispatcher no longer passes `stillAllowed`. */
  revokeWhere(stillAllowed: (requesterId: string) => boolean): void {
    for (const hosted of this.#terminals.values()) {
      if (!stillAllowed(hosted.rec.requester.instanceId)) this.#stop(hosted, "revoked");
    }
  }

  /** Quit path: every shell ends with this process. */
  dispose(): void {
    for (const hosted of this.#terminals.values()) this.#stop(hosted, "quit");
  }

  #owned(dispatcherId: string, terminalId: string): HostedTerminal | undefined {
    const hosted = this.#terminals.get(terminalId);
    return hosted?.rec.requester.instanceId === dispatcherId ? hosted : undefined;
  }

  #arm(terminalId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const hosted = this.#terminals.get(terminalId);
      if (hosted !== undefined) this.#stop(hosted, "lease");
    }, this.#leaseMs);
    timer.unref();
    return timer;
  }

  /** The reason lands before the kill; a shell already stopping keeps its first reason. */
  #stop(hosted: HostedTerminal, reason: FleetTerminalEndReason): void {
    if (hosted.stopping !== null) return;
    hosted.stopping = reason;
    clearTimeout(hosted.lease);
    hosted.handle.kill();
    hosted.escalation = setTimeout(() => {
      if (this.#terminals.get(hosted.rec.terminalId) === hosted) hosted.handle.kill("SIGKILL");
    }, KILL_GRACE_MS);
    hosted.escalation.unref();
  }
}
