import type { ServiceTier } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { modelFastTier } from "../lib/rpc-types";
import type { Tone } from "../lib/tone";
import { findRecord, useStore } from "../store";
import { Capsule, CAPSULE_SEGMENT, ChoiceCapsule, Dot, Switch } from "./ui";

/**
 * omp's fast mode (issue #677): the setting and the computed truth are
 * distinct. `enabled` is what /fast toggles; `active` is whether priority
 * serving is live — a direct Anthropic rejection leaves it false while the
 * setting stays true, and Fireworks' provider tier can keep it true while
 * the setting is false. The display follows `active`, the click verb follows
 * `enabled`: from the declined state a click re-sends enable, which is
 * exactly the retry — omp clears the sticky fallback on an explicit enable.
 *
 * Where the catalog row advertises the ultrafast tier (issue #719), the
 * sheet control becomes an off/priority/ultrafast choice: the tier is
 * omp-ui-owned (the registry record's `serviceTier`), so the capsule's
 * selection reads the record while the on/declined truth keeps riding
 * `active` — declined is a tone/title modifier, never a fourth choice.
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

/** The capsule's choices (issue #719); "off" is the same set_fast_mode(false)
 *  rail the switch's off position rides — one verb clears either tier. */
type TierChoice = "off" | ServiceTier;

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
  const model = useStore((s) => s.rpc[tabId]?.model ?? null);
  const recordTier = useStore((s) => findRecord(s.state, tabId)?.serviceTier ?? null);
  const ultrafastCapable = modelFastTier(model) === "ultrafast";
  // Capability probe (issue #719): hide the ultrafast choice only when the
  // runtime advertises /fast yet lists no ultra/ultrafast subcommand
  // (omp < 18.4.4). Commands not yet loaded → show it; omp's own notice is
  // the backstop if the catalog lied.
  const ultraAdvertised = useStore((s) => {
    const fast = s.rpc[tabId]?.commands.find((command) => command.name === "fast");
    return (
      fast === undefined ||
      (fast.subcommands ?? []).some(
        (sub) => sub.name === "ultra" || sub.name === "ultrafast",
      )
    );
  });
  const setFastMode = useStore((s) => s.setFastMode);
  const setServiceTier = useStore((s) => s.setServiceTier);
  const state = fastModeState(enabled, active);
  // Never guard on `target !== enabled`: the declined retry IS a same-value
  // enable. runCommand admission (starting/hibernated tabs) is runCommand's
  // own gate, matching setAutoCompaction. Same-value tier picks send for the
  // same reason: the declined ultrafast retry re-runs `/fast ultra`.
  const click = () => void setFastMode(tabId, state !== "on");
  const pick = (choice: TierChoice) => {
    if (choice === "off") void setFastMode(tabId, false);
    else void setServiceTier(tabId, choice);
  };
  const isUltra = ultrafastCapable && recordTier === "ultrafast";
  const inlineTitle =
    isUltra && enabled
      ? state === "declined"
        ? t("hud.fast.declinedTitle")
        : t("hud.fast.ultraTitle")
      : t(`hud.fast.${state}Title`);

  if (layout === "sheet") {
    if (ultrafastCapable) {
      const tierValue: TierChoice = !enabled
        ? "off"
        : recordTier === "ultrafast" && ultraAdvertised
          ? "ultrafast"
          : "priority";
      const titleFor = (choice: TierChoice): string =>
        choice === tierValue && state === "declined"
          ? t("hud.fast.declinedTitle")
          : choice === "off"
            ? t("hud.fast.offTitle")
            : choice === "priority"
              ? t("hud.fast.tierPriorityTitle")
              : enabled && active
                ? t("hud.fast.ultraTitle")
                : t("hud.fast.tierUltrafastTitle");
      return (
        <div className={cn("flex min-h-11 items-center justify-between gap-2", className)}>
          <span className="flex min-w-0 flex-col">
            <span className="text-xs">{t("hud.fast.labelLong")}</span>
            <span className="font-mono text-[10px]">{t(`hud.fast.${state}`)}</span>
          </span>
          <ChoiceCapsule
            label={t("hud.fast.labelLong")}
            tone={CAPSULE_TONE[state]}
            value={tierValue}
            options={[
              { value: "off" as const, label: t("hud.fast.tierOff"), title: titleFor("off"), disabled },
              { value: "priority" as const, label: t("hud.fast.tierPriority"), title: titleFor("priority"), disabled },
              ...(ultraAdvertised
                ? [{ value: "ultrafast" as const, label: t("hud.fast.tierUltrafast"), title: titleFor("ultrafast"), disabled }]
                : []),
            ]}
            onChange={pick}
          />
        </div>
      );
    }
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
      title={inlineTitle}
      className={cn("h-6", className)}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={click}
        aria-label={inlineTitle}
        className={cn(CAPSULE_SEGMENT, "text-[10px] font-mono")}
      >
        <Dot tone={DOT_TONE[state]} />
        {t("hud.fast.label")}
      </button>
    </Capsule>
  );
}
