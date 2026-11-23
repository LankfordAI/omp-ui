import { cn } from "../lib/cn";
import type { PlanDiagnostic, PlanDiagnosticCode } from "@omp-ui/core/plan";

/** Stable codes are the discriminator; this map supplies the words. */
const DIAGNOSTIC_LABELS: Record<PlanDiagnosticCode, string> = {
  HTML_PARSE_ERROR: "malformed HTML",
  CODE_MARKUP: "markup inside a code or diagram block that should have been escaped",
  EXTERNAL_RESOURCE: "an external resource the plan document cannot load",
  MERMAID_SYNTAX: "a mermaid diagram that does not parse",
  RENDER_INVARIANT: "omp-ui could not prepare or verify the document (an application failure — not a fault in the plan)",
  EMPTY_DOCUMENT: "no visible content after preparation",
  LAYOUT_EMPTY: "the document laid out no visible content",
  LAYOUT_OVERFLOW: "content overflows the document horizontally",
  PLAN_READ_FAILED: "the plan artifact could not be read",
  SOURCE_CHANGED: "the plan changed after validation",
  VERIFIER_UNAVAILABLE: "verification could not conclude (an application failure — not a fault in the plan)",
  VERIFIER_TIMEOUT: "verification timed out (an application failure — not a fault in the plan)",
  PLAN_RESOURCE_LIMIT: "the plan exceeded a verifier resource limit",
};

/**
 * Shown when an HTML plan could not be displayed as a document (issue #312
 * reworked by the #312 follow-up): the machine diagnostics are named through
 * the localized catalog, the raw plan source is shown as escaped text, and
 * the wording NO LONGER tells the user to have the agent rewrite the plan —
 * a source defect now reaches the agent through the proposal tool result
 * BEFORE review, and anything still visible here is an application failure
 * the plan text cannot fix. The raw source remains the artifact an execute
 * verdict dispatches, so reviewing it as text stays a real review. That
 * footer speaks only for a reviewed artifact: transcript message text passes
 * `sourceNote={false}`.
 */
export function PlanFallback({
  diagnostics,
  source,
  className,
  sourceNote = true,
}: {
  diagnostics: PlanDiagnostic[];
  source: string;
  className?: string;
  /** The reviewed-artifact footer; false outside plan review. */
  sourceNote?: boolean;
}) {
  return (
    <div className={cn("flex min-h-0 flex-col rounded-md border border-line bg-sunken", className)}>
      <PlanDiagnostics diagnostics={diagnostics} className="shrink-0 border-b border-line px-3 py-2" />
      <pre
        data-selectable
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed text-ink"
      >
        {source}
      </pre>
      {sourceNote && (
        <p className="shrink-0 border-t border-line px-3 py-1.5 text-xs text-ink-faint">
          The artifact on disk is unchanged. Reviewing this source is a real review — execute only if it reads right.
        </p>
      )}
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
  const errors = diagnostics.filter((d) => d.severity === "error");
  const shown = errors.length > 0 ? errors : diagnostics;
  return (
    <div className={cn("text-sm text-ink-dim", className)}>
      <p>
        {mode === "verification-incomplete" ? "This plan is displayed below, but omp-ui could not finish checking its layout." : "This plan could not be displayed as a document."}
      </p>
      {shown.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
          {shown.slice(0, 8).map((d, i) => (
            <li key={i}>
              <span className="font-medium text-ink">
                {DIAGNOSTIC_LABELS[d.code]}
              </span>
              {d.location !== undefined && (
                <span className="text-ink-faint">
                  {" "}
                  · {d.location.line}:{d.location.column}
                </span>
              )}
              {d.detail !== undefined && (
                <span className="block font-mono text-xs text-ink-faint">{d.detail}</span>
              )}
            </li>
          ))}
          {diagnostics.length > 8 && (
            <li className="text-ink-faint">
              {`(+${String(diagnostics.length - 8)} more)`}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Status while preparation is still in flight (issue #652): an empty-srcDoc
 * iframe is a blank white document, never a status — the surface must say what
 * it is waiting for instead of rendering one. */
export function PlanPreparing({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center rounded-md border border-line bg-sunken px-3 py-6",
        className,
      )}
    >
      <p className="text-sm text-ink-dim">preparing the plan…</p>
    </div>
  );
}
