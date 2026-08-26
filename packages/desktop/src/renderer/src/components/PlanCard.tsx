import { isHtmlPlanPath } from "@omp-ui/core/plan";
import { usePreparedPlanDocument } from "../lib/plan-document";
import type { PlanItem } from "../lib/transcript";
import { Markdown } from "./Markdown";
import { PlanFallback } from "./PlanFallback";
import { Chip, Disclosure, Label, Panel } from "./ui";

/**
 * Inline record of a plan proposal in the transcript (issue #93). The
 * PlanReview modal and the rail's PlansPane stay the review surfaces —
 * this card is the chronological trace, collapsed by default.
 */
export function PlanCard({ item }: { item: PlanItem }) {
  const prepared = usePreparedPlanDocument(
    item.text !== null && isHtmlPlanPath(item.planFilePath) ? item.text : null,
  );
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
      </div>
      <div className="border-t border-line-soft px-2.5 py-2">
        {item.text !== null ? (
          <Disclosure summary={<Label>show plan</Label>}>
            <div className="mt-1">
              {isHtmlPlanPath(item.planFilePath) ? (
                prepared.status === "failed" ? (
                  <PlanFallback
                    reason={prepared.reason}
                    source={item.text}
                    className="h-[28rem]"
                  />
                ) : (
                  // Same empty sandbox as the review modal: no scripts, no
                  // same-origin access, no navigation (ADR-0007).
                  <iframe
                    title="proposed plan"
                    sandbox=""
                    srcDoc={prepared.status === "ready" ? prepared.doc : ""}
                    className="h-[28rem] w-full rounded-md border border-line bg-white"
                  />
                )
              ) : (
                <Markdown text={item.text} />
              )}
            </div>
          </Disclosure>
        ) : (
          <p data-selectable className="font-mono text-[11px] text-ink-faint">
            {item.planFilePath}
          </p>
        )}
      </div>
    </Panel>
  );
}
