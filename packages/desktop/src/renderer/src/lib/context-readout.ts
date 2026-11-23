import { exactNum } from "./format";
import type { ContextUsage } from "./rpc-types";

export interface ContextReadout {
  window: number;
  fraction: number;
  percent: number;
  /** Auto-compact notch as a 0..1 fraction of the window; null = no notch. */
  marker: number | null;
  /** The exact-usage tooltip. */
  exact: string;
}

/** The context fill math the context meter and the gauge chip share. */
export function contextReadout(usage: ContextUsage, markerTokens: number | null | undefined): ContextReadout {
  const window = usage.contextWindow > 0 ? usage.contextWindow : 0;
  const fraction = window > 0 ? usage.tokens / window : 0;
  const percent = Number.isFinite(usage.percent) ? usage.percent : fraction * 100;
  const threshold =
    typeof markerTokens === "number" && window > 0
      ? { tokens: markerTokens, at: Math.min(1, Math.max(0, markerTokens / window)) }
      : null;
  const thresholdLine = threshold
    ? `omp auto-compacts when context exceeds ${exactNum(threshold.tokens)} of ${exactNum(window)} tokens (${((threshold.tokens / window) * 100).toFixed(1)}% of window)`
    : null;
  const exact = `${exactNum(usage.tokens)} of ${window > 0 ? exactNum(window) : "?"} context tokens (${percent.toFixed(2)}%)${thresholdLine ? `\n${thresholdLine}` : ""}`;
  return { window, fraction, percent, marker: threshold?.at ?? null, exact };
}

/** Context percent tone: rose past 90 %, copper past 70 %. */
export function percentTone(percent: number): string {
  return percent > 90 ? "text-rose" : percent > 70 ? "text-copper" : "text-ink-dim";
}
