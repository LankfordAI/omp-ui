import { cn } from "../lib/cn";
import type { PreparedPlanState } from "../lib/plan-document";
import { usePreparedPlanDocument } from "../lib/use-prepared-plan-document";
import { PlanDiagnostics, PlanFallback, PlanPreparing } from "./PlanFallback";

/**
 * The one display of a prepared HTML plan (review dock, transcript PlanCard,
 * HTML plan documents in transcript messages). Pending names the wait (#652);
 * a failed or doc-less outcome shows diagnostics plus source; a document under
 * an inconclusive probe says verification was incomplete, never that display
 * failed (#415). Displayed frames keep the empty sandbox: no scripts, no
 * same-origin access, no navigation (ADR-0007, ADR-0022).
 */
export function PreparedPlanView({
  prepared,
  source,
  title,
  className,
  sourceNote = true,
}: {
  prepared: PreparedPlanState;
  /** Authored source, shown as text when no document can be displayed. */
  source: string;
  /** Accessible iframe title. */
  title: string;
  className?: string;
  /** PlanFallback's reviewed-artifact footer; false outside plan review. */
  sourceNote?: boolean;
}) {
  return prepared.status === "pending" ? (
    <PlanPreparing className={className} />
  ) : prepared.doc === null || prepared.status === "failed" ? (
    <PlanFallback
      diagnostics={prepared.diagnostics}
      source={source}
      sourceNote={sourceNote}
      className={className}
    />
  ) : (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {prepared.status === "unavailable" && (
        <PlanDiagnostics
          diagnostics={prepared.diagnostics}
          mode="verification-incomplete"
          className="shrink-0 rounded-md border border-line bg-sunken px-3 py-2 text-xs"
        />
      )}
      <iframe
        title={title}
        sandbox=""
        srcDoc={prepared.doc}
        className="min-h-0 w-full flex-1 rounded-md border border-line bg-surface"
      />
    </div>
  );
}

/**
 * An HTML plan document that arrived as transcript message text (pasted, or
 * the fresh-session seed). Display-only: it prepares through the same
 * renderer-local pipeline, carries no source identity, and never submits
 * anything; there is no gate behind it.
 */
export function PlanDocument({
  html,
  title,
  className,
}: {
  html: string;
  title: string;
  className?: string;
}) {
  const prepared = usePreparedPlanDocument(html);
  return (
    <PreparedPlanView
      prepared={prepared}
      source={html}
      title={title}
      className={className}
      sourceNote={false}
    />
  );
}
