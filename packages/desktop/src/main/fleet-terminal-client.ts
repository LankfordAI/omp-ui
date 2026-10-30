/**
 * Fleet terminal, dispatcher side (issue #991, ADR-0084): the terminals this
 * app opened on fleet members. The user starts one from the Fleet view; this
 * class mints its id, asks the member to open the shell, relays keystrokes and
 * resizes over the join, converts the member's own byte events for the ids it
 * opened into the local `fleet:terminalData`, and renews each member's lease
 * while the terminal is open. Closing it, losing it on the member, or quitting
 * this app ends the shell; nothing persists anywhere.
 */
import { randomUUID } from "node:crypto";
import {
  CH,
  FLEET_MEMBER_TERMINAL_DATA,
  FLEET_MEMBER_TERMINAL_EXIT,
  FLEET_TERMINAL_RENEW_MS,
  LOCAL_MACHINE_KEY,
  type FleetRequester,
  type FleetTerminalOpenOutcome,
  type FleetTerminalRecord,
  type FleetTerminalRenewOutcome,
  type FleetTerminalStartOutcome,
  type RemoteInstanceSummary,
} from "@omp-ui/core";
import { messageOf } from "./fleet-shell";

/** A member that does not answer an open within this window is reported, never retried. */
const OPEN_DEADLINE_MS = 20_000;

export interface FleetTerminalClientDeps {
  remotes: () => RemoteInstanceSummary[];
  request: (instanceId: string, channel: string, args: unknown[]) => Promise<unknown>;
  notify: (instanceId: string, channel: string, args: unknown[]) => void;
  requester: () => FleetRequester;
  /** Fans an event to this app's own clients (window and remote access browsers). */
  send: (channel: string, args: unknown[]) => void;
  broadcast: () => void;
  /** Test seams. */
  uuid?: () => string;
  renewMs?: number;
}

export class FleetTerminalClient {
  readonly #deps: FleetTerminalClientDeps;
  /** Insertion order is open order, which is also the order BackendState lists them in. */
  readonly #terminals = new Map<string, FleetTerminalRecord>();
  #renewTimer: NodeJS.Timeout | null = null;

  constructor(deps: FleetTerminalClientDeps) {
    this.#deps = deps;
  }

  /** Every terminal this app opened, running or ended, for BackendState. */
  list(): FleetTerminalRecord[] {
    return [...this.#terminals.values()].map((t) => ({ ...t }));
  }

  async start(machineKey: string, cols: number, rows: number): Promise<FleetTerminalStartOutcome> {
    if (machineKey === LOCAL_MACHINE_KEY) {
      return { status: "refused", reason: "this computer has its own terminals; a fleet terminal opens on a member" };
    }
    const remote = this.#deps.remotes().find((r) => r.id === machineKey && r.status !== "self");
    if (remote === undefined) return { status: "refused", reason: "no joined fleet instance has that id" };
    if (remote.status !== "joined") return { status: "refused", reason: `${remote.nickname} is not joined` };
    const terminalId = (this.#deps.uuid ?? randomUUID)();
    let answer: FleetTerminalOpenOutcome | "timeout";
    const deadline = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => deadline.resolve("timeout"), OPEN_DEADLINE_MS);
    try {
      answer = await Promise.race([
        this.#deps.request(machineKey, CH.fleetTerminalOpen, [
          { requester: this.#deps.requester(), terminalId, cols, rows },
        ]) as Promise<FleetTerminalOpenOutcome>,
        deadline.promise,
      ]);
    } catch (err) {
      const message = messageOf(err);
      return {
        status: "refused",
        reason: message.includes("unknown channel") ? `${remote.nickname} runs an omp-ui without fleet terminals; update omp-ui there` : message,
      };
    } finally {
      clearTimeout(timer);
    }
    if (answer === "timeout") {
      // The member may have opened it after all; its lease ends it unrenewed.
      return { status: "refused", reason: `no answer from ${remote.nickname} within ${OPEN_DEADLINE_MS / 1000} s` };
    }
    if (answer.status !== "accepted") return answer;
    const terminal: FleetTerminalRecord = {
      terminalId,
      machineKey,
      nickname: remote.nickname,
      openedAt: new Date().toISOString(),
      exitCode: null,
    };
    this.#terminals.set(terminalId, terminal);
    this.#armRenew();
    this.#deps.broadcast();
    return { status: "accepted", terminal: { ...terminal } };
  }

  /** Ends the member's shell (if it still runs) and forgets the terminal. */
  async close(terminalId: string): Promise<void> {
    const terminal = this.#terminals.get(terminalId);
    if (terminal === undefined) return;
    this.#terminals.delete(terminalId);
    this.#deps.broadcast();
    if (this.#terminals.size === 0) this.#stopRenew();
    if (terminal.exitCode !== null) return;
    try {
      await this.#deps.request(terminal.machineKey, CH.fleetTerminalEnd, [{ requester: this.#deps.requester(), terminalId }]);
    } catch {
      // Unreachable member: its lease ends the shell on its own.
    }
  }

  input(terminalId: string, data: string): void {
    const terminal = this.#running(terminalId);
    if (terminal === undefined) return;
    this.#deps.notify(terminal.machineKey, CH.fleetTerminalWrite, [this.#deps.requester().instanceId, terminalId, data]);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.#running(terminalId);
    if (terminal === undefined) return;
    this.#deps.notify(terminal.machineKey, CH.fleetTerminalSize, [this.#deps.requester().instanceId, terminalId, cols, rows]);
  }

  /**
   * One event from a joined member. Only the ids this app opened convert into
   * the local event; the member's own event names are never relayed, so a
   * mutual join cannot loop and another dispatcher's bytes never land here.
   */
  onMemberEvent(instanceId: string, channel: string, args: unknown[]): void {
    const [terminalId, payload] = args;
    if (typeof terminalId !== "string") return;
    const terminal = this.#terminals.get(terminalId);
    if (terminal === undefined || terminal.machineKey !== instanceId) return;
    if (channel === FLEET_MEMBER_TERMINAL_DATA && payload instanceof Uint8Array) {
      this.#deps.send(CH.onFleetTerminalData, [terminalId, payload]);
    } else if (channel === FLEET_MEMBER_TERMINAL_EXIT && terminal.exitCode === null) {
      terminal.exitCode = typeof payload === "number" ? payload : -1;
      this.#deps.broadcast();
    }
  }

  /** Quit path: ask each member to end its shells now rather than at lease expiry. */
  dispose(): void {
    this.#stopRenew();
    const requester = this.#deps.requester();
    for (const terminal of this.#terminals.values()) {
      if (terminal.exitCode !== null) continue;
      void this.#deps
        .request(terminal.machineKey, CH.fleetTerminalEnd, [{ requester, terminalId: terminal.terminalId }])
        .catch(() => {});
    }
    this.#terminals.clear();
  }

  #running(terminalId: string): FleetTerminalRecord | undefined {
    const terminal = this.#terminals.get(terminalId);
    return terminal?.exitCode === null ? terminal : undefined;
  }

  #armRenew(): void {
    if (this.#renewTimer !== null) return;
    this.#renewTimer = setInterval(() => void this.#renew(), this.#deps.renewMs ?? FLEET_TERMINAL_RENEW_MS);
    this.#renewTimer.unref();
  }

  #stopRenew(): void {
    if (this.#renewTimer === null) return;
    clearInterval(this.#renewTimer);
    this.#renewTimer = null;
  }

  /** Renews each member's running terminals; an id the member no longer runs is marked ended. */
  async #renew(): Promise<void> {
    const byMember = new Map<string, string[]>();
    for (const t of this.#terminals.values()) {
      if (t.exitCode !== null) continue;
      byMember.set(t.machineKey, [...(byMember.get(t.machineKey) ?? []), t.terminalId]);
    }
    const requester = this.#deps.requester();
    let changed = false;
    await Promise.all(
      [...byMember].map(async ([machineKey, terminalIds]) => {
        let answer: FleetTerminalRenewOutcome;
        try {
          answer = (await this.#deps.request(machineKey, CH.fleetTerminalRenew, [{ requester, terminalIds }])) as FleetTerminalRenewOutcome;
        } catch {
          return; // Not joined right now: the next tick retries; a lapsed lease answers "not alive" on rejoin.
        }
        const alive = new Set(answer.alive);
        for (const id of terminalIds) {
          const terminal = this.#terminals.get(id);
          if (terminal !== undefined && terminal.exitCode === null && !alive.has(id)) {
            terminal.exitCode = -1;
            changed = true;
          }
        }
      }),
    );
    if (changed) this.#deps.broadcast();
  }
}
