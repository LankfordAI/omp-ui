// The one kickoff prompt of a Seance consult (issue #885). omp has no rpc
// verb for `/seance` — its entry point is the `task` tool with
// `agent: "seance"` — so omp-ui composes a delegation prompt telling the
// consulting session's model to make exactly one such call. The kickoff and
// the relayed answer are ordinary transcript rows; omp-ui keeps no separate
// consult state (the subagent roster is the truth).
import { withoutAccidentalKeywords } from "@omp-ui/core/magic-keywords";

export interface SeanceKickoffSpec {
  /** Absolute transcript path (or verbatim user selector when unresolvable — omp's own error then speaks). */
  sourceSession: string;
  /** Human label for the consult subject line, e.g. the session title. */
  sourceLabel: string;
  question: string;
  /** `provider/id[:level]` consultant-model override; omit for the model saved with the source. */
  model?: string | null;
}

/**
 * Prompt that launches one Seance consult. Optional lines are omitted, never
 * blanked. The task-tool resolver only sees the consulting session's own dir
 * for a bare id (ADR-0003 pins sessions to per-lineage dirs), so the source
 * rides as the path form of `sourceSession`. Magic keywords in the user's
 * question stay inert: a consult must not arm a keyword by accident.
 */
export function seanceKickoff(spec: SeanceKickoffSpec): string {
  return withoutAccidentalKeywords((q) => {
    const args = [
      'agent: "seance"',
      `sourceSession: ${q.inline(JSON.stringify(spec.sourceSession))}`,
    ];
    if (spec.model !== null && spec.model !== undefined && spec.model !== "") {
      args.push(`model: ${q.inline(JSON.stringify(spec.model))}`);
    }
    return [
      `Seance consult of “${q.inline(spec.sourceLabel.trim())}”.`,
      "",
      `Call the task tool exactly once with ${args.join(", ")}, and make the task text this question, verbatim:`,
      q.block(spec.question.trim()),
      "",
      "The consultant is read-only: it answers from saved transcript evidence only, and the session under consultation is never resumed or modified.",
      "Present the consultant's answer to me whole. If the call errors, relay omp's error sentence verbatim — do not retry with another route.",
    ].join("\n");
  });
}
