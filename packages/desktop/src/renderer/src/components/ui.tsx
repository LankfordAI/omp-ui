import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { copyFallback } from "../lib/clipboard";
import type { Tone } from "../lib/tone";

/**
 * The shared primitive vocabulary. Every feature component composes these —
 * a colour or radius decided here is never re-decided downstream.
 */

export type { Tone };

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink-mid",
  signal: "text-signal",
  copper: "text-copper",
  rose: "text-rose",
  iris: "text-iris",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-ink-faint",
  signal: "bg-signal",
  copper: "bg-copper",
  rose: "bg-rose",
  iris: "bg-iris",
};

const TONE_CHIP: Record<Tone, string> = {
  neutral: "border-line bg-raised text-ink-mid",
  signal: "border-signal-dim/50 bg-signal-wash text-signal",
  copper: "border-copper-dim/50 bg-copper-wash text-copper",
  rose: "border-rose-dim/50 bg-rose-wash text-rose",
  iris: "border-iris-dim/50 bg-iris-wash text-iris",
};

/** One border step up: the outline hover, and the resting ring that marks a solid tonal button. */
const TONE_BORDER_RAISED: Record<Tone, string> = {
  neutral: "border-line-strong",
  signal: "border-signal-dim",
  copper: "border-copper-dim",
  rose: "border-rose-dim",
  iris: "border-iris-dim",
};

/** Full-accent border, hover-only: the solid tonal button's feedback. `neutral` is unused (solid neutral is `bg-ink`). */
const TONE_BORDER_FULL_HOVER: Record<Tone, string> = {
  neutral: "hover:border-line-strong",
  signal: "hover:border-signal",
  copper: "hover:border-copper",
  rose: "hover:border-rose",
  iris: "hover:border-iris",
};

/** Outline hover: the border strengthens; the fill never brightness-filters (light washes lift to white — issue #66). */
const TONE_BORDER_OUTLINE_HOVER: Record<Tone, string> = {
  neutral: "hover:border-line-strong",
  signal: "hover:border-signal-dim",
  copper: "hover:border-copper-dim",
  rose: "hover:border-rose-dim",
  iris: "hover:border-iris-dim",
};

/** Full-accent border, resting: the ring that marks a selected choice (Button `selected`). */
const TONE_BORDER_FULL: Record<Tone, string> = {
  neutral: "border-line-strong",
  signal: "border-signal",
  copper: "border-copper",
  rose: "border-rose",
  iris: "border-iris",
};

/** The selected-choice glyph. Rendered by Button, never by callers. */
function CheckIcon() {
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

/* ------------------------------------------------------------------ Button */

type ButtonVariant = "solid" | "ghost" | "outline";

export function Button({
  children,
  onClick,
  variant = "outline",
  tone = "neutral",
  size = "sm",
  selected,
  disabled,
  title,
  type = "button",
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  tone?: Tone;
  size?: "xs" | "sm";
  /** Marks a choice/toggle. Defined ⇒ aria-pressed is emitted and the
   *  selected/unselected paint overrides `variant`. */
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  className?: string;
}) {
  const variantClass =
    selected !== undefined
      ? selected
        ? cn(TONE_CHIP[tone], TONE_BORDER_FULL[tone], "font-semibold")
        : "border-line bg-transparent text-ink-mid hover:border-line-strong hover:text-ink"
      : variant === "solid"
        ? tone === "neutral"
          ? "bg-ink text-void hover:brightness-125"
          : cn(TONE_CHIP[tone], TONE_BORDER_RAISED[tone], TONE_BORDER_FULL_HOVER[tone])
        : variant === "ghost"
          ? cn("border-transparent bg-transparent hover:bg-hover", TONE_TEXT[tone])
          : cn(TONE_CHIP[tone], TONE_BORDER_OUTLINE_HOVER[tone]);

  // Disabled collapses every variant to one deliberate ghost: transparent
  // fill, neutral border, the theme's ink-dim text (≥3:1 on raised in every
  // curated theme — gated in themes.test.ts). Never a flat opacity: on light
  // surfaces opacity composites toward white and reads ~1.6:1 (issue #66).
  const disabledClass =
    variant === "ghost"
      ? "disabled:text-ink-dim"
      : "disabled:border-line disabled:bg-transparent disabled:text-ink-dim";

  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border font-medium",
        "transition-[background-color,border-color,color,filter,opacity] duration-150",
        "disabled:pointer-events-none",
        size === "xs" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-xs",
        variantClass,
        disabledClass,
        className,
      )}
    >
      {selected === true && <CheckIcon />}
      {children}
    </button>
  );
}

export function IconButton({
  children,
  onClick,
  label,
  tone = "neutral",
  disabled,
  className,
}: {
  children: ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  label: string;
  tone?: Tone;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md text-ink-dim",
        "transition-colors duration-150 hover:bg-hover",
        "disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent",
        tone === "rose" ? "hover:text-rose" : tone === "copper" ? "hover:text-copper" : "hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

export interface ResizeHandleProps {
  label: string;
  edge: "left" | "right";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onPreview(value: number): void;
  onCommit(value: number): void;
  onDraggingChange?(dragging: boolean): void;
}

export function ResizeHandle({
  label,
  edge,
  value,
  min,
  max,
  defaultValue,
  onPreview,
  onCommit,
  onDraggingChange,
}: ResizeHandleProps) {
  const drag = useRef<{ pointerId: number; startX: number; startValue: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const finish = (commit: boolean) => {
    const current = drag.current;
    if (current === null) return;
    drag.current = null;
    setDragging(false);
    onDraggingChange?.(false);
    if (commit) onCommit(current.value);
    else onPreview(current.startValue);
  };

  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(false);
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      className={cn(
        "group absolute inset-y-0 z-20 w-3 touch-none cursor-col-resize focus-visible:outline-none",
        edge === "right" ? "-right-1.5" : "-left-1.5",
      )}
      onPointerDown={(event) => {
        const startValue = clamp(value);
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startValue,
          value: startValue,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        onDraggingChange?.(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current === null || current.pointerId !== event.pointerId) return;
        const direction = edge === "right" ? 1 : -1;
        current.value = clamp(current.startValue + direction * (event.clientX - current.startX));
        onPreview(current.value);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) finish(true);
      }}
      onPointerCancel={(event) => {
        if (drag.current?.pointerId === event.pointerId) finish(false);
      }}
      onDoubleClick={() => {
        const reset = clamp(defaultValue);
        onPreview(reset);
        onCommit(reset);
      }}
      onKeyDown={(event) => {
        let next: number | null = null;
        if (event.key === "Home") next = min;
        else if (event.key === "End") next = max;
        else if (event.key === "ArrowLeft") next = value - 16;
        else if (event.key === "ArrowRight") next = value + 16;
        if (next === null) return;
        event.preventDefault();
        const committed = clamp(next);
        onPreview(committed);
        onCommit(committed);
      }}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line-strong opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
          dragging && "opacity-100",
        )}
      />
    </div>
  );
}

/** Shared surface, dismissal affordance, and transient timer for update cards. */
export function UpdateCard({
  children,
  dismissLabel,
  onDismiss,
  autoDismissMs,
}: {
  children: ReactNode;
  dismissLabel?: string;
  onDismiss?: () => void;
  autoDismissMs?: number;
}) {
  useEffect(() => {
    if (onDismiss === undefined || autoDismissMs === undefined) return;
    const timer = window.setTimeout(onDismiss, autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [autoDismissMs, onDismiss]);

  if (onDismiss !== undefined && !dismissLabel) {
    throw new Error("dismissLabel is required when UpdateCard is dismissible");
  }

  return (
    <div className="edge-lit animate-rise relative rounded-xl border border-line-strong bg-overlay p-4 shadow-lg">
      {onDismiss !== undefined && (
        <div className="absolute right-2 top-2">
          <IconButton label={dismissLabel!} onClick={onDismiss}>
            <IconClose />
          </IconButton>
        </div>
      )}
      <div className={onDismiss === undefined ? undefined : "pr-6"}>{children}</div>
    </div>
  );
}

/**
 * Paperclip trigger for a hidden `<input type="file" accept="image/*">` owned
 * by the caller: this is pure presentation, the picker wiring (click the
 * input, clear `input.value`, read the files) stays with the draft path using
 * it. `compact` grows the hit target to 44px for touch shells.
 */
export function AttachmentButton({
  compact = false,
  disabled,
  onClick,
}: {
  compact?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      tone="neutral"
      disabled={disabled}
      title="attach images"
      onClick={onClick}
      className={compact
        ? "h-11 min-h-11 w-11 min-w-11 justify-center p-0"
        : "size-6 justify-center p-0"}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        aria-hidden
        className="size-3.5"
      >
        <path
          d="m5.1 8.8 4.5-4.5a2.1 2.1 0 0 1 3 3l-5.7 5.6a3.4 3.4 0 0 1-4.8-4.8l5.6-5.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="sr-only">attach images</span>
    </Button>
  );
}

/* -------------------------------------------------------------------- Chip */

export function Chip({
  children,
  tone = "neutral",
  mono,
  title,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  mono?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[10px] leading-4",
        mono && "font-mono tabular-nums",
        TONE_CHIP[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A liveness dot. `pulse` is reserved for "work is happening right now". */
export function Dot({
  tone,
  pulse,
  title,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "size-1.5 shrink-0 rounded-full motion-reduce:animate-none",
        TONE_DOT[tone],
        TONE_TEXT[tone],
        pulse && "animate-breathe",
        className,
      )}
    />
  );
}

/**
 * Middle-ellipsis text: the head truncates, the tail always survives —
 * Finder-style, for names whose differentiator is at the end (directory
 * basenames). The full string stays in the accessibility tree via an
 * sr-only copy; the visible halves are aria-hidden so the mid-word seam
 * never reaches screen readers.
 *
 * The wrapper's overflow-hidden guards the pathological case where the
 * tail alone exceeds the row width: it clips instead of scrolling the
 * sidebar (the project list scroll container, Sidebar.tsx "overflow-y-auto",
 * does not clip horizontally).
 */
export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  // Split on code points, never inside a surrogate pair: a naive UTF-16
  // slice can leave a lone surrogate at the seam and render U+FFFD even
  // when nothing is truncated (e.g. emoji in directory names).
  const chars = Array.from(text);
  const split = Math.ceil(chars.length / 2);
  return (
    <span className={cn("flex overflow-hidden", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="truncate">{chars.slice(0, split).join("")}</span>
      <span aria-hidden className="shrink-0">{chars.slice(split).join("")}</span>
    </span>
  );
}

const TONE_CAPSULE: Record<Tone, string> = {
  neutral: "border-line bg-raised divide-line",
  signal: "border-signal-dim/50 bg-signal-wash divide-signal-dim/40",
  copper: "border-copper-dim/50 bg-copper-wash divide-copper-dim/40",
  rose: "border-rose-dim/50 bg-rose-wash divide-rose-dim/40",
  iris: "border-iris-dim/50 bg-iris-wash divide-iris-dim/40",
};

const CAPSULE_FRAME = "inline-flex h-6 min-w-0 shrink-0 items-stretch divide-x rounded-md border";

/**
 * A segmented control cluster: one bordered pill, hairline dividers between
 * segments. Children are flat segments (buttons/spans) — they bring no border
 * of their own. NOT overflow-hidden: segments may anchor dropdown menus, so
 * interactive segments must round their own outer corner via
 * `first:rounded-l-[5px] last:rounded-r-[5px]` (see CAPSULE_SEGMENT).
 */
export function Capsule({
  children,
  tone = "neutral",
  title,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        CAPSULE_FRAME,
        TONE_CAPSULE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Shared classes for an interactive capsule segment. */
export const CAPSULE_SEGMENT = cn(
  "flex min-w-0 items-center gap-1 px-1.5",
  "first:rounded-l-[5px] last:rounded-r-[5px]",
  "transition-colors duration-150 hover:bg-hover",
  "disabled:pointer-events-none disabled:text-ink-faint",
);

export interface ChoiceCapsuleOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
  selectedClassName?: string;
  unselectedClassName?: string;
}

/** A labelled single-choice capsule with one Tab stop and arrow-key selection. */
export function ChoiceCapsule<T extends string | number>({
  label,
  value,
  options,
  onChange,
  tone = "neutral",
  className,
  optionClassName,
}: {
  label: string;
  value: T;
  options: readonly ChoiceCapsuleOption<T>[];
  onChange: (value: T) => void;
  tone?: Tone;
  className?: string;
  optionClassName?: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const matchingIndex = options.findIndex((option) => option.value === value);
  const firstEnabledIndex = options.findIndex((option) => option.disabled !== true);
  const selectedIndex =
    matchingIndex >= 0 ? matchingIndex : firstEnabledIndex >= 0 ? firstEnabledIndex : options.length > 0 ? 0 : -1;

  const nextEnabled = (from: number, direction: -1 | 1): number => {
    for (let step = 1; step <= options.length; step += 1) {
      const candidate = (from + direction * step + options.length) % options.length;
      if (options[candidate]?.disabled !== true) return candidate;
    }
    return -1;
  };

  return (
    <span
      role="group"
      aria-label={label}
      className={cn(CAPSULE_FRAME, TONE_CAPSULE[tone], className)}
    >
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={option.value}
            ref={(button) => {
              buttons.current[index] = button;
            }}
            type="button"
            title={option.title}
            disabled={option.disabled}
            aria-pressed={selected}
            tabIndex={selected && option.disabled !== true ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const target =
                event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? nextEnabled(index, -1)
                  : event.key === "ArrowRight" || event.key === "ArrowDown"
                    ? nextEnabled(index, 1)
                    : event.key === "Home"
                      ? firstEnabledIndex
                      : event.key === "End"
                        ? nextEnabled(0, -1)
                        : null;
              if (target === null) return;

              event.preventDefault();
              const targetOption = options[target];
              if (targetOption === undefined) return;
              buttons.current[target]?.focus();
              onChange(targetOption.value);
            }}
            className={cn(
              CAPSULE_SEGMENT,
              optionClassName,
              option.className,
              selected
                ? (option.selectedClassName ?? "bg-hover text-ink")
                : (option.unselectedClassName ?? "text-ink-mid"),
            )}
          >
            {option.label}
          </button>
        );
      })}
    </span>
  );
}

/* ------------------------------------------------------------------- Panel */

/** A raised surface with a machined top edge. */
export function Panel({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: Tone;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border",
        tone === "neutral" ? "border-line bg-raised" : TONE_CHIP[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Uppercase micro-label for section headers and rail titles. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** An on/off toggle — the shared boolean switch for all feature controls. */
export function Switch({
  on,
  onChange,
  label,
  title,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-4 w-7 shrink-0 rounded-full border transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-35",
        on ? "border-signal-dim bg-signal-wash" : "border-line bg-raised hover:border-line-strong",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full transition-[left] duration-150",
          on ? "left-4 bg-signal" : "left-0.5 bg-ink-faint",
        )}
      />
    </button>
  );
}

/**
 * An indeterminate activity bar — the honest signal for "streaming".
 * `paused` freezes the sweep: motion means the stream is flowing, so a
 * stalled stream shows a frozen bar (ADR-0004).
 */
export function ProgressSweep({
  tone = "signal",
  paused = false,
}: {
  tone?: Tone;
  paused?: boolean;
}) {
  return (
    <div className="relative h-px w-full overflow-hidden bg-line">
      <div
        className={cn(
          "absolute inset-y-0 w-1/4 animate-sweep",
          TONE_DOT[tone],
          paused && "[animation-play-state:paused]",
        )}
      />
    </div>
  );
}

/**
 * An indeterminate activity ring: one lit segment looping the host's border.
 * Render it as a direct child of the rounded, `relative` host it traces — it
 * measures the host's live size and `border-top-left-radius`, so it follows
 * the box while the draft grows and re-wraps.
 */
export function PerimeterSweep({
  tone = "signal",
  segment = 0.2,
  className,
}: {
  tone?: Tone;
  /** Fraction of the perimeter the lit segment covers (0..1). */
  segment?: number;
  className?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    const path = pathRef.current;
    if (svg === null || path === null) return;
    const draw = () => {
      const { width, height } = svg.getBoundingClientRect();
      if (width <= 2 || height <= 2) return;
      // Host = the rounded box we are a direct child of. Its computed radius
      // is the source of truth, so the file's `rounded-lg` + `rounded-xl`
      // double class never leaks in as a magic number.
      const host = svg.parentElement;
      const radius =
        parseFloat(host ? getComputedStyle(host).borderTopLeftRadius : "") || 0;
      const s = 1.5; // stroke width; path inset by half so the stroke centers
      const i = s / 2; // on the host's 1px CSS border (stays fully in-bounds)
      const w = width - s;
      const h = height - s;
      const r = Math.max(0, Math.min(radius - i, w / 2, h / 2));
      path.setAttribute(
        "d",
        `M ${i + r} ${i} H ${i + w - r} A ${r} ${r} 0 0 1 ${i + w} ${i + r} ` +
          `V ${i + h - r} A ${r} ${r} 0 0 1 ${i + w - r} ${i + h} H ${i + r} ` +
          `A ${r} ${r} 0 0 1 ${i} ${i + h - r} V ${i + r} A ${r} ${r} 0 0 1 ${i + r} ${i} Z`,
      );
    };
    draw();
    // Constructed unconditionally, matching ShellDrawer/TerminalTab/TranscriptView;
    // test files stub the global (Composer.test.tsx:21-25 pattern).
    const observer = new ResizeObserver(draw);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  return (
    // An `svg` is a replaced element — `inset-0` alone leaves it at the 300×150
    // default, so the explicit size is what makes it fill the host.
    <svg
      ref={svgRef}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 h-full w-full", TONE_TEXT[tone], className)}
    >
      <path
        ref={pathRef}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={`${segment} ${1 - segment}`}
        className="animate-sweep-loop motion-reduce:animate-none"
      />
    </svg>
  );
}

/** The conic ring CSS for a PerimeterGlow: `colors` in order, closed back to the first. */
export function conicRing(colors: readonly string[], angle: number): string {
  return `conic-gradient(from ${angle}deg, ${colors.join(", ")}, ${colors[0]})`;
}

/**
 * A full-perimeter gradient ring on the host's border — the border-level echo
 * of a gradient painted on text inside. Render it as a direct child of the
 * rounded, `relative` host it traces, like PerimeterSweep. It owns no clock:
 * `phase` ∈ [0,1) rotates the ring one full turn, so the caller's existing
 * shimmer clock drives it and reduced-motion falls out of the caller pinning
 * phase to 0. Values outside [0,1) wrap, matching keywordColors.
 */
export function PerimeterGlow({
  colors,
  phase = 0,
  className,
}: {
  colors: readonly string[];
  phase?: number;
  className?: string;
}) {
  const angle = Math.round((((phase % 1) + 1) % 1) * 360);
  return (
    <div
      aria-hidden
      data-perimeter-glow
      className={cn(
        "perimeter-glow pointer-events-none absolute inset-0 rounded-[inherit]",
        className,
      )}
      style={{ "--perimeter-glow": conicRing(colors, angle) } as CSSProperties}
    />
  );
}

/* ----------------------------------------------------------------- Overlay */

const overlayStack: symbol[] = [];
let lockedOverlays = 0;
let previousBodyOverflow = "";
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useOverlay(open: boolean, onClose?: () => void) {
  const root = useRef<HTMLDivElement>(null);
  const token = useRef(Symbol("overlay"));
  const trigger = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = token.current;
    overlayStack.push(id);
    if (lockedOverlays++ === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      document.getElementById("root")?.setAttribute("inert", "");
    }

    const frame = requestAnimationFrame(() => {
      const host = root.current;
      const initial = host?.querySelector<HTMLElement>("[data-modal-initial-focus]");
      (initial ?? host?.querySelector<HTMLElement>(FOCUSABLE) ?? host)?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (overlayStack.at(-1) !== id) return;
      if (
        event.key === "Escape" &&
        event.target instanceof Node &&
        (event.target instanceof Element ? event.target : event.target.parentElement)?.closest('[role="menu"]')
      ) {
        return;
      }
      if (event.key === "Escape" && close.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) {
        event.preventDefault();
        root.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
      const at = overlayStack.lastIndexOf(id);
      if (at >= 0) overlayStack.splice(at, 1);
      if (--lockedOverlays === 0) {
        document.body.style.overflow = previousBodyOverflow;
        document.getElementById("root")?.removeAttribute("inert");
      }
      trigger.current?.focus({ preventScroll: true });
    };
  }, [open]);
  return root;
}

const SHEET_POSITION: Record<"left" | "right" | "bottom", string> = {
  left: "inset-y-0 left-0 w-[min(22rem,92vw)] border-r animate-sheet-left",
  right: "inset-y-0 right-0 w-[min(22rem,92vw)] border-l animate-sheet-right",
  bottom:
    "inset-x-0 bottom-0 max-h-[min(82dvh,var(--app-viewport-height,82dvh))] rounded-t-2xl border-t animate-sheet-up",
};

/** Past this many pixels of downward drag, releasing dismisses a bottom sheet. */
const SHEET_DISMISS_PX = 72;

export function Sheet({
  open,
  placement,
  label,
  onClose,
  children,
}: {
  open: boolean;
  placement: "left" | "right" | "bottom";
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useOverlay(open, onClose);
  // Bottom-sheet swipe-to-dismiss. The drag lives on the handle/header only,
  // so the body keeps native scrolling; transforms are written straight to the
  // node — a re-render per pointermove would fight the browser for 60fps.
  const drag = useRef<{ pointerId: number; startY: number; delta: number } | null>(null);
  if (!open) return null;

  const beginDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (placement !== "bottom") return;
    // Capturing over a control would swallow its click — the close button
    // lives inside this header. Drags start on the passive chrome only.
    if (e.target instanceof Element && e.target.closest("button") !== null) return;
    drag.current = { pointerId: e.pointerId, startY: e.clientY, delta: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    // Only downward travel moves the sheet; upward drag is a no-op, not a grow.
    d.delta = Math.max(0, e.clientY - d.startY);
    if (root.current) {
      root.current.style.transform = d.delta > 0 ? `translateY(${d.delta}px)` : "";
      root.current.style.transition = "none";
    }
  };
  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (d.delta > SHEET_DISMISS_PX) {
      onClose();
      return;
    }
    // Spring back: hand the transform to a transition, then clear it.
    if (root.current) {
      root.current.style.transition = "transform 0.2s var(--ease-out-quint)";
      root.current.style.transform = "";
    }
  };

  return createPortal(
    <div data-overlay-root className="fixed inset-0 z-[60]" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="animate-scrim pointer-events-none absolute inset-0 bg-void/65 backdrop-blur-sm" aria-hidden />
      <section
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn(
          "ambient edge-lit absolute flex max-h-[var(--app-viewport-height,100dvh)] flex-col overflow-hidden border-line-strong bg-sunken",
          SHEET_POSITION[placement],
        )}
      >
        <header
          className={cn(
            "relative shrink-0 border-b border-line",
            placement === "bottom" && "touch-none",
          )}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {placement === "bottom" && (
            <div aria-hidden className="flex justify-center pt-2">
              <span className="h-1 w-9 rounded-full bg-line-strong" />
            </div>
          )}
          <div className="flex min-h-11 items-center gap-3 px-[max(1rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))]">
            <h2 className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-ink">{label}</h2>
            <IconButton label={`close ${label}`} onClick={onClose} className="size-11">
              <IconClose />
            </IconButton>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[var(--safe-bottom)]">
          {children}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** Shared workflow overlay. Desktop keeps caller width; compact defaults full-screen. */
export function Modal({
  children,
  onClose,
  width = "w-[30rem]",
  mobile = "fullscreen",
  role = "dialog",
  labelledBy,
}: {
  children: ReactNode;
  onClose?: () => void;
  width?: string;
  mobile?: "fullscreen" | "dialog";
  role?: "dialog" | "alertdialog";
  labelledBy?: string;
}) {
  const root = useOverlay(true, onClose);
  return createPortal(
    <div
      data-overlay-root
      className="fixed inset-0 z-[70] flex items-center justify-center bg-void/70 backdrop-blur-sm"
      onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div
        ref={root}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          "ambient edge-lit animate-rise relative max-h-[min(80dvh,var(--app-viewport-height,80dvh))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line-strong bg-overlay",
          width,
          mobile === "fullscreen" ? "compact-modal-fullscreen" : "compact-modal-dialog",
        )}
      >
        {onClose && (
          <IconButton label="close dialog" onClick={onClose} className="compact-modal-close absolute right-2 top-2 z-20 hidden bg-raised">
            <IconClose />
          </IconButton>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Destructive or disruptive decision overlay with one semantic alertdialog surface. */
export function ConfirmDialog({
  kicker,
  title,
  tone,
  children,
  actions,
  onClose,
  width,
}: {
  kicker: ReactNode;
  title: ReactNode;
  tone: Tone;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  width?: string;
}) {
  const titleId = useId();

  return (
    <Modal
      role="alertdialog"
      labelledBy={titleId}
      onClose={onClose}
      width={width}
      mobile="dialog"
    >
      <header className="border-b border-line px-4 py-3.5">
        <p className={cn("mb-1 font-mono text-[10px] uppercase tracking-[0.16em]", TONE_TEXT[tone])}>
          {kicker}
        </p>
        <h2 id={titleId} className="font-display text-base font-semibold text-ink">
          {title}
        </h2>
      </header>
      <div className="px-4 py-4">{children}</div>
      <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">{actions}</footer>
    </Modal>
  );
}

/**
 * Collapsible section with a persistent chevron. Kept uncontrolled-with-default
 * because every call site wants "remember while mounted, forget on unmount".
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 text-left text-ink-dim transition-colors hover:text-ink-mid"
      >
        <Chevron open={open} />
        {summary}
      </button>
      {open && <div className="animate-rise">{children}</div>}
    </div>
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

/* -------------------------------------------------------------- Meters etc */

/**
 * Horizontal fill meter. Tone escalates with the fraction so a filling context
 * window turns copper then rose without the caller deciding. `marker` draws a
 * void-colored notch at a future landmark (the compaction threshold) cut
 * through the bar; it is chrome, not an alarm, so it stays legible in every
 * fill state without touching the hue budget.
 */
export function Meter({
  fraction,
  marker,
  className,
  title,
}: {
  fraction: number;
  /** 0–1 position of a future landmark (the compaction threshold), or null. */
  marker?: number | null;
  className?: string;
  title?: string;
}) {
  const clamped = Math.min(1, Math.max(0, fraction));
  const tone = clamped > 0.9 ? "rose" : clamped > 0.7 ? "copper" : "signal";
  const showMarker = typeof marker === "number" && marker > 0 && marker < 1;
  return (
    <div
      title={title}
      className={cn("relative h-1 w-full overflow-hidden rounded-full bg-line", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", TONE_DOT[tone])}
        style={{ width: `${clamped * 100}%` }}
      />
      {showMarker && (
        <span
          aria-hidden
          className="absolute inset-y-0 w-0.5 bg-void"
          style={{ left: `calc(${marker * 100}% - 1px)` }}
        />
      )}
    </div>
  );
}

/** Copy-to-clipboard affordance that reports success in place. */
export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = (): void => {
    setDone(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1200);
  };
  return (
    <Button
      variant="ghost"
      size="xs"
      tone={done ? "signal" : "neutral"}
      onClick={() => {
        const write = navigator.clipboard?.writeText;
        if (typeof write !== "function") {
          if (copyFallback(text)) flash();
          return;
        }
        void navigator.clipboard.writeText(text).then(flash, () => {
          // A permission-denied write still has the synchronous route left.
          if (copyFallback(text)) flash();
        });
      }}
    >
      {done ? "copied" : label}
    </Button>
  );
}

/** Empty-state block — one line of explanation, one optional action. */
export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <p className="font-display text-sm text-ink-mid">{title}</p>
      {hint && <p className="max-w-xs text-xs leading-relaxed text-ink-faint">{hint}</p>}
      {action}
    </div>
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
