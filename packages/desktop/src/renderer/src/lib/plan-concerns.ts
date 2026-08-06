import type { ModelInfo } from "./rpc-types";
import type { AdvisorNote, RenderItem } from "./transcript";

/**
 * Where an approved plan is implemented, chosen on the review pane.
 * Moved here from store.ts (was `export type PlanExecutionContext`) so this
 * module owns the whole plan-execute handoff.
 */
export type PlanExecutionContext = "existing" | "compacted" | "fresh";

/** How long after a plan verdict to let the drafting turn's advisor review land. */
export const PLAN_CONCERNS_WAIT_MS = 15_000;

const noteKey = (n: AdvisorNote): string => `${n.advisor ?? ""}|${n.severity ?? ""}|${n.note}`;

/**
 * Advisor findings appended to the transcript after `fromIndex`: standalone
 * advisory cards plus notes attached to tool results (the advisor comments on
 * the plan's propose tool result and also posts its end-of-turn card). One
 * review can arrive in both shapes, so notes are deduped on
 * `advisor|severity|note` before the fold — the settle decision and the fold
 * are this one function, so they can never disagree.
 */
export function collectNewConcerns(items: RenderItem[], fromIndex: number): AdvisorNote[] {
  const seen = new Set<string>();
  const notes: AdvisorNote[] = [];
  for (const item of items.slice(fromIndex)) {
    const itemNotes = item.kind === "advisory" || item.kind === "tool" ? (item.notes ?? []) : [];
    for (const note of itemNotes) {
      const key = noteKey(note);
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push(note);
    }
  }
  return notes;
}

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
  /** Prepend omp's `orchestrate` magic keyword to the implementation prompt. */
  orchestrate?: boolean;
  /** Staged main model; applied to the receiving session when it differs. */
  model?: ModelInfo | null;
  /** Staged main thinking level; applied when it differs. */
  thinkingLevel?: string | null;
  /** Staged advisor flag; a change on a live same-session context relaunches it. */
  advisor?: boolean;
  /** Staged advisor `model[:level]` selector; null defers to omp's modelRoles.advisor. */
  advisorModel?: string | null;
}

/**
 * Prepends omp's `orchestrate` magic keyword. omp builds the hidden
 * orchestration notice from the keyword in the prompt text itself, so the
 * word must lead the message as standalone prose — the blank line keeps the
 * ported LEFT/RIGHT boundary rules (lib/magic-keywords.ts) matching.
 */
export function withOrchestrate(base: string, orchestrate: boolean): string {
  return orchestrate ? `orchestrate\n\n${base}` : base;
}

/** Renders concerns as an explicit instruction block, or null when none. */
export function renderConcernsBlock(notes: AdvisorNote[]): string | null {
  if (notes.length === 0) return null;
  const lines = notes.map((note) => {
    const severity = note.severity ?? "note";
    const who = note.advisor ? ` (${note.advisor})` : "";
    return `- [${severity}]${who} ${note.note}`;
  });
  return "The advisor flagged these concerns about the plan. Address them:\n\n" + lines.join("\n");
}

export interface PlanConcernIntent {
  context: PlanExecutionContext;
  planText: string | null;
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
    const concerns = renderConcernsBlock(notes);
    if (concerns) {
      this.callbacks.onNotice(
        tabId,
        `advisor's review folded into the implementation (${notes.length} concern${notes.length === 1 ? "" : "s"})`,
      );
    }
    this.callbacks.onDispatch(tabId, wait.intent, concerns);
  }
}
