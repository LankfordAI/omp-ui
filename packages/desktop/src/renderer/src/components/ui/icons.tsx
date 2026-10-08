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

/** Magnifier — shared by search fields and find surfaces. */
export function IconSearch({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <circle cx="7" cy="7" r="4" />
      <path d="M10.2 10.2 13 13" />
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

/** Erlenmeyer flask — the Lab and every experiment affordance (issue #559). */
export function IconFlask({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <path d="M6 2h4M6.5 2v4.2L2.9 12.4A1.2 1.2 0 0 0 3.95 14.2h8.1a1.2 1.2 0 0 0 1.05-1.8L9.5 6.2V2" />
      <path d="M4.6 10.5h6.8" />
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

/** Microphone — dictation in the composer (issue #647): capsule + stem + base. */
export function IconMic({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <rect x="6" y="1.8" width="4" height="7.2" rx="2" />
      <path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0" />
      <path d="M8 11.8v2.4M5.8 14.2h4.4" />
    </svg>
  );
}

/** Speaker — live voice output in a session row (issue #807): cone + one near arc (+ one far arc when speaking). */
export function IconSpeaker({ className, waves = 1 }: { className?: string; waves?: 1 | 2 }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <path d="M2.8 6.2h2.2L8.4 3.4v9.2L5 9.8H2.8z" />
      <path d="M10.6 6a3 3 0 0 1 0 4" />
      {waves === 2 ? <path d="M12.6 4.2a5.6 5.6 0 0 1 0 7.6" /> : null}
    </svg>
  );
}

/** Counter-clockwise arrow — rewind to a prompt (issue #680). */
export function IconRewind({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <path d="M3 8a5 5 0 1 0 1.6-3.7" />
      <path d="M3 2.6v2.9h2.9" />
    </svg>
  );
}

/** Pencil — edit and resend (issue #680). */
export function IconPencil({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <path d="M11.2 2.4l2.4 2.4L5.6 12.8l-3 .6.6-3z" />
      <path d="M9.6 4l2.4 2.4" />
    </svg>
  );
}

/** Root, spine, and two elbowed children — the session tree navigator (issue #680). */
export function IconSessionTree({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <circle cx="4" cy="3.2" r="1.7" />
      <circle cx="12" cy="7.6" r="1.7" />
      <circle cx="12" cy="12.8" r="1.7" />
      <path d="M4 4.9v7.9h6.3M4 7.6h6.3" />
    </svg>
  );
}

/** Three stacked bars — sidebar groups: create, and move a project into one (issue #745). */
export function IconGroup({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)} {...ICON_STROKE}>
      <rect x="2.5" y="2.5" width="11" height="3" rx="1" />
      <rect x="2.5" y="6.5" width="11" height="3" rx="1" />
      <rect x="2.5" y="10.5" width="11" height="3" rx="1" />
    </svg>
  );
}
