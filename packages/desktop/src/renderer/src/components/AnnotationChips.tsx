import { annotationQuotePreview, type Annotation } from "../lib/annotations";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { IconButton, IconClose } from "./ui";

/** The full quote and comment, for the chip's hover title. */
function annotationTitle(annotation: Annotation): string {
  const quote = annotation.quote.split("\n").map((line) => `> ${line}`).join("\n");
  return annotation.comment === "" ? quote : `${quote}\n${annotation.comment}`;
}

/**
 * Annotation chips (issue #983): a truncated quote plus its comment. The
 * composer and the plan review's refine box pass `onRemove`; the user bubble
 * renders the same chips read-only in place of the wire block.
 */
export function AnnotationChips({
  annotations,
  onRemove,
  disabled = false,
  align = "start",
  className,
}: {
  annotations: readonly Annotation[];
  onRemove?: (index: number) => void;
  disabled?: boolean;
  align?: "start" | "end";
  className?: string;
}) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t("annotation.chips.label")}
      className={cn(
        "flex max-w-full flex-wrap gap-1.5",
        align === "end" ? "justify-end" : "justify-start",
        className,
      )}
    >
      {annotations.map((annotation, i) => (
        <div
          // Index-keyed: the list is append/remove-only and has no stable id.
          key={i}
          title={annotationTitle(annotation)}
          className="flex min-w-0 max-w-full items-start gap-1 rounded border border-iris-dim/50 bg-iris-wash px-1.5 py-1 text-left text-[11px] leading-4 text-ink"
        >
          <div className="min-w-0 max-w-[28rem]">
            <p className="truncate border-l-2 border-iris-dim/70 pl-1.5 italic text-ink-dim">
              {annotationQuotePreview(annotation.quote)}
            </p>
            {annotation.comment !== "" && (
              <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words">{annotation.comment}</p>
            )}
          </div>
          {onRemove !== undefined && (
            <IconButton
              label={t("annotation.chips.remove", { n: i + 1 })}
              disabled={disabled}
              tone="rose"
              onClick={() => onRemove(i)}
              className="size-4 shrink-0 rounded-full border border-line-strong bg-overlay"
            >
              <IconClose />
            </IconButton>
          )}
        </div>
      ))}
    </div>
  );
}
