import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import type { Tone } from "../lib/tone";
import { useStore } from "../store";
import { Capsule, CAPSULE_SEGMENT, Dot, Switch } from "./ui";

/**
 * omp's fast mode (issue #677): the setting and the computed truth are
 * distinct. `enabled` is what /fast toggles; `active` is whether priority
 * serving is live — a direct Anthropic rejection leaves it false while the
 * setting stays true, and Fireworks' provider tier can keep it true while
 * the setting is false. The display follows `active`, the click verb follows
 * `enabled`: from the declined state a click re-sends enable, which is
 * exactly the retry — omp clears the sticky fallback on an explicit enable.
 */
export type FastModeState = "on" | "declined" | "off";

export function fastModeState(enabled: boolean, active: boolean): FastModeState {
  return active ? "on" : enabled ? "declined" : "off";
}

const DOT_TONE: Record<FastModeState, Tone> = {
  on: "signal",
  declined: "copper",
  off: "neutral",
};

const CAPSULE_TONE: Record<FastModeState, Tone> = DOT_TONE;

export function FastModeControl({
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
  const enabled = useStore((s) => s.rpc[tabId]?.session.fastModeEnabled ?? false);
  const active = useStore((s) => s.rpc[tabId]?.session.fastModeActive ?? false);
  const setFastMode = useStore((s) => s.setFastMode);
  const state = fastModeState(enabled, active);
  // Never guard on `target !== enabled`: the declined retry IS a same-value
  // enable. runCommand admission (starting/hibernated tabs) is runCommand's
  // own gate, matching setAutoCompaction.
  const click = () => void setFastMode(tabId, state !== "on");

  if (layout === "sheet") {
    // The switch position (`enabled`) and the state text (`active`)
    // deliberately disagree in the declined case — that disagreement IS the
    // feature: the setting is on, the provider refused to honor it.
    return (
      <div className={cn("flex min-h-11 items-center justify-between gap-2", className)}>
        <span className="flex min-w-0 flex-col">
          <span className="text-xs">{t("hud.fast.labelLong")}</span>
          <span className="font-mono text-[10px]">{t(`hud.fast.${state}`)}</span>
        </span>
        <Switch
          on={enabled}
          disabled={disabled}
          label={t("hud.fast.labelLong")}
          title={t(`hud.fast.${state}Title`)}
          onChange={(next) => void setFastMode(tabId, next)}
        />
      </div>
    );
  }

  return (
    <Capsule
      tone={CAPSULE_TONE[state]}
      title={t(`hud.fast.${state}Title`)}
      className={cn("h-6", className)}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={click}
        aria-label={t(`hud.fast.${state}Title`)}
        className={cn(CAPSULE_SEGMENT, "text-[10px] font-mono")}
      >
        <Dot tone={DOT_TONE[state]} />
        {t("hud.fast.label")}
      </button>
    </Capsule>
  );
}
