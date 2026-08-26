import type { PlanImplementationSource } from "@omp-ui/core/types";
import { collectNewConcerns, renderConcernsBlock } from "./advisor-concerns";
import type { ModelInfo } from "./rpc-types";
import type { RenderItem } from "./transcript";

/**
 * Where an approved plan is implemented, chosen on the review pane.
 * Moved here from store.ts (was `export type PlanExecutionContext`) so this
 * module owns the whole plan-execute handoff.
 */
export type PlanExecutionContext = "existing" | "compacted" | "fresh" | "worktree";

/** How long after a plan verdict to let the drafting turn's advisor review land. */
export const PLAN_CONCERNS_WAIT_MS = 15_000;

/** The instruction lead on the plan-execution fold. */
export const PLAN_CONCERNS_LEAD = "The advisor flagged these concerns about the plan. Address them:";

/** Appends the advisor block to a dispatch prompt, when there is one. */
export function withConcerns(base: string, concerns: string | null): string {
  return concerns ? `${base}\n\n${concerns}` : base;
}

/**
 * Everything the review pane stages for the implementation dispatch. Undefined
 * fields keep the receiving session's current value; the modal always sends
 * the full staged tuple, legacy callers send none.
 */
export interface PlanExecutionOptions {
  /** Fold the advisor's plan-turn review into the implementation prompt (default true). */
  addressAdvisor?: boolean;
  /** Prepend omp's `ultrathink` magic keyword to the implementation prompt. */
  ultrathink?: boolean;
  /** Prepend omp's `orchestrate` magic keyword to the implementation prompt. */
  orchestrate?: boolean;
  /** Prepend omp's `workflowz` magic keyword to the implementation prompt. */
  workflowz?: boolean;
  /** Staged main model; applied to the receiving session when it differs. */
  model?: ModelInfo | null;
  /** Staged main thinking level; applied when it differs. */
  thinkingLevel?: string | null;
  /** Staged advisor flag; a change on a live same-session context relaunches it. */
  advisor?: boolean;
  /** Staged advisor `model[:level]` selector; null defers to omp's modelRoles.advisor. */
  advisorModel?: string | null;
  /**
   * Dedicated worktree for a "worktree" context spawn: the branch is cut from
   * baseRef (null = the project checkout's HEAD) under the app's worktrees root.
   * Set only when context is "worktree"; ignored by every other context.
   */
  worktree?: { branch: string; baseRef: string | null } | null;
}

/**
 * Prepends the armed magic keywords. omp builds each hidden notice from the
 * keyword in the prompt text itself, so each word must lead as standalone
 * prose — blank-line separation keeps the ported LEFT/RIGHT boundary rules
 * (lib/magic-keywords.ts) matching. The order is fixed to omp's notice-push
 * order (AgentSession.#createMagicKeywordNotices: ultrathink, orchestrate,
 * workflow), never the order the switches were flipped, so the dispatched
 * prompt is deterministic.
 */
export function withKeywords(
  base: string,
  keywords: Pick<PlanExecutionOptions, "ultrathink" | "orchestrate" | "workflowz">,
): string {
  const lead = [
    keywords.ultrathink === true ? "ultrathink" : null,
    keywords.orchestrate === true ? "orchestrate" : null,
    keywords.workflowz === true ? "workflowz" : null,
  ]
    .filter((k): k is string => k !== null)
    .join("\n\n");
  return lead === "" ? base : `${lead}\n\n${base}`;
}

export interface PlanConcernIntent {
  context: PlanExecutionContext;
  planText: string | null;
  /** Accepted proposal provenance captured before the review pane is cleared. */
  readonly planImplementationSource?: Readonly<PlanImplementationSource>;
  options?: PlanExecutionOptions;
}

export interface PlanConcernCallbacks {
  /** Transcript notice ("verdict accepted — waiting…", "…folded (N concerns)"). */
  onNotice(tabId: string, text: string): void;
  /** Fire the implementation dispatch once a review (or the deadline) settles. */
  onDispatch(tabId: string, intent: PlanConcernIntent, concerns: string | null): void;
}

interface ActiveWait {
  intent: PlanConcernIntent;
  baseline: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Holds an approve-verdict's dispatch for the drafting turn's advisor review.
 * The review gate blocks inside the plan turn, so the review lands only after
 * the verdict; this waits, bounded, for the first new concern and then fires
 * the dispatch — forced clean by the deadline if none lands. Owns its timers,
 * so the store just begins/feeds/cancels; per-tab map, same pattern as the
 * store's termWriters/rpcBooting.
 */
export class PlanConcernWatcher {
  private active = new Map<string, ActiveWait>();

  constructor(
    private callbacks: PlanConcernCallbacks & { getItems(tabId: string): RenderItem[] },
    private deadlineMs: number = PLAN_CONCERNS_WAIT_MS,
  ) {}

  begin(tabId: string, intent: PlanConcernIntent): void {
    this.cancel(tabId); // a re-verdict re-baselines, never stacks waits
    const baseline = this.callbacks.getItems(tabId).length;
    const timer = setTimeout(() => this.settle(tabId), this.deadlineMs);
    this.active.set(tabId, { intent, baseline, timer });
    this.callbacks.onNotice(
      tabId,
      "verdict accepted — waiting for the advisor's review before the next step",
    );
  }

  /** Called on every transcript frame; settles the moment a new concern lands. */
  feed(tabId: string): void {
    const wait = this.active.get(tabId);
    if (!wait) return;
    if (collectNewConcerns(this.callbacks.getItems(tabId), wait.baseline).length === 0) return;
    this.settle(tabId);
  }

  isActive(tabId: string): boolean {
    return this.active.has(tabId);
  }

  cancel(tabId: string): void {
    const wait = this.active.get(tabId);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.active.delete(tabId);
  }

  /** Settle fires once: clear the timer and entry, then fold + dispatch. */
  private settle(tabId: string): void {
    const wait = this.active.get(tabId);
    if (!wait) return;
    this.cancel(tabId);
    const notes = collectNewConcerns(this.callbacks.getItems(tabId), wait.baseline);
    const concerns = renderConcernsBlock(notes, PLAN_CONCERNS_LEAD);
    if (concerns) {
      this.callbacks.onNotice(
        tabId,
        `advisor's review folded into the implementation (${notes.length} concern${notes.length === 1 ? "" : "s"})`,
      );
    }
    this.callbacks.onDispatch(tabId, wait.intent, concerns);
  }
}
