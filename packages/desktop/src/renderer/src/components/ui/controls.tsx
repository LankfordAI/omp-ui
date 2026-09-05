import { useEffect, useRef, useState, type ReactNode } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn";
import { copyFallback } from "../../lib/clipboard";
import { PANEL_KEYBOARD_STEP } from "../../lib/panel-layout";
import { CheckIcon, Chevron, IconClose } from "./icons";
import { TONE_BORDER_FULL, TONE_BORDER_FULL_HOVER, TONE_BORDER_OUTLINE_HOVER, TONE_BORDER_RAISED, TONE_CAPSULE, TONE_CHIP, TONE_TEXT, type Tone } from "./tone";

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
  initialFocus,
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
  /** Claims the overlay's initial focus (ui/overlays.tsx data-modal-initial-focus). */
  initialFocus?: boolean;
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
      {...(initialFocus === true ? { "data-modal-initial-focus": "" } : {})}
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
        else if (event.key === "ArrowLeft") next = value - PANEL_KEYBOARD_STEP;
        else if (event.key === "ArrowRight") next = value + PANEL_KEYBOARD_STEP;
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
  label = "attach images",
  onClick,
}: {
  compact?: boolean;
  disabled: boolean;
  label?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      tone="neutral"
      disabled={disabled}
      title={label}
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
      <span className="sr-only">{label}</span>
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
  truncate = false,
}: {
  children: ReactNode;
  tone?: Tone;
  mono?: boolean;
  title?: string;
  className?: string;
  /**
   * Cap the chip at its container's width and ellipsize the text instead of
   * letting a long unbroken token overflow the card. For single text runs;
   * pass `title` so the full value stays reachable on hover.
   */
  truncate?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] leading-4",
        truncate ? "min-w-0 max-w-full" : "shrink-0",
        mono && "font-mono tabular-nums",
        TONE_CHIP[tone],
        className,
      )}
    >
      {truncate ? <span className="min-w-0 truncate">{children}</span> : children}
    </span>
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

/** Copy-to-clipboard affordance that reports success in place. */
export function CopyButton({
  text,
  label = "copy",
  doneLabel = "copied",
}: {
  text: string;
  label?: string;
  doneLabel?: string;
}) {
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
      {done ? doneLabel : label}
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
