import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { cn } from "../../lib/cn";
import { TONE_DOT, TONE_TEXT, type Tone } from "./tone";

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
        TONE_TEXT[tone],
        pulse && "animate-breathe",
        className,
      )}
    />
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
 * Render it as a direct child of the rounded, `relative` host it traces. The
 * rotor is sized only when that host changes, so animation frames stay in the
 * compositor while the draft grows and re-wraps.
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
  const ringRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const ring = ringRef.current;
    if (ring === null) return;

    const sizeRotor = () => {
      const { width, height } = ring.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      ring.style.setProperty(
        "--perimeter-rotor-size",
        `${Math.ceil(Math.hypot(width, height) * 1.05)}px`,
      );
    };

    sizeRotor();
    const observer = new ResizeObserver(sizeRotor);
    observer.observe(ring);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      ref={ringRef}
      aria-hidden
      data-perimeter-sweep
      className={cn(
        "perimeter-sweep pointer-events-none absolute inset-0 rounded-[inherit]",
        TONE_TEXT[tone],
        className,
      )}
      style={{ "--perimeter-segment": `${segment}turn` } as CSSProperties}
    >
      <span className="perimeter-sweep-rotor" />
    </span>
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
