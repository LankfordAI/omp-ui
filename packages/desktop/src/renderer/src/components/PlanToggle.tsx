import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { useStore } from "../store";
import { Button } from "./ui";

/**
 * The plan-mode toggle, shared by the session HUD and the composer so every
 * surface shows the same state and the same unavailable contract. All paths
 * drive the one in-process toggle (ADR-0007): setPlanMode sends
 * /omp-ui-plan on|off, and the extension's published status — never the click
 * — is what re-renders this button.
 *
 * "On" means read-only-first (ADR-0013): omp's own write guard is armed and the
 * agent answers in place. It no longer force-injects omp's per-turn plan
 * authoring mandate, so a plan is drafted and gated on review only when the
 * user's prompt asks for one.
 */

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)}>
      {children}
    </svg>
  );
}

function IconPlan() {
  return (
    <Svg>
      <path {...S} d="M4.5 2.5h5l3 3v8a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
      <path {...S} d="M9.5 2.5v3h3" />
      <path {...S} d="M6.5 9.5l1.25 1.25 2.25-2.5" />
    </Svg>
  );
}

export function PlanToggle({
  tabId,
  layout = "inline",
  disabled = false,
  onToggled,
  className,
}: {
  tabId: string;
  /** "inline" = control-row button (icon + label); "sheet" = compact-sheet grid button (text only). */
  layout?: "inline" | "sheet";
  disabled?: boolean;
  /** Fires right after the toggle is sent — the composer uses it to reclaim the caret. */
  onToggled?: () => void;
  className?: string;
}) {
  const plan = useStore((s) => s.rpc[tabId]?.plan);
  const setPlanMode = useStore((s) => s.setPlanMode);
  // The extension reaches omp's plan API through unsupported surface, so it
  // reports `unavailable` rather than letting the toggle lie.
  const unavailable = plan?.unavailable;
  const toggle = () => {
    void setPlanMode(tabId, !(plan?.enabled ?? false));
    onToggled?.();
  };
  if (layout === "sheet") {
    return (
      <Button
        selected={plan?.enabled ?? false}
        tone="iris"
        disabled={disabled || unavailable !== undefined}
        title={unavailable ? `plan mode unavailable: ${unavailable}` : undefined}
        onClick={toggle}
        className={className}
      >
        plan
      </Button>
    );
  }
  return (
    <Button
      size="xs"
      variant={plan?.enabled ? "solid" : "ghost"}
      tone="iris"
      disabled={disabled || unavailable !== undefined}
      title={
        unavailable
          ? `plan mode unavailable: ${unavailable}`
          : plan?.enabled
            ? "leave plan mode (restores write access)"
            : "plan mode: read-only exploration — a plan is drafted and reviewed only when you ask"
      }
      onClick={toggle}
      className={className}
    >
      <IconPlan />
      <span className="hidden lg:inline">plan</span>
    </Button>
  );
}