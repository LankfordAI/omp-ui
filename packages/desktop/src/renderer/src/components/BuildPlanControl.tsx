import { cn } from "../lib/cn";
import { useStore } from "../store";
import { ChoiceCapsule } from "./ui";

const BUILD_TITLE = "build mode — working-tree writes and state-changing commands are allowed.";
const PLAN_TITLE =
  "plan mode: read-only exploration — a plan is drafted and reviewed only when you ask";

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
      label="session mode"
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
              ? PLAN_TITLE
              : `plan mode unavailable: ${unavailable}`
            : BUILD_TITLE,
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