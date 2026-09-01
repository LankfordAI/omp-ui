import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";

/**
 * Shown when a prepared HTML plan failed verification (issue #312): names what
 * failed and shows the raw plan source as escaped text, so plan review is
 * never a silent white void. The raw source is still the artifact the execute
 * verdict dispatches, so reviewing it as text remains a real review.
 */
export function PlanFallback({
  reason,
  source,
  className,
}: {
  reason: string;
  source: string;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("flex min-h-0 flex-col rounded-md border border-line bg-sunken", className)}>
      <p className="shrink-0 border-b border-line px-3 py-2 text-sm text-ink-dim">
        {t("plan.fallback.verificationFailed", { reason })}
      </p>
      <pre
        data-selectable
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-ink"
      >
        {source}
      </pre>
    </div>
  );
}
