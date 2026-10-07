import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { showsSlowMode } from "../lib/slow-mode";
import type { Tone } from "../lib/tone";
import { useStore } from "../store";
import { Capsule, CAPSULE_SEGMENT, Dot, Switch } from "./ui";

/**
 * omp's slow mode (issue #777, omp ≥ 18.6.3 / upstream #14153): flex-tier
 * serving on models that support it. Unlike fast mode there is one truth —
 * `slowModeEnabled` — and no sub-tiers, so the inline face is a plain
 * capsule and the sheet face a plain switch. The component owns its gate
 * (runtime version AND the capability flag), so every mount site is one
 * unconditional line; the inline capsule renders only while on, mirroring
 * the fastChip gating — the sheet row is the always-reachable entry.
 *
 * The scope rides the tooltip and the sheet's state line because on
 * Anthropic the switch writes omp's PERSISTED GLOBAL setting
 * (`providers.anthropic.slowMode`), shared by every session — the user
 * has to be able to see that before clicking.
 */
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
  const capable = useStore((s) =>
    showsSlowMode(
      s.rpc[tabId]?.capabilities?.ompVersion ?? null,
      s.rpc[tabId]?.session.slowModeSupported === true,
    ),
  );
  const enabled = useStore((s) => s.rpc[tabId]?.session.slowModeEnabled ?? false);
  const scope = useStore((s) => s.rpc[tabId]?.session.slowModeScope ?? null);
  const setSlowMode = useStore((s) => s.setSlowMode);
  if (!capable) return null;
  // runCommand admission (starting/hibernated tabs) is the command rail's own
  // gate, matching setFastMode; a same-value toggle still sends — omp's
  // answer is the computed truth, and a stale store should converge.
  const toggle = (next: boolean): void => void setSlowMode(tabId, next);
  const tone: Tone = enabled ? "signal" : "neutral";
  const baseTitle = t(enabled ? "hud.slow.onTitle" : "hud.slow.offTitle");
  const scopeClause =
    scope === null
      ? ""
      : ` · ${t(scope === "global" ? "hud.slow.scopeGlobalTitle" : "hud.slow.scopeSessionTitle")}`;

  if (layout === "sheet") {
    const scopeWord =
      enabled && scope !== null
        ? ` · ${t(scope === "global" ? "hud.slow.stageGlobal" : "hud.slow.stageSession")}`
        : "";
    return (
      <div className={cn("flex min-h-11 items-center justify-between gap-2", className)}>
        <span className="flex min-w-0 flex-col">
          <span className="text-xs">{t("hud.slow.labelLong")}</span>
          <span className="font-mono text-[10px]" title={baseTitle + scopeClause}>
            {t(enabled ? "hud.slow.on" : "hud.slow.off")}
            {scopeWord}
          </span>
        </span>
        <Switch
          on={enabled}
          disabled={disabled}
          label={t("hud.slow.labelLong")}
          title={baseTitle}
          onChange={toggle}
        />
      </div>
    );
  }

  if (!enabled) return null;
  return (
    <Capsule tone={tone} title={baseTitle + scopeClause} className={cn("h-6", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => toggle(false)}
        aria-label={baseTitle + scopeClause}
        className={cn(CAPSULE_SEGMENT, "text-[10px] font-mono")}
      >
        <Dot tone={tone} />
        {t("hud.slow.label")}
      </button>
    </Capsule>
  );
}
