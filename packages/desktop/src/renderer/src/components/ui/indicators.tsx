import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { cn } from "../../lib/cn";
import { TONE_DOT, TONE_TEXT, type Tone } from "./tone";

/** A liveness dot. `pulse` marks active work with a static halo, not perpetual motion. */
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
        pulse && "active-halo",
        className,
      )}
    />
  );
}

/**
 * An indeterminate activity bar: one lit segment loops the card width on the
 * compositor for as long as its host renders it (#796). Motion is transform-only
 * CSS so the animation lives on the compositor thread; `paused` freezes it
 * mid-sweep, so a stalled stream still shows a frozen bar (ADR-0004). The
 * continuous animation costs no extra frame wakes while a turn runs: the
 * composer's PerimeterSweep already keeps the compositor on a display-rate
 * clock for that whole window (#512).
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
        data-progress-sweep
        data-paused={paused || undefined}
        className={cn(
          "absolute inset-y-0 w-1/4 animate-sweep motion-reduce:animate-none",
          TONE_DOT[tone],
          paused && "[animation-play-state:paused]",
        )}
      />
    </div>
  );
}

/**
 * An indeterminate activity ring: one lit segment continuously loops the
 * host's real rounded border. Render it as a direct child of that host; it
 * measures the live box and follows draft growth and re-wrapping.
 *
 * Design contract (#512): keep the continuously animated SVG path. A conic
 * rotor and a commit-stepped dash were both shipped and explicitly rejected.
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
      const host = svg.parentElement;
      const radius =
        parseFloat(host ? getComputedStyle(host).borderTopLeftRadius : "") || 0;
      const stroke = 1.5;
      const inset = stroke / 2;
      const widthInside = width - stroke;
      const heightInside = height - stroke;
      const r = Math.max(
        0,
        Math.min(radius - inset, widthInside / 2, heightInside / 2),
      );
      path.setAttribute(
        "d",
        `M ${inset + r} ${inset} H ${inset + widthInside - r} ` +
          `A ${r} ${r} 0 0 1 ${inset + widthInside} ${inset + r} ` +
          `V ${inset + heightInside - r} A ${r} ${r} 0 0 1 ${inset + widthInside - r} ${inset + heightInside} ` +
          `H ${inset + r} A ${r} ${r} 0 0 1 ${inset} ${inset + heightInside - r} ` +
          `V ${inset + r} A ${r} ${r} 0 0 1 ${inset + r} ${inset} Z`,
      );
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  return (
    <svg
      ref={svgRef}
      aria-hidden
      data-perimeter-sweep
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full",
        TONE_TEXT[tone],
        className,
      )}
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
