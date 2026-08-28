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
