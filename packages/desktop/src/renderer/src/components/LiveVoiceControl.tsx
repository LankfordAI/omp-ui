import { cn } from "../lib/cn";
import { useT, type MessageKey } from "../lib/i18n";
import type { Tone } from "../lib/tone";
import { useStore } from "../store";
import type { LivePhase } from "@omp-ui/core/live-voice";
import { Capsule, CAPSULE_SEGMENT, Dot, IconButton, IconClose, IconMic, Meter, Switch } from "./ui";

/**
 * omp's live voice (issue #778): one control for start/mute/stop over three
 * native verbs. omp owns the phase machine — the display reads only the
 * snapshot the `live_*` frames patch, never a local toggle. The component
 * never gates on its own: every callsite gates on `supportsNativeLive`
 * && `liveAudioLocalToClient` (#816), so a hidden-by-gate control can
 * never render.
 */
const PHASE_TONE: Record<LivePhase, Tone> = {
  connecting: "copper",
  listening: "signal",
  working: "iris",
  speaking: "signal",
  muted: "neutral",
  error: "rose",
};

const PHASE_KEY: Record<LivePhase, MessageKey> = {
  connecting: "composer.live.phaseConnecting",
  listening: "composer.live.phaseListening",
  working: "composer.live.phaseWorking",
  speaking: "composer.live.phaseSpeaking",
  muted: "composer.live.phaseMuted",
  error: "composer.live.phaseError",
};

export function LiveVoiceControl({
  tabId,
  layout = "inline",
  disabled = false,
  className,
}: {
  tabId: string;
  layout?: "inline" | "sheet";
  disabled?: boolean;
  className?: string;
}) {
  const t = useT();
  const live = useStore((s) => s.rpc[tabId]?.live ?? null);
  // The badge map mirrors the runtime's park flags; the parked capsule reads
  // it so an ended-but-armed snapshot stays visibly resumable (#815).
  const parked = useStore((s) => s.liveVoice[tabId]?.parked === true);
  const startLiveVoice = useStore((s) => s.startLiveVoice);
  const stopLiveVoice = useStore((s) => s.stopLiveVoice);
  const setLiveMuted = useStore((s) => s.setLiveMuted);

  const active = live !== null && !live.ended;
  const phase = live?.phase ?? null;
  const levels = live?.levels ?? null;
  const muted = phase === "muted";

  if (layout === "sheet") {
    return (
      <div className={cn("flex min-h-11 items-center justify-between gap-2", className)}>
        <span className="flex min-w-0 flex-col">
          <span className="text-xs">{t("composer.live.start")}</span>
          <span className="font-mono text-[10px]">
            {active ? t(PHASE_KEY[phase!]) : t("composer.live.phasePending")}
          </span>
        </span>
        <Switch
          on={active || parked}
          disabled={disabled}
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
          disabled={disabled}
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

  const phaseTone = phase !== null ? PHASE_TONE[phase] : "copper";
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
        <Dot tone={phaseTone} pulse={phase === "listening" || phase === "working"} />
        {phase !== null ? t(PHASE_KEY[phase]) : t("composer.live.phasePending")}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void setLiveMuted(tabId, !muted)}
        aria-label={muted ? t("composer.live.unmute") : t("composer.live.mute")}
        title={muted ? t("composer.live.unmute") : t("composer.live.mute")}
        aria-pressed={muted}
        className={cn(CAPSULE_SEGMENT, "font-mono text-ink-mid", muted && "text-ink")}
      >
        <IconMic className="size-3" />
      </button>
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
