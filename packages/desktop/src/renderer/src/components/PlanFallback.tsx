import { cn } from "../lib/cn";
import { useT, type MessageKey } from "../lib/i18n";
import type { PlanDiagnostic, PlanDiagnosticCode } from "@omp-ui/core/plan";

/** Stable codes are the discriminator; the catalog supplies the words. */
const DIAGNOSTIC_LABELS: Record<PlanDiagnosticCode, MessageKey> = {
  HTML_PARSE_ERROR: "plan.diagnostic.htmlParseError",
  CODE_MARKUP: "plan.diagnostic.codeMarkup",
  EXTERNAL_RESOURCE: "plan.diagnostic.externalResource",
  MERMAID_SYNTAX: "plan.diagnostic.mermaidSyntax",
  RENDER_INVARIANT: "plan.diagnostic.renderInvariant",
  EMPTY_DOCUMENT: "plan.diagnostic.emptyDocument",
  LAYOUT_EMPTY: "plan.diagnostic.layoutEmpty",
  LAYOUT_OVERFLOW: "plan.diagnostic.layoutOverflow",
  PLAN_READ_FAILED: "plan.diagnostic.planReadFailed",
  SOURCE_CHANGED: "plan.diagnostic.sourceChanged",
  VERIFIER_UNAVAILABLE: "plan.diagnostic.verifierUnavailable",
  VERIFIER_TIMEOUT: "plan.diagnostic.verifierTimeout",
  PLAN_RESOURCE_LIMIT: "plan.diagnostic.planResourceLimit",
};

/**
 * Shown when an HTML plan could not be displayed as a document (issue #312
 * reworked by the #312 follow-up): the machine diagnostics are named through
 * the localized catalog, the raw plan source is shown as escaped text, and
 * the wording NO LONGER tells the user to have the agent rewrite the plan —
 * a source defect now reaches the agent through the proposal tool result
 * BEFORE review, and anything still visible here is an application failure
 * the plan text cannot fix. The raw source remains the artifact an execute
 * verdict dispatches, so reviewing it as text stays a real review.
 */
export function PlanFallback({
  diagnostics,
  source,
  className,
}: {
  diagnostics: PlanDiagnostic[];
  source: string;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("flex min-h-0 flex-col rounded-md border border-line bg-sunken", className)}>
      <PlanDiagnostics diagnostics={diagnostics} className="shrink-0 border-b border-line px-3 py-2" />
      <pre
        data-selectable
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-ink"
      >
        {source}
      </pre>
      <p className="shrink-0 border-t border-line px-3 py-1.5 text-[11px] text-ink-faint">
        {t("plan.fallback.sourceNote")}
      </p>
    </div>
  );
}

/**
 * The localized diagnostic list shared by the fallback and the review note.
 * `mode` selects the heading: "display-failure" (the default, and the only
 * honest reading when no document is on screen) or "verification-incomplete"
 * for the warning-PLUS-document state — a prepared document shown under a
 * probe that could not conclude must never claim display failed (issue #415).
 */
export function PlanDiagnostics({
  diagnostics,
  mode = "display-failure",
  className,
}: {
  diagnostics: PlanDiagnostic[];
  mode?: "display-failure" | "verification-incomplete";
  className?: string;
}) {
  const t = useT();
  const errors = diagnostics.filter((d) => d.severity === "error");
  const shown = errors.length > 0 ? errors : diagnostics;
  return (
    <div className={cn("text-sm text-ink-dim", className)}>
      <p>
        {t(mode === "verification-incomplete" ? "plan.verification.incomplete" : "plan.fallback.couldNotDisplay")}
      </p>
      {shown.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
          {shown.slice(0, 8).map((d, i) => (
            <li key={i}>
              <span className="font-medium text-ink">
                {t(DIAGNOSTIC_LABELS[d.code])}
              </span>
              {d.location !== undefined && (
                <span className="text-ink-faint">
                  {" "}
                  · {d.location.line}:{d.location.column}
                </span>
              )}
              {d.detail !== undefined && (
                <span className="block font-mono text-[10px] text-ink-faint">{d.detail}</span>
              )}
            </li>
          ))}
          {diagnostics.length > 8 && (
            <li className="text-ink-faint">
              {t("plan.fallback.moreDiagnostics", { count: String(diagnostics.length - 8) })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
