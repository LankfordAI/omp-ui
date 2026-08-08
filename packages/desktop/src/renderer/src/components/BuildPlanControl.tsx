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
        <button
          type="button"
          role="radio"
          aria-checked={!planEnabled}
          disabled={disabled}
          title={BUILD_TITLE}
          onClick={() => select(false)}
          className={cn(
            CAPSULE_SEGMENT,
            sheet ? "flex-1 justify-center" : "text-[11px]",
            !planEnabled ? "bg-hover text-ink" : "text-ink-mid",
          )}
        >
          build
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={planEnabled}
          disabled={disabled || unavailable !== undefined}
          title={unavailable === undefined ? PLAN_TITLE : `plan mode unavailable: ${unavailable}`}
          onClick={() => select(true)}
          className={cn(
            CAPSULE_SEGMENT,
            sheet ? "flex-1 justify-center" : "text-[11px]",
            planEnabled ? "bg-iris-wash text-iris" : "text-ink-mid",
          )}
        >
          plan
        </button>
      </Capsule>
    </span>
  );
}