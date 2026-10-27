import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { useDismissal } from "../lib/use-dismissal";
import { useStore } from "../store";
import { MenuRow } from "./MenuRow";
import { ICON_STROKE, IconMic, IconPlus } from "./ui";

/**
 * The desktop composer footer's `+` menu (issue #939): attachments, the one
 * voice affordance the footer slot also shows (#805), and the line-start
 * draft triggers `/` `@` `!`. The compact shell keeps its own paperclip row.
 */
export function ComposerPlusMenu({
  tabId,
  disabled,
  voiceRow,
  dictateDisabled,
  liveStartBlocked,
  draftEmpty,
  onAttach,
  onDictate,
  onInsert,
}: {
  tabId: string;
  /** Composer `unavailable`. */
  disabled: boolean;
  /** Mirrors the footer's voice slot: the mic, the live capsule, or neither. */
  voiceRow: "dictate" | "live" | null;
  dictateDisabled: boolean;
  /** Dictation is recording or requesting the mic: a live start would collide. */
  liveStartBlocked: boolean;
  draftEmpty: boolean;
  /** Clicks the hidden file input; must run inside the click for user activation. */
  onAttach: () => void;
  onDictate: () => void;
  onInsert: (trigger: "/" | "@" | "!") => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const live = useStore((s) => s.rpc[tabId]?.live ?? null);
  const parked = useStore((s) => s.liveVoice[tabId]?.parked === true);
  const startLiveVoice = useStore((s) => s.startLiveVoice);
  const stopLiveVoice = useStore((s) => s.stopLiveVoice);
  const liveOn = (live !== null && !live.ended) || parked;

  const close = () => setOpen(false);
  useDismissal({
    open,
    refs: rootRef,
    onClose: close,
    onEscape: close,
    restoreFocus: () => triggerRef.current?.focus(),
  });
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  /** Close first, then act: the action may move focus (the draft triggers do). */
  const run = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <span ref={rootRef} className="relative flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("composer.plus.label")}
        title={t("composer.plus.label")}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="grid size-6 shrink-0 place-items-center rounded-md text-ink-dim transition-colors duration-150 hover:bg-hover hover:text-ink aria-expanded:bg-hover aria-expanded:text-ink disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent"
      >
        <IconPlus />
      </button>
      {open && (
        <PlusMenuPanel>
          <MenuRow
            glyph={<IconPaperclip />}
            label={t("common.button.attachFiles")}
            hint={t("composer.plus.attachHint")}
            onClick={run(onAttach)}
          />
          {voiceRow === "dictate" && (
            <MenuRow
              glyph={<IconMic />}
              label={t("composer.plus.dictate")}
              hint={t("composer.plus.dictateHint")}
              disabled={dictateDisabled}
              onClick={run(onDictate)}
            />
          )}
          {voiceRow === "live" && (
            <MenuRow
              glyph={<IconMic />}
              label={liveOn ? t("composer.live.stop") : t("composer.live.start")}
              disabled={disabled || (!liveOn && liveStartBlocked)}
              onClick={run(() => void (liveOn ? stopLiveVoice(tabId) : startLiveVoice(tabId)))}
            />
          )}
          <div className="my-1 border-t border-line" />
          <MenuRow
            glyph={<TriggerGlyph>/</TriggerGlyph>}
            label={t("composer.plus.commands")}
            disabled={!draftEmpty}
            title={draftEmpty ? undefined : t("composer.plus.emptyDraftOnly")}
            onClick={run(() => onInsert("/"))}
          />
          <MenuRow
            glyph={<TriggerGlyph>@</TriggerGlyph>}
            label={t("composer.plus.mention")}
            onClick={run(() => onInsert("@"))}
          />
          <MenuRow
            glyph={<TriggerGlyph>!</TriggerGlyph>}
            label={t("composer.plus.shell")}
            disabled={!draftEmpty}
            title={draftEmpty ? undefined : t("composer.plus.emptyDraftOnly")}
            onClick={run(() => onInsert("!"))}
          />
        </PlusMenuPanel>
      )}
    </span>
  );
}

/** The menu surface; focuses its first enabled row once, on mount. */
function PlusMenuPanel({ children }: { children: ReactNode }) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
  }, []);
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("composer.plus.label")}
      className="animate-rise edge-lit absolute bottom-full left-0 z-20 mb-1 flex w-56 flex-col rounded-md border border-line-strong bg-overlay p-1"
    >
      {children}
    </div>
  );
}

function TriggerGlyph({ children }: { children: string }) {
  return <span aria-hidden className="font-mono text-[12px] leading-none">{children}</span>;
}

function IconPaperclip() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" {...ICON_STROKE}>
      <path d="m5.1 8.8 4.5-4.5a2.1 2.1 0 0 1 3 3l-5.7 5.6a3.4 3.4 0 0 1-4.8-4.8l5.6-5.6" />
    </svg>
  );
}
