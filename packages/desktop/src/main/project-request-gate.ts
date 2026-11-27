import {
  PROJECT_REQUESTS_PER_RUN,
  type ProjectRequestDecision,
  type ProjectRequestPrompt,
} from "@omp-ui/core";
import type { Attention } from "./desktop-notifier";
import { CardRequestGate, type CardOutcome } from "./card-request-gate";

export interface ProjectRequestGateDeps {
  broadcast(): Promise<void>;
  attention?: Attention;
  /** SessionManager: rebases the stall clock when the session no longer awaits a human. */
  onSettled(tabId: string): void;
}

/** What one request settles to; `refused` never showed a card. */
export type ProjectRequestOutcome = CardOutcome<ProjectRequestDecision>;

/**
 * Project request cards (#1228, ADR-0099): at most one open request per tab,
 * held until the user answers, the host call is cancelled, or the session
 * exits. In memory only — a request dies with the process that raised it.
 * The gate machinery lives in {@link CardRequestGate}; this subclass names the
 * project card's prompt, decision, and attention callbacks.
 */
export class ProjectRequestGate extends CardRequestGate<ProjectRequestPrompt, ProjectRequestDecision> {
  constructor(deps: ProjectRequestGateDeps) {
    super(
      {
        broadcast: deps.broadcast,
        onSettled: deps.onSettled,
        onRaised: (tabId) => deps.attention?.projectRequested(tabId),
        onSettleAttention: (tabId) => deps.attention?.projectRequestSettled(tabId),
        perRun: PROJECT_REQUESTS_PER_RUN,
      },
      "project request",
      // A register has no destination folder; an allow with a parent is an allow.
      (decision, prompt) => (decision.kind === "allow" && prompt.verb === "register" ? { kind: "allow", parent: null } : decision),
    );
  }
}
