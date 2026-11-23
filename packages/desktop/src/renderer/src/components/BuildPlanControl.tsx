import { goalOwnsSession } from "@omp-ui/core/goal";
import { cn } from "../lib/cn";
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
  const plan = useStore((s) => s.rpc[tabId]?.plan);
  const goal = useStore((s) => s.rpc[tabId]?.goal);
  const vibe = useStore((s) => s.rpc[tabId]?.vibe);
  const setPlanMode = useStore((s) => s.setPlanMode);
  const defaultAgentMode = useStore((s) => s.state?.defaultAgentMode ?? "plan");
  const planEnabled = plan?.enabled ?? false;
  const unavailable = plan?.unavailable;
  // A goal the session still owns — paused or budget-limited included — blocks
  // plan entry; only a complete one releases it. UI half of a decision whose
  // authority lives in omp (it refuses goal create/resume in plan mode) and in
  // the plan bridge's native getGoalModeState read (ADR-0046).
  const goalBlocksPlan = goalOwnsSession(goal ?? null);
  // Vibe mode owns the same single mode slot omp persists; entering Plan
  // while the director runs would overwrite it (issue #683). The generated
  // plan extension refuses the same race on the bridge side.
  const vibeBlocksPlan = vibe?.enabled === true;
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
          disabled:
            disabled ||
            (target && unavailable !== undefined) ||
            (target && goalBlocksPlan) ||
            (target && vibeBlocksPlan),
          title: target
            ? unavailable !== undefined
              ? `plan mode unavailable: ${unavailable}`
              : goalBlocksPlan
                ? "drop the current goal before entering plan mode"
                : vibeBlocksPlan
                  ? "exit vibe mode before entering plan mode"
                  : "plan mode: read-only exploration — a plan is drafted and reviewed only when you ask"
            : "build mode — working-tree writes and state-changing commands are allowed.",
          className: sheet ? "flex-1 justify-center" : "text-xs",
          selectedClassName: alternate ? "bg-iris-wash text-iris font-semibold" : "bg-hover text-ink font-semibold",
          unselectedClassName: "text-ink-faint",
        };
      })}
      onChange={(mode) => select(mode === "plan")}
      className={cn(sheet ? "h-11 w-full" : undefined, className)}
    />
  );
}