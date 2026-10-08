import { useEffect, useRef } from "react";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { useCompactShell } from "../lib/responsive";
import { cn } from "../lib/cn";
import { IconButton, IconClose } from "./ui";

// Re-entry window for the strip's follow mode, mirroring TranscriptView's
// AT_BOTTOM_SLACK reasoning: within this many pixels of the tail, the view is
// considered at the bottom and a content change re-pins.
const FOLLOW_SLACK = 24;

/**
 * The live voice transcript strip (issue #778): the realtime turns as the
 * `live_transcript` frames replaced them by (role, turn). Rendered beside the
 * dictation strip — a non-final entry reads as still-streaming, a clean end
 * collapses the strip, and an error row carries the dismiss affordance.
 *
 * Issue #800: the strip is a bounded viewport over `live.turns`, not an
 * unbounded block. The store stays a faithful mirror of omp's frames; the
 * scroll box caps at the composer textarea's discipline (grow to a ceiling,
 * then scroll) so a long conversation never drags the composer up, and it
 * carries the composer card's own background treatment so scrolled transcript
 * never paints through the text (ADR-0026: no per-component translucency).
 */
export function LiveVoiceStrip({ tabId }: { tabId: string }) {
  const t = useT();
  const compact = useCompactShell();
  const live = useStore((s) => s.rpc[tabId]?.live ?? null);
  const clearLiveError = useStore((s) => s.clearLiveError);
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // Every hook runs before the early returns below, so hook order stays
  // stable across a render that returns null. Pin to the latest turn while
  // following; the pin's own scroll echo lands at distance 0, so the
  // positional rule in onScroll keeps `following` true — no echo guard
  // needed, per TranscriptView's pinToBottom reasoning. With `live` null the
  // box is unmounted, so box.current is null and the pin no-ops.
  useEffect(() => {
    const el = box.current;
    if (el !== null && following.current) el.scrollTop = el.scrollHeight;
  }, [live?.turns]);

  if (live === null) return null;

  // A clean end renders nothing: the exchange is in the main transcript or
  // was idle chatter, and a lingering empty strip is noise.
  if (live.ended && live.error === null) return null;

  return (
    <div
      className={cn(
        "animate-rise mt-2 rounded-lg border border-line text-[11px]",
        compact ? "bg-raised" : "ambient glass-surface",
      )}
    >
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
        }}
        className="flex max-h-[min(10rem,30dvh)] flex-col gap-1 overflow-y-auto overscroll-contain px-3 pt-2"
      >
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
      </div>
      {live.error !== null && (
        <div className="flex items-start gap-2 px-3 pb-2 pt-1 text-copper">
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
