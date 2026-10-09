import { useEffect, useRef, useState, type JSX } from "react";
import type { LiveTurn } from "@omp-ui/core/live-voice";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { useCompactShell } from "../lib/responsive";
import { cn } from "../lib/cn";
import { IconButton, IconClose, IconPause, IconPlay } from "./ui";

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
  const loadLiveRecording = useStore((s) => s.loadLiveRecording);
  const playLiveRecording = useStore((s) => s.playLiveRecording);
  const pauseLiveReplay = useStore((s) => s.pauseLiveReplay);
  const resumeLiveReplay = useStore((s) => s.resumeLiveReplay);
  const liveReplay = useStore((s) => s.liveReplay);
  // #809: per-final-assistant-turn, the honest recording state — the load's
  // real status, so `ready` can drive a Play button and `incomplete` names
  // the half-written take. `unavailable` is omp ≤ 18.8.6's answer for every
  // reference (ADR-0049) — a disabled speaker that says WHY, never a silent
  // hole. Probed once per (connection, turn); the next start's new
  // connectionId re-probes.
  const [audioStates, setAudioStates] = useState<
    Record<string, "ready" | "unavailable" | "incomplete">
  >({});
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

  useEffect(() => {
    if (live === null) return;
    const connectionId = live.connectionId;
    for (const turn of live.turns) {
      if (turn.role !== "assistant" || !turn.final) continue;
      const key = `${connectionId ?? "none"}:${turn.turn}`;
      if (audioStates[key] !== undefined) continue;
      void loadLiveRecording(tabId, turn).then((load) =>
        setAudioStates((prev) =>
          prev[key] !== undefined ? prev : { ...prev, [key]: load.status },
        ),
      );
    }
  }, [live, tabId, loadLiveRecording, audioStates]);

  if (live === null) return null;

  // One final assistant row's recording control, in the strip's ml-auto
  // slot. Only the button is a control — the row stays plain text (the
  // issue rejected whole-row click targets: selection and links). The gate
  // is honest in both directions: an enabled button exists only where a
  // load answered `ready` (AC 6), and while the live output is speaking
  // the Play renders disabled with the reason as its title — a visible
  // refusal, not a silent dead click (AC 4). A clip keeps playing when
  // the session ends or the strip otherwise disappears: replay is
  // independent of the connection (#809 design).
  const recordingAffordance = (
    row: LiveTurn,
    state: "ready" | "unavailable" | "incomplete" | undefined,
  ): JSX.Element | null => {
    if (state === undefined) return null;
    if (state === "unavailable") {
      return (
        <span
          role="img"
          aria-label={t("composer.live.audioUnavailable")}
          title={t("composer.live.audioUnavailable")}
          aria-disabled="true"
          className="ml-auto shrink-0 cursor-default text-ink-faint opacity-60"
        >
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="size-3.5">
            <path d="M3 6h2.5L9 3v10L5.5 10H3z" stroke="currentColor" strokeLinejoin="round" />
            <path d="M11.5 6.5 14 9m0-2.5L11.5 9" stroke="currentColor" strokeLinecap="round" />
          </svg>
        </span>
      );
    }
    if (state === "incomplete") {
      // A half-written take is a real recording that cannot play; the
      // disabled speaker says so, same shape as the unavailable glyph.
      return (
        <span
          role="img"
          aria-label={t("composer.live.audioIncomplete")}
          title={t("composer.live.audioIncomplete")}
          aria-disabled="true"
          className="ml-auto shrink-0 cursor-default text-ink-faint opacity-60"
        >
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.4} className="size-3.5">
            <path d="M3 6h2.5L9 3v10L5.5 10H3z" stroke="currentColor" strokeLinejoin="round" />
            <path d="M12.75 8h2.5" stroke="currentColor" strokeLinecap="round" strokeDasharray="1.5 1.5" />
          </svg>
        </span>
      );
    }
    // ready: the row's clip, identified by the key the slice builds.
    const clipKey = `${tabId}:${live.connectionId}:${row.turn}`;
    const replay = liveReplay?.key === clipKey ? liveReplay : null;
    if (replay?.status === "playing") {
      return (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {replay.notice !== null && (
            <span className="text-[10px] text-ink-faint" title={t("composer.live.replayLiveBusy")}>
              {t("composer.live.phaseSpeaking")}
            </span>
          )}
          <IconButton label={t("composer.live.replayPause")} onClick={pauseLiveReplay}>
            <IconPause className="size-3" />
          </IconButton>
        </span>
      );
    }
    // Live output owns the audio while it speaks: every other Play on
    // this tab renders disabled with the reason — an enabled button the
    // slice would silently refuse is the dead-click the issue forbids
    // (AC 4). A clip the guard paused is exempt: Resume is an explicit
    // user decision, not an overlap starter.
    if (live.phase === "speaking" && replay?.status !== "paused") {
      return (
        <span className="ml-auto shrink-0">
          <IconButton label={t("composer.live.replayLiveBusy")} onClick={() => {}} disabled>
            <IconPlay className="size-3" />
          </IconButton>
        </span>
      );
    }
    if (replay?.status === "paused") {
      // Resume rides the same slot: the guard paused this clip (tab leave
      // or live output), and only a user click starts it again (AC 3).
      return (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {replay.notice !== null && (
            <span className="text-[10px] text-ink-faint" title={t("composer.live.replayLiveBusy")}>
              {t("composer.live.phaseSpeaking")}
            </span>
          )}
          <IconButton label={t("composer.live.replayPlay")} onClick={resumeLiveReplay}>
            <IconPlay className="size-3" />
          </IconButton>
        </span>
      );
    }
    return (
      <span className="ml-auto shrink-0">
        <IconButton
          label={
            replay?.status === "loading"
              ? t("composer.live.replayLoading")
              : t("composer.live.replayPlay")
          }
          onClick={() => void playLiveRecording(tabId, { kind: "turn", turn: row })}
          disabled={replay?.status === "loading"}
        >
          <IconPlay className="size-3" />
        </IconButton>
      </span>
    );
  };

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
            {turn.role === "assistant" &&
              turn.final &&
              recordingAffordance(
                turn,
                audioStates[`${live.connectionId ?? "none"}:${turn.turn}`],
              )}
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
