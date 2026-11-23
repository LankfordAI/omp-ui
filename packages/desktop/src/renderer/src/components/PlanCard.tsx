import { isHtmlPlanPath } from "@omp-ui/core/plan";
import { usePreparedPlanDocument } from "../lib/use-prepared-plan-document";
import type { PlanItem } from "../lib/transcript";
import { Markdown } from "./Markdown";
import { PreparedPlanView } from "./PlanDocumentView";
import { Chip, Disclosure, Label, Panel } from "./ui";

/**
 * Inline record of a plan proposal in the transcript (issue #93). The
 * PlanReview modal and the rail's PlansPane stay the review surfaces —
 * this card is the chronological trace, collapsed by default.
 *
 * Historical content uses the SAME corrected transforms as live review, and
 * NEVER submits a validation request (issue #312 follow-up): opening a card
 * cannot start an agent repair loop. When an old proposal's preparation
 * failed, the card names the diagnostics and shows the source — the wording
 * no longer sends the user to have the agent rewrite an already-settled plan.
 */
export function PlanCard({ item }: { item: PlanItem }) {
  const prepared = usePreparedPlanDocument(
    item.text !== null && isHtmlPlanPath(item.planFilePath) ? item.text : null,
  );
  const html = item.text !== null && isHtmlPlanPath(item.planFilePath);
  return (
    <Panel className="animate-rise">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Label>plan proposed</Label>
        <span className="min-w-0 flex-1 truncate text-xs text-ink" title={item.title}>
          {item.title}
        </span>
        {item.status === "pending" && <Chip tone="copper">pending</Chip>}
        {item.status === "executed" && <Chip tone="signal">executed</Chip>}
        {item.status === "refined" && <Chip>refined</Chip>}
        {item.status === "invalidated" && <Chip tone="rose">invalidated</Chip>}
        {item.status === "dismissed" && <Chip>dismissed</Chip>}
      </div>
      <div className="border-t border-line-soft px-2.5 py-2">
        {item.text !== null ? (
          <Disclosure summary={<Label>show plan</Label>}>
            <div className="mt-1">
              {html ? (
                <PreparedPlanView
                  prepared={prepared}
                  source={item.text}
                  title="proposed plan"
                  className="h-[28rem]"
                />
              ) : (
                <Markdown text={item.text} />
              )}
            </div>
          </Disclosure>
        ) : (
          <p data-selectable className="font-mono text-xs text-ink-faint">
            {item.planFilePath}
          </p>
        )}
      </div>
    </Panel>
  );
}
