import { isHtmlPlanPath } from "@omp-ui/core/plan";
import { useT } from "../lib/i18n";
import { usePreparedPlanDocument } from "../lib/plan-document";
import type { PlanItem } from "../lib/transcript";
import { Markdown } from "./Markdown";
import { PlanDiagnostics, PlanFallback } from "./PlanFallback";
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
  const t = useT();
  const html = item.text !== null && isHtmlPlanPath(item.planFilePath);
  return (
    <Panel className="animate-rise">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Label>{t("plan.card.proposed")}</Label>
        <span className="min-w-0 flex-1 truncate text-xs text-ink" title={item.title}>
          {item.title}
        </span>
        {item.status === "pending" && <Chip tone="copper">{t("plan.card.pending")}</Chip>}
        {item.status === "executed" && <Chip tone="signal">{t("plan.card.executed")}</Chip>}
        {item.status === "refined" && <Chip>{t("plan.card.refined")}</Chip>}
        {item.status === "invalidated" && <Chip tone="rose">{t("plan.card.invalidated")}</Chip>}
      </div>
      <div className="border-t border-line-soft px-2.5 py-2">
        {item.text !== null ? (
          <Disclosure summary={<Label>{t("plan.card.show")}</Label>}>
            <div className="mt-1">
              {html ? (
                prepared.status === "failed" ||
                (prepared.status === "unavailable" && prepared.doc === null) ? (
                  <PlanFallback
                    diagnostics={prepared.status === "failed" ? prepared.diagnostics : []}
                    source={item.text}
                    className="h-[28rem]"
                  />
                ) : (
                  <div className="flex h-[28rem] min-h-0 flex-col gap-1.5">
                    {prepared.status === "unavailable" && (
                      <PlanDiagnostics diagnostics={prepared.diagnostics} className="shrink-0 rounded-md border border-line bg-sunken px-3 py-2 text-xs" />
                    )}
                    {/* Same empty sandbox as the review modal: no scripts, no
                        same-origin access, no navigation (ADR-0007). */}
                    <iframe
                      title={t("plan.card.proposedPlan")}
                      sandbox=""
                      srcDoc={
                        prepared.status === "ready"
                          ? prepared.doc
                          : prepared.status === "unavailable"
                            ? (prepared.doc ?? "")
                            : ""
                      }
                      className="min-h-0 w-full flex-1 rounded-md border border-line bg-surface"
                    />
                  </div>
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
