import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { ChoiceCapsule } from "./ui";


export function BuildPlanControl({
  tabId,
  layout = "inline",
  disabled = false,
  onSelected,
  className,
}: {
  tabId: string;
  layout?: "inline" | "sheet";
  disabled?: boolean;
  onSelected?: () => void;
  className?: string;
}) {
  const t = useT();
  const plan = useStore((s) => s.rpc[tabId]?.plan);
  const setPlanMode = useStore((s) => s.setPlanMode);
  const defaultAgentMode = useStore((s) => s.state?.defaultAgentMode ?? "plan");
  const planEnabled = plan?.enabled ?? false;
  const unavailable = plan?.unavailable;
  const sheet = layout === "sheet";

  const select = (target: boolean) => {
    if (target !== planEnabled) void setPlanMode(tabId, target);
    onSelected?.();
  };

  const modes = [defaultAgentMode, defaultAgentMode === "plan" ? "build" : "plan"] as const;

  return (
    <ChoiceCapsule
      label={t("hud.mode.sessionMode")}
      value={planEnabled ? "plan" : "build"}
      options={modes.map((mode) => {
        const target = mode === "plan";
        const alternate = mode !== defaultAgentMode;
        return {
          value: mode,
          label: mode,
          disabled: disabled || (target && unavailable !== undefined),
          title: target
            ? unavailable === undefined
              ? t("hud.mode.planDescription")
              : t("hud.mode.planUnavailable", { unavailable })
            : t("hud.mode.buildDescription"),
          className: sheet ? "flex-1 justify-center" : "text-[11px]",
          selectedClassName: alternate ? "bg-iris-wash text-iris" : "bg-hover text-ink",
          unselectedClassName: "text-ink-mid",
        };
      })}
      onChange={(mode) => select(mode === "plan")}
      className={cn(sheet ? "h-11 w-full" : undefined, className)}
    />
  );
}