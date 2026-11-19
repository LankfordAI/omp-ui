import { useImperativeHandle, type KeyboardEvent, type Ref } from "react";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { PaletteList, usePaletteNav } from "./palette";

export interface PredictionPickListHandle {
  /** Consumes Up/Down/Enter/Tab/Escape. True when handled. */
  handleKey(e: KeyboardEvent): boolean;
}

/**
 * The next-message prediction alternatives list (issue #1030), the native twin
 * of upstream editor.ts's assist list: opened by Tab over a buffer that
 * equals one of ≥2 predictions, with that row selected. Choosing swaps the
 * whole draft to the picked alternative and never submits; Escape closes it
 * without moving the buffer. Same split as StashPalette — the composer keeps
 * focus and forwards its keydown through `handleKey`, and a row's press
 * begins with preventDefault so the caret never leaves the editor.
 */
export function PredictionPickList({
  choices,
  selectedIndex,
  onPick,
  onClose,
  ref,
}: {
  /** Every alternative, most likely first. */
  choices: readonly string[];
  /** The row the buffer equals: where the list opens. */
  selectedIndex: number;
  /** Swap the draft to `index`; also called for the selected row (its pick closes the list). */
  onPick(index: number): void;
  onClose(): void;
  ref?: Ref<PredictionPickListHandle>;
}) {
  const t = useT();
  // resetKey keys the opening selection to the alternative the buffer equals.
  // rows carry the index: the palette nav hands back the row it holds.
  const rows = choices.map((choice, index) => ({ choice, index }));
  const nav = usePaletteNav({
    items: rows,
    resetKey: selectedIndex,
    initialIndex: selectedIndex,
    onPick: (row) => onPick(row.index),
    onClose,
    acceptTab: true,
  });
  const { active, setActive, activeRef } = nav;

  useImperativeHandle(
    ref,
    () => ({
      handleKey: (e) => nav.handleKey(e),
    }),
    [nav],
  );

  const shell =
    "animate-rise edge-lit absolute inset-x-0 bottom-full z-20 mb-2 rounded-lg border border-line-strong bg-overlay";

  return (
    <PaletteList
      data-prediction-picklist
      role="listbox"
      aria-label={t("composer.predict.listTitle")}
      className={cn(shell, "max-h-[min(14rem,calc(var(--app-viewport-height,100dvh)*0.35))] py-1")}
    >
      <div className="flex items-baseline gap-2 px-3 pb-1 pt-0.5">
        <span className="text-xs text-ink-dim">{t("composer.predict.listTitle")}</span>
        <span className="ml-auto text-xs text-ink-faint">{t("composer.predict.listKeys")}</span>
      </div>
      {choices.map((choice, i) => (
        <div
          key={choice}
          role="option"
          aria-selected={i === active}
          onMouseEnter={() => setActive(i)}
          className={cn("flex items-baseline gap-2 px-3", i === active ? "bg-hover" : "hover:bg-raised")}
        >
          <button
            type="button"
            ref={i === active ? activeRef : null}
            // Keep the caret in the editor when picking a row.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(i)}
            className="min-w-0 flex-1 truncate py-1 text-left text-xs text-ink"
          >
            {choice}
          </button>
        </div>
      ))}
    </PaletteList>
  );
}
