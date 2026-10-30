import { useImperativeHandle, type KeyboardEvent, type Ref } from "react";
import { cn } from "../lib/cn";
import type { StashedDraft } from "../lib/draft-stash";
import { relativeTime } from "../lib/format";
import { formatHotkey } from "../lib/hotkeys";
import { useT } from "../lib/i18n";
import { PaletteList, usePaletteNav } from "./palette";
import { Chip, IconButton, IconClose, Label } from "./ui";

export interface StashPaletteHandle {
  /** Consumes navigation keys, Enter, Delete, and Escape. True when handled. */
  handleKey(e: KeyboardEvent): boolean;
}

/** The chord that stashes a draft, or opens this picker from an empty composer. */
export const STASH_HOTKEY = "mod+alt+s";

/**
 * The draft stash picker (issue #989), opened above an empty composer: the
 * stashed drafts newest first, each with a text preview and attachment
 * count. Same split as MentionPalette — the composer's textarea keeps focus
 * and forwards its keydown through `handleKey`.
 */
export function StashPalette({
  drafts,
  onApply,
  onDelete,
  onClose,
  ref,
}: {
  drafts: readonly StashedDraft[];
  onApply(draft: StashedDraft): void;
  onDelete(draft: StashedDraft): void;
  onClose(): void;
  ref?: Ref<StashPaletteHandle>;
}) {
  const t = useT();
  const nav = usePaletteNav({ items: drafts, resetKey: null, onPick: onApply, onClose });
  const { active, setActive, activeRef } = nav;

  useImperativeHandle(
    ref,
    () => ({
      handleKey: (e) => {
        const draft = drafts[active];
        if (e.key === "Delete" && draft !== undefined) {
          e.preventDefault();
          onDelete(draft);
          return true;
        }
        return nav.handleKey(e);
      },
    }),
    [active, drafts, nav, onDelete],
  );

  const shell =
    "animate-rise edge-lit absolute inset-x-0 bottom-full z-20 mb-2 rounded-lg border border-line-strong bg-overlay";

  if (drafts.length === 0) {
    return (
      <div data-stash-palette className={cn(shell, "px-3 py-2.5")}>
        <p className="text-xs text-ink-dim">{t("composer.stash.empty", { key: formatHotkey(STASH_HOTKEY) })}</p>
      </div>
    );
  }

  return (
    <PaletteList
      data-stash-palette
      role="listbox"
      aria-label={t("composer.stash.title")}
      className={cn(shell, "max-h-[min(18rem,calc(var(--app-viewport-height,100dvh)*0.45))] py-1")}
    >
      <div className="flex items-baseline gap-2 px-3 pb-1 pt-0.5">
        <Label>{t("composer.stash.title")}</Label>
        <span className="ml-auto text-[10px] text-ink-faint">{t("composer.stash.keys")}</span>
      </div>
      {drafts.map((draft, i) => {
        const preview = draft.text.trim().split("\n")[0] ?? "";
        const attached = draft.images.length + draft.documents.length + draft.annotations.length;
        return (
          <div
            key={draft.id}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            className={cn("group/stash flex items-center gap-2 px-3", i === active ? "bg-hover" : "hover:bg-raised")}
          >
            <button
              type="button"
              ref={i === active ? activeRef : null}
              // Keep the caret in the textarea: a blur would tear the picker down.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onApply(draft)}
              className="flex min-w-0 flex-1 items-baseline gap-2 py-1 text-left"
            >
              <span className={cn("min-w-0 flex-1 truncate text-xs", preview === "" ? "italic text-ink-faint" : "text-ink")}>
                {preview === "" ? t("composer.stash.noText") : preview}
              </span>
              {attached > 0 && <Chip tone="iris">{t("composer.stash.attached", { n: attached })}</Chip>}
              <span className="shrink-0 text-[10px] text-ink-faint">
                {relativeTime(new Date(draft.stashedAt).toISOString())}
              </span>
            </button>
            <span onMouseDown={(e) => e.preventDefault()}>
              <IconButton
                label={t("composer.stash.delete")}
                tone="rose"
                onClick={() => onDelete(draft)}
                className="size-5 opacity-0 transition-opacity group-hover/stash:opacity-100 focus-visible:opacity-100"
              >
                <IconClose />
              </IconButton>
            </span>
          </div>
        );
      })}
    </PaletteList>
  );
}
