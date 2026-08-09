import { cn } from "../lib/cn";
import { useStore } from "../store";
import { Capsule, CAPSULE_SEGMENT } from "./ui";

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

  return (
    <span
      role="radiogroup"
      aria-label="session mode"
      className={cn(sheet ? "flex h-11 w-full" : "inline-flex", className)}
    >
      <Capsule className={sheet ? "h-full w-full" : undefined}>
        {([defaultAgentMode, defaultAgentMode === "plan" ? "build" : "plan"] as const).map(
          (mode) => {
            const target = mode === "plan";
            const selected = target === planEnabled;
            const alternate = mode !== defaultAgentMode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled || (target && unavailable !== undefined)}
                title={
                  target
                    ? unavailable === undefined
                      ? PLAN_TITLE
                      : `plan mode unavailable: ${unavailable}`
                    : BUILD_TITLE
                }
                onClick={() => select(target)}
                className={cn(
                  CAPSULE_SEGMENT,
                  sheet ? "flex-1 justify-center" : "text-[11px]",
                  selected
                    ? alternate
                      ? "bg-iris-wash text-iris"
                      : "bg-hover text-ink"
                    : "text-ink-mid",
                )}
              >
                {mode}
              </button>
            );
          },
        )}
      </Capsule>
    </span>
  );
}