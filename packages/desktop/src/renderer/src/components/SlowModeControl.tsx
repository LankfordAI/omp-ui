import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import type { Tone } from "../lib/tone";
import { useStore } from "../store";
import { Capsule, CAPSULE_SEGMENT, Dot, Switch } from "./ui";

/**
 * omp's slow mode (issue #777): one boolean setting, the computed truth the
 * `set_slow_mode` response reports. There is no declined state and no tier —
 * where fast mode splits setting from provider truth, slow mode's truth is
 * the response's `enabled`, so the display and the switch read the same field.
 *
 * The component never gates on support: every callsite gates on
 * `session.slowModeSupported`, so a hidden-by-gate control can never render a
 * stale toggle. Global scope (the persisted `providers.anthropic.slowMode`,
 * shared by every session and terminal) is called out in the title text — a
 * remote change emits no event, so the value may lag until the next get_state.
 */
const DOT_TONE = { on: "copper", off: "neutral" } as const satisfies Record<
  "on" | "off",
  Tone
>;

export function SlowModeControl({
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
  const enabled = useStore((s) => s.rpc[tabId]?.session.slowModeEnabled ?? false);
  const scope = useStore((s) => s.rpc[tabId]?.session.slowModeScope ?? null);
  const setSlowMode = useStore((s) => s.setSlowMode);
  // runCommand admission (starting/hibernated tabs) is runCommand's own gate,
  // matching setFastMode/setAutoCompaction — no same-value skip here either:
  // a global-scope click while another session holds the value must still
  // re-read, and can still re-enter a low-priority window.
  const title = enabled
    ? t(scope === "global" ? "hud.slow.onGlobalTitle" : "hud.slow.onTitle")
    : t(scope === "global" ? "hud.slow.offGlobalTitle" : "hud.slow.offTitle");

  if (layout === "sheet") {
    return (
      <div className={cn("flex min-h-11 items-center justify-between gap-2", className)}>
        <span className="flex min-w-0 flex-col">
          <span className="text-xs">{t("hud.slow.labelLong")}</span>
          <span className="font-mono text-[10px]">{t(enabled ? "hud.slow.on" : "hud.slow.off")}</span>
        </span>
        <Switch
          on={enabled}
          disabled={disabled}
          label={t("hud.slow.labelLong")}
          title={title}
          onChange={(next) => void setSlowMode(tabId, next)}
        />
      </div>
    );
  }

  return (
    <Capsule tone={enabled ? "copper" : "neutral"} title={title} className={cn("h-6", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void setSlowMode(tabId, !enabled)}
        aria-label={title}
        className={cn(CAPSULE_SEGMENT, "text-[10px] font-mono")}
      >
        <Dot tone={DOT_TONE[enabled ? "on" : "off"]} />
        {t("hud.slow.label")}
      </button>
    </Capsule>
  );
}
