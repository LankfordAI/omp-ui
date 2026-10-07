import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { cn } from "../lib/cn";
import { IconButton, IconClose } from "./ui";

/**
 * The live voice transcript strip (issue #778): the realtime turns as the
 * `live_transcript` frames replaced them by (role, turn). Rendered beside the
 * dictation strip — a non-final entry reads as still-streaming, a clean end
 * collapses the strip, and an error row carries the dismiss affordance.
 */
export function LiveVoiceStrip({ tabId }: { tabId: string }) {
  const t = useT();
  const live = useStore((s) => s.rpc[tabId]?.live ?? null);
  const clearLiveError = useStore((s) => s.clearLiveError);
  if (live === null) return null;

  // A clean end renders nothing: the exchange is in the main transcript or
  // was idle chatter, and a lingering empty strip is noise.
  if (live.ended && live.error === null) return null;

  return (
    <div className="animate-rise mt-2 flex flex-col gap-1 text-[11px]">
      {live.turns.map((turn) => (
        <div key={`${turn.role}-${turn.turn}`} className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "shrink-0 font-mono text-[10px] uppercase tracking-[0.08em]",
              turn.role === "user" ? "text-ink-faint" : "text-signal",
            )}
          >
            {turn.role === "user" ? t("composer.live.roleUser") : t("composer.live.roleAssistant")}
          </span>
          <span
            className={cn(
              "min-w-0 break-words",
              turn.final ? "text-ink" : "text-ink-mid",
            )}
            data-selectable
          >
            {turn.text}
          </span>
        </div>
      ))}
      {live.error !== null && (
        <div className="flex items-start gap-2 text-copper">
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="mt-px size-3.5 shrink-0">
            <path d="M8 2.5 14.5 13.5h-13z" stroke="currentColor" strokeLinejoin="round" />
            <path d="M8 7v3" stroke="currentColor" strokeLinecap="round" />
          </svg>
          <span className="min-w-0 flex-1 break-words" data-selectable>
            {live.error}
          </span>
          <IconButton label={t("composer.live.dismiss")} onClick={() => clearLiveError(tabId)}>
            <IconClose className="size-3" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
