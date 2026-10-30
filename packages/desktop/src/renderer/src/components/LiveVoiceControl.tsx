import { cn } from "../lib/cn";
import { useT, type MessageKey } from "../lib/i18n";
import { useKeybindingLabel } from "../lib/keybindings";
import type { Tone } from "../lib/tone";
import { useStore } from "../store";
import { liveDisplayPhase, type LiveDisplayPhase } from "@omp-ui/core/live-voice";
import { Capsule, CAPSULE_SEGMENT, Dot, IconButton, IconClose, IconMic, Meter, Switch } from "./ui";

/**
 * omp's live voice (issue #778): one control for start/talk/stop over three
 * native verbs. omp owns the phase machine — the display reads only the
 * snapshot the `live_*` frames patch, never a local toggle. The component
 * never gates on its own: every callsite gates on `supportsNativeLive`
 * && `canOpenLivePeer` (#968), mounting the control disabled with a
 * hint when the version gate closes it (floor plan §6) and hiding it only
 * when this client cannot open a peer. Hold-to-talk (ADR-0070) gates the
 * microphone through `live_mute`: every call starts muted, and holding the
 * talk button (or R) unmutes until release plus a short tail.
 */
const PHASE_TONE: Record<LiveDisplayPhase, Tone> = {
  connecting: "copper",
  listening: "signal",
  working: "iris",
  speaking: "signal",
  ready: "neutral",
  error: "rose",
};

const PHASE_KEY: Record<LiveDisplayPhase, MessageKey> = {
  connecting: "composer.live.phaseConnecting",
  listening: "composer.live.phaseListening",
  working: "composer.live.phaseWorking",
  speaking: "composer.live.phaseSpeaking",
  ready: "composer.live.phaseReady",
  error: "composer.live.phaseError",
};

export function LiveVoiceControl({
  tabId,
  layout = "inline",
  disabled = false,
  startDisabled = false,
  className,
}: {
  tabId: string;
  layout?: "inline" | "sheet";
  disabled?: boolean;
  /** Only new starts are gated; an existing call remains stoppable/talkable. */
  startDisabled?: boolean;
  className?: string;
}) {
  const t = useT();
  const holdLabel = useKeybindingLabel("holdToTalk");
  const live = useStore((s) => s.rpc[tabId]?.live ?? null);
  // The badge map mirrors the runtime's park flags; the parked capsule reads
  // it so an ended-but-armed snapshot stays visibly resumable (#815).
  const parked = useStore((s) => s.liveVoice[tabId]?.parked === true);
  const startLiveVoice = useStore((s) => s.startLiveVoice);
  const stopLiveVoice = useStore((s) => s.stopLiveVoice);
  const setLiveTalking = useStore((s) => s.setLiveTalking);
  const talking = useStore((s) => s.liveVoice[tabId]?.talking === true);
  const working = useStore((s) => s.rpc[tabId]?.status === "running");

  const active = live !== null && !live.ended;
  const display = live === null ? null : liveDisplayPhase(live, { talking, working });
  const levels = live?.levels ?? null;

  const talkButton = (
    <button
      type="button"
      disabled={disabled}
      aria-label={t("composer.live.holdToTalk")}
      title={t("composer.live.holdToTalkHint", { key: holdLabel })}
      aria-pressed={talking}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        void setLiveTalking(tabId, true);
      }}
      onPointerUp={() => void setLiveTalking(tabId, false)}
      onPointerCancel={() => void setLiveTalking(tabId, false)}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          void setLiveTalking(tabId, true);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          void setLiveTalking(tabId, false);
        }
      }}
      onBlur={() => void setLiveTalking(tabId, false)}
      className={cn(CAPSULE_SEGMENT, "font-mono text-ink-mid", talking && "text-ink")}
    >
      <IconMic className="size-3" />
    </button>
  );

  if (layout === "sheet") {
    return (
      <div className={cn("flex min-h-11 items-center justify-between gap-2", className)}>
        <span className="flex min-w-0 flex-col">
          <span className="text-xs">{t("composer.live.start")}</span>
          <span className="font-mono text-[10px]">
            {active && display !== null ? t(PHASE_KEY[display], { key: holdLabel }) : t("composer.live.phasePending")}
          </span>
        </span>
        {active && talkButton}
        <Switch
          on={active || parked}
          disabled={disabled || (!(active || parked) && startDisabled)}
          label={t("composer.live.start")}
          title={active || parked ? t("composer.live.stop") : t("composer.live.start")}
          onChange={(next) => void (next ? startLiveVoice(tabId) : stopLiveVoice(tabId))}
        />
      </div>
    );
  }

  if (!active) {
    // A parked call (#811) and an idle one look identical in the snapshot;
    // the badge map says which. Parked clicks stop (disarm) — the automatic
    // resume is the enter guard's or the wake's, not a click's (#815).
    if (parked) {
      return (
        <Capsule
          tone="neutral"
          title={t("composer.live.parkedHint")}
          className={cn("h-6", className)}
        >
          <button
            type="button"
            disabled={disabled}
            onClick={() => void stopLiveVoice(tabId)}
            aria-label={t("composer.live.stop")}
            className={cn(CAPSULE_SEGMENT, "text-[10px] font-mono")}
          >
            <Dot tone="neutral" />
            {t("composer.live.parked")}
          </button>
        </Capsule>
      );
    }
    return (
      <Capsule
        tone={live?.error != null ? "rose" : "neutral"}
        title={t("composer.live.start")}
        className={cn("h-6", className)}
      >
        <button
          type="button"
          disabled={disabled || startDisabled}
          onClick={() => void startLiveVoice(tabId)}
          aria-label={t("composer.live.start")}
          className={cn(CAPSULE_SEGMENT, "text-[10px] font-mono")}
        >
          <Dot tone={live?.error != null ? "rose" : "neutral"} />
          live
        </button>
      </Capsule>
    );
  }

  const phaseTone = display !== null ? PHASE_TONE[display] : "copper";
  return (
    <Capsule tone={phaseTone} title={t("composer.live.stop")} className={cn("h-6", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void stopLiveVoice(tabId)}
        aria-label={t("composer.live.stop")}
        title={t("composer.live.stop")}
        className={cn(CAPSULE_SEGMENT, "text-[10px] font-mono")}
      >
        <Dot tone={phaseTone} pulse={display === "listening" || display === "working"} />
        {display !== null ? t(PHASE_KEY[display], { key: holdLabel }) : t("composer.live.phasePending")}
      </button>
      {talkButton}
      {levels !== null && (
        <span className="flex min-w-0 items-center gap-1 px-1.5" aria-hidden>
          <span className="flex w-8 flex-col gap-px">
            <Meter fraction={levels.input} className="h-0.5" />
            <Meter fraction={levels.output} className="h-0.5" />
          </span>
        </span>
      )}
    </Capsule>
  );
}

/** The live session's error badge, shared by the capsule and the strip's dismiss. */
export function LiveErrorDismiss({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <IconButton label={label} onClick={onClick}>
      <IconClose className="size-3" />
    </IconButton>
  );
}
