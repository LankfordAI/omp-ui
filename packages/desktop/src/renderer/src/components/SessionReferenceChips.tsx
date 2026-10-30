import type { SessionReference } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { Chip, IconButton, IconClose } from "./ui";

/**
 * Session reference chips (issue #984): the referenced session's title, with
 * id, machine, and transcript path on hover. The composer passes `onRemove`;
 * the user bubble renders the same chips read-only in place of the wire block.
 */
export function SessionReferenceChips({
  references,
  onRemove,
  disabled = false,
  align = "start",
  className,
}: {
  references: readonly SessionReference[];
  onRemove?: (index: number) => void;
  disabled?: boolean;
  align?: "start" | "end";
  className?: string;
}) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t("composer.reference.chips.label")}
      className={cn("flex max-w-full flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start", className)}
    >
      {references.map((ref, i) => (
        // Index-keyed: the list is append/remove-only and one session appears once.
        <Chip
          key={i}
          tone="iris"
          className="min-w-0 max-w-full"
          title={t("composer.reference.title", { title: ref.title, session: ref.sessionId, machine: ref.machine, path: ref.path })}
        >
          <span aria-hidden className="shrink-0 font-mono">
            @
          </span>
          <span className="min-w-0 max-w-[24rem] truncate">{ref.title}</span>
          {onRemove !== undefined && (
            <IconButton
              label={t("composer.reference.remove", { title: ref.title })}
              disabled={disabled}
              tone="rose"
              onClick={() => onRemove(i)}
              className="size-4 rounded-full border border-line-strong bg-overlay"
            >
              <IconClose />
            </IconButton>
          )}
        </Chip>
      ))}
    </div>
  );
}
