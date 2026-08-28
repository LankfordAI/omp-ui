import { cn } from "../../lib/cn";

/** The selected-choice glyph. Rendered by Button, never by callers. */
export function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.8} aria-hidden className="size-3.5 shrink-0">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Shared props for 16-px stroke glyphs drawn by feature components. */
export const ICON_STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** Sliders — the shared "options/settings" glyph (composer options, project settings, queue modes). */
export function IconTune({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <path d="M2 4.5h4.6M10.4 4.5H14M2 11.5h2.6M8.4 11.5H14" />
      <circle cx="8.5" cy="4.5" r="1.7" />
      <circle cx="6.5" cy="11.5" r="1.7" />
    </svg>
  );
}

/** Circular refresh arrow. */
export function IconRefresh({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <path d="M13.5 8a5.5 5.5 0 11-1.9-4.2" />
      <path d="M13.6 2v3.6H10" />
    </svg>
  );
}

export function IconClose({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.6} aria-hidden className={cn("size-2.5", className)}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/** Drag handle and keyboard reorder control for a project or session row (issues #115, #120, #274). */
export function IconGrip() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-3.5"
      fill="currentColor"
    >
      <circle cx="5.5" cy="4" r="0.9" />
      <circle cx="10.5" cy="4" r="0.9" />
      <circle cx="5.5" cy="8" r="0.9" />
      <circle cx="10.5" cy="8" r="0.9" />
      <circle cx="5.5" cy="12" r="0.9" />
      <circle cx="10.5" cy="12" r="0.9" />
    </svg>
  );
}

/** Plus — shared by every new-session and add-project affordance. */
export function IconPlus({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      className={cn(
        "size-3 shrink-0 transition-transform duration-200",
        open && "rotate-90",
        className,
      )}
    >
      <path d="M4.5 3L8 6L4.5 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Star icon for favorites. `filled` renders a solid star; outline otherwise. */
export function StarIcon({ filled, className }: { filled?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("size-3.5", className)}>
      <path
        d="M8 1.5l1.76 3.57 3.94.57-2.85 2.78.67 3.93L8 10.27 4.48 12.35l.67-3.93L2.3 5.64l3.94-.57L8 1.5z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </svg>
  );
}
