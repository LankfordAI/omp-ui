import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

/**
 * The shared primitive vocabulary. Every feature component composes these —
 * a colour or radius decided here is never re-decided downstream.
 */

export type Tone = "neutral" | "signal" | "copper" | "rose" | "iris";

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

/* ------------------------------------------------------------------ Button */

type ButtonVariant = "solid" | "ghost" | "outline";

export function Button({
  children,
  onClick,
  variant = "outline",
  tone = "neutral",
  size = "sm",
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
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  className?: string;
}) {
  const variantClass =
    variant === "solid"
      ? tone === "neutral"
        ? "bg-ink text-void hover:bg-white"
        : cn(TONE_CHIP[tone], "border-transparent brightness-110 hover:brightness-125")
      : variant === "ghost"
        ? cn("border-transparent bg-transparent hover:bg-hover", TONE_TEXT[tone])
        : cn(TONE_CHIP[tone], "hover:border-line-strong hover:brightness-125");

  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border font-medium",
        "transition-[background-color,border-color,color,filter,opacity] duration-150",
        "disabled:pointer-events-none disabled:opacity-35",
        size === "xs" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-xs",
        variantClass,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({
  children,
  onClick,
  label,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  label: string;
  tone?: Tone;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md text-ink-dim",
        "transition-colors duration-150 hover:bg-hover",
        tone === "rose" ? "hover:text-rose" : tone === "copper" ? "hover:text-copper" : "hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
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
        "size-1.5 shrink-0 rounded-full",
        TONE_DOT[tone],
        pulse && "animate-breathe",
        className,
      )}
    />
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

/** An indeterminate activity bar — the honest signal for "streaming". */
export function ProgressSweep({ tone = "signal" }: { tone?: Tone }) {
  return (
    <div className="relative h-px w-full overflow-hidden bg-line">
      <div className={cn("absolute inset-y-0 w-1/4 animate-sweep", TONE_DOT[tone])} />
    </div>
  );
}

/* ----------------------------------------------------------------- Overlay */

/**
 * Scrim + centred card. Escape and scrim-click both cancel.
 *
 * Portalled to `document.body` and positioned `fixed`: mounted inline it would
 * clip to the nearest positioned ancestor, so a modal opened from inside a
 * toolbar collapsed to that toolbar's height.
 */
export function Modal({
  children,
  onClose,
  width = "w-[30rem]",
}: {
  children: ReactNode;
  onClose?: () => void;
  width?: string;
}) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-void/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className={cn(
          "edge-lit animate-rise max-h-[80%] overflow-hidden rounded-xl border border-line-strong bg-overlay",
          width,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
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
 * window turns copper then rose without the caller deciding.
 */
export function Meter({
  fraction,
  className,
  title,
}: {
  fraction: number;
  className?: string;
  title?: string;
}) {
  const clamped = Math.min(1, Math.max(0, fraction));
  const tone = clamped > 0.9 ? "rose" : clamped > 0.7 ? "copper" : "signal";
  return (
    <div title={title} className={cn("h-1 w-full overflow-hidden rounded-full bg-line", className)}>
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", TONE_DOT[tone])}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

/** Copy-to-clipboard affordance that reports success in place. */
export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Button
      variant="ghost"
      size="xs"
      tone={done ? "signal" : "neutral"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1200);
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
