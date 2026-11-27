import {
  fleetMachineName,
  fleetToolMachineKey,
  LOCAL_MACHINE_KEY,
  type FleetGrantRaiseOutcome,
  type FleetMachine,
  type FleetRung,
  type FleetToolGrantRaiseArgs,
  type FleetGrantRaisePrompt,
} from "@omp-ui/core";
import type { HostCallControl } from "./host-bridge";
import type { CardOutcome } from "./card-request-gate";

/** A little past the member call deadline (45 s) so the member answers first. */
const GRANT_RAISE_MEMBER_DEADLINE_MS = 60_000;

export interface FleetGrantRaiseRequestsDeps {
  /** SessionManager.grantRaiseEligibility: null when the tab may ask. */
  eligibility(tabId: string): string | null;
  machines(): Promise<FleetMachine[]>;
  /** FleetDispatcher.requestGrant — the existing proxied ceremony. */
  requestGrant(machineKey: string, rung: FleetRung, secret: string): Promise<FleetGrantRaiseOutcome>;
  /** CardRequestGate.request on the grantRaises instance. */
  ask(tabId: string, prompt: FleetGrantRaisePrompt, signal: AbortSignal): Promise<CardOutcome<{ kind: "allow"; secret: string } | { kind: "deny" }>>;
}

const refused = (reason: string): FleetGrantRaiseOutcome => ({ ok: false, reason });

/**
 * Agents ask a joined member for a higher access rung through a confirmation
 * card (#1393). The card collects the member's credential from the user; the
 * secret lives only in the card's answer and rides once into
 * FleetDispatcher.requestGrant — never into a log, a refusal reason, or the
 * broadcast. The member's own checks (credential, ceiling, binding) are
 * untouched.
 */
export class FleetGrantRaiseRequests {
  constructor(private readonly deps: FleetGrantRaiseRequestsDeps) {}

  async request(tabId: string, args: FleetToolGrantRaiseArgs, control: HostCallControl): Promise<FleetGrantRaiseOutcome> {
    const eligibility = this.deps.eligibility(tabId);
    if (eligibility !== null) return refused(eligibility);

    // Resolve the machineKey before the hold: a rename while the card is open
    // cannot send the secret to the wrong member.
    const machines = await this.deps.machines();
    const resolved = fleetToolMachineKey(args.machine, machines);
    if (!resolved.ok) return refused(resolved.reason);
    if (resolved.machineKey === LOCAL_MACHINE_KEY) {
      return refused(
        "the access rungs on this computer are the owner's setting (Settings → Remote instances → Fleet access)",
      );
    }
    const machine = machines.find((m) => m.key === resolved.machineKey);
    if (machine === undefined) return refused(`no fleet machine is named "${args.machine}"`);

    const prompt: FleetGrantRaisePrompt = {
      promptId: crypto.randomUUID(),
      machine: fleetMachineName(machine),
      rung: args.rung,
      currentRung: machine.grantRung ?? null,
      requestedAt: new Date().toISOString(),
    };

    control.suspendWatchdog();
    const outcome = await this.deps.ask(tabId, prompt, control.signal);
    if (outcome === "cancelled") return refused("the request was cancelled");
    if ("kind" in outcome && outcome.kind === "refused") return refused(outcome.reason);
    if ("kind" in outcome && outcome.kind === "deny") return refused("the user declined");

    const secret = outcome.secret.trim();
    control.rearmWatchdog(GRANT_RAISE_MEMBER_DEADLINE_MS);
    return this.deps.requestGrant(resolved.machineKey, args.rung, secret);
  }
}
