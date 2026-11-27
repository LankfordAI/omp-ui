/**
 * Grant raises (#1393, ADR-0062 as amended): an agent's request to raise its
 * access rung on a joined fleet member, held until the user answers its card
 * in the session. Only the user types the member's credential; the secret
 * rides once to the member and is never stored, logged, or shown. This module
 * holds the pure, shared pieces: the prompt shape the summary publishes, the
 * decision the card answers with, and the per-run cap.
 */
import type { FleetRaiseRung, FleetRung } from "./fleet";

/** Published on SessionSummary while a grant raise waits for the user; ephemeral, never persisted. */
export interface FleetGrantRaisePrompt {
  /** randomUUID per request. */
  promptId: string;
  /** The member's display name at request time. */
  machine: string;
  rung: FleetRaiseRung;
  /** The dispatcher's effective rung on that member when the request was raised; null when unknown. */
  currentRung: FleetRung | null;
  /** ISO timestamp. */
  requestedAt: string;
}

export type FleetGrantRaiseDecision = { kind: "allow"; secret: string } | { kind: "deny" };

/** Grant raises one agent run may raise; the count resets on agent_start. */
export const GRANT_RAISES_PER_RUN = 3;
