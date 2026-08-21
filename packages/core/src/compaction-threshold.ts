import type { OmpSettingEntry } from "./types";

/**
 * The auto-compaction threshold the HUD marks on the context meter.
 *
 * Port of omp 17.4.0, @oh-my-pi/pi-agent-core src/compaction/compaction.ts:
 * resolveThresholdTokens + resolveBudgetReserveTokens + effectiveReserveTokens
 * + DEFAULT_RESERVE_TOKENS. Trigger = `contextTokens > threshold`, checked at
 * pre-prompt, mid-turn and post-turn by pi-coding-agent session-maintenance.
 * The 0.8 "recovery band" is post-maintenance hysteresis, NOT the trigger —
 * keep it out of this module. If omp changes the formula, diff against the
 * upstream file named here.
 */

/** omp `DEFAULT_RESERVE_TOKENS` (compaction.ts:191). */
export const COMPACTION_DEFAULT_RESERVE_TOKENS = 16384;

export interface CompactionThresholdSettings {
  /** `compaction.thresholdPercent`; omp default -1 = reserve-based default. */
  thresholdPercent?: number;
  /** `compaction.thresholdTokens`; omp default -1; overrides percent when > 0. */
  thresholdTokens?: number;
  /** `compaction.reserveTokens`; absent = COMPACTION_DEFAULT_RESERVE_TOKENS. */
  reserveTokens?: number;
}

/**
 * Token count on the context-meter axis where omp auto-compaction fires, or
 * null when the window is unknown/zero and no position can be drawn.
 */
export function compactionThresholdTokens(
  contextWindow: number,
  settings: CompactionThresholdSettings,
): number | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  const thresholdTokens = settings.thresholdTokens;
  if (typeof thresholdTokens === "number" && Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
    return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
  }
  const thresholdPercent = settings.thresholdPercent;
  if (typeof thresholdPercent !== "number" || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0) {
    return Math.max(0, Math.min(contextWindow - 1,
      contextWindow - resolveBudgetReserveTokens(contextWindow, settings)));
  }
  const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
  return Math.floor(contextWindow * (clampedThresholdPercent / 100));
}

function effectiveReserveTokens(
  contextWindow: number,
  settings: CompactionThresholdSettings,
): number {
  return Math.max(Math.floor(contextWindow * 0.15),
    settings.reserveTokens ?? COMPACTION_DEFAULT_RESERVE_TOKENS);
}

function resolveBudgetReserveTokens(
  contextWindow: number,
  settings: CompactionThresholdSettings,
): number {
  const reserveTokens = effectiveReserveTokens(contextWindow, settings);
  const proportionalReserveTokens = Math.max(1, Math.floor(contextWindow * 0.15));
  const reserveWasDefaulted = settings.reserveTokens === undefined;
  const defaultReserveIsEffectivelyImpossible =
    reserveWasDefaulted && reserveTokens >= contextWindow - proportionalReserveTokens;
  const reserveExceedsWindow = reserveTokens >= contextWindow;
  return defaultReserveIsEffectivelyImpossible || reserveExceedsWindow
    ? proportionalReserveTokens
    : reserveTokens;
}

/** The three threshold keys out of a readOmpSettings snapshot's entries. */
export function compactionSettingsFromEntries(
  entries: OmpSettingEntry[],
): CompactionThresholdSettings {
  const num = (key: string): number | undefined => {
    const entry = entries.find((e) => e.key === key);
    if (!entry) return undefined;
    return typeof entry.value === "number" && Number.isFinite(entry.value) ? entry.value : undefined;
  };
  return {
    thresholdPercent: num("compaction.thresholdPercent"),
    thresholdTokens: num("compaction.thresholdTokens"),
    reserveTokens: num("compaction.reserveTokens"),
  };
}
