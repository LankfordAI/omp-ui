import { IconButton, IconClose, IconMic } from "./ui";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import type { Dictation } from "../lib/use-dictation";

/**
 * The composer's dictation button (issue #647). Self-hides when the global
 * Voice input setting is off or the context cannot capture — a remote web
 * client on a LAN IP is a non-secure context with no getUserMedia, and the
 * button would be a dead affordance there.
 */
export function DictationControl({
  disabled,
  compact,
  voice,
}: {
  disabled: boolean;
  compact?: boolean;
  /** The hook instance owned by the Composer, shared with its Escape branch. */
  voice: Dictation;
}) {
  const t = useT();
  if (!voice.supported) return null;
  const recording = voice.phase === "recording";
  const label =
    voice.phase === "requesting"
      ? t("composer.dictation.requesting")
      : voice.phase === "transcribing"
        ? t("composer.dictation.transcribing")
        : recording
          ? t("composer.dictation.recording", { seconds: voice.seconds })
          : t("composer.dictation.start");
  return (
    <IconButton
      label={label}
      tone={recording ? "rose" : "neutral"}
      pressed={recording}
      disabled={disabled || voice.phase === "transcribing" || voice.phase === "requesting"}
      onClick={voice.toggle}
      className={cn(compact && "size-11")}
    >
      <IconMic className={compact ? "size-4" : undefined} />
    </IconButton>
  );
}

/** The inline strip beside the composer's other error rows. */
export function DictationStrip({ voice }: { voice: Dictation }) {
  const t = useT();
  if (voice.phase !== "error" || voice.error === null) return null;
  return (
    <div className="animate-rise mt-2 flex items-start gap-2 text-[11px] text-copper">
      <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="mt-px size-3.5 shrink-0">
        <path d="M8 2.5 14.5 13.5h-13z" stroke="currentColor" strokeLinejoin="round" />
        <path d="M8 7v3" stroke="currentColor" strokeLinecap="round" />
      </svg>
      <span className="min-w-0 flex-1 break-words" data-selectable>
        {voice.error}
      </span>
      <IconButton label={t("composer.dictation.dismiss")} onClick={voice.dismissError}>
        <IconClose className="size-3" />
      </IconButton>
    </div>
  );
}
