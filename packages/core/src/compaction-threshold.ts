import type { OmpSettingEntry } from "./types";

/**
 * The auto-compaction threshold the HUD marks on the context meter.
 *
 * Port of omp 18.8.9:
 * - @oh-my-pi/pi-agent-core src/compaction/compaction.ts: resolveThresholdTokens
 *   + resolveBudgetReserveTokens + effectiveReserveTokens + DEFAULT_RESERVE_TOKENS
 *   (the fixed-trigger ≥-window clamp and baseWindowTokens scaling included).
 * - packages/coding-agent/src/config/compaction-threshold.ts:
 *   applyModelCompactionThreshold / matchModelCompactionThreshold /
 *   parseModelCompactionEntry (`_Bt` in the shipped bundle).
 * Trigger = `contextTokens > threshold`, checked at pre-prompt, mid-turn and
 * post-turn by pi-coding-agent session-maintenance.
 * The 0.8 "recovery band" is post-maintenance hysteresis, NOT the trigger —
 * keep it out of this module. If omp changes the formula, diff against the two
 * upstream files named here.
 */

/** omp `DEFAULT_RESERVE_TOKENS` (compaction.ts:191). */
export const COMPACTION_DEFAULT_RESERVE_TOKENS = 16384;

/** One parsed `compaction.modelThresholds` value (omp `_Bt`). */
export interface CompactionModelThreshold {
  /** -1 = unset; r in (0,100] for an `"N%"` entry. */
  thresholdPercent: number;
  /** -1 = unset; n > 0 for a plain-number or `"fN"` entry. */
  thresholdTokens: number;
  /** true only for the `f<n>` exact-trigger form. */
  fixed?: boolean;
}

/** The provider/id pair omp resolves a per-model threshold against. */
export interface ModelSelector {
  provider: string;
  id: string;
}

export interface CompactionThresholdSettings {
  /** `compaction.thresholdPercent`; omp default -1 = reserve-based default. */
  thresholdPercent?: number;
  /** `compaction.thresholdTokens`; omp default -1; overrides percent when > 0. */
  thresholdTokens?: number;
  /** `compaction.reserveTokens`; absent = COMPACTION_DEFAULT_RESERVE_TOKENS. */
  reserveTokens?: number;
  /** `compaction.modelThresholds`, values parsed per omp `_Bt`; invalid
   *  values and malformed keys dropped. */
  modelThresholds?: Record<string, CompactionModelThreshold>;
  /** `compaction.modelThresholdsEnabled`; omp default true. */
  modelThresholdsEnabled?: boolean;
}

/**
 * omp `matchModelCompactionThreshold` (`Ape`): exact `provider/id` first, else
 * the longest `provider/*` key whose stem (key minus the `*`) prefixes the
 * selector. Keys omp's validator would reject (no `/`, `*` not trailing) are
 * skipped defensively — omp rejects the whole map at config load, so a map
 * that reached us through `readOmpSettings` should already be clean.
 */
export function matchModelCompactionThreshold(
  thresholds: Record<string, CompactionModelThreshold>,
  model: ModelSelector,
): CompactionModelThreshold | null {
  const selector = `${model.provider}/${model.id}`;
  if (Object.hasOwn(thresholds, selector)) return thresholds[selector];
  let best: { key: string; threshold: CompactionModelThreshold } | null = null;
  for (const key of Object.keys(thresholds)) {
    const star = key.indexOf("*");
    if (star !== -1 && star !== key.length - 1) continue;
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1) continue;
    if (!key.endsWith("*") || !selector.startsWith(key.slice(0, -1))) continue;
    if (best === null || key.length > best.key.length) best = { key, threshold: thresholds[key] };
  }
  return best?.threshold ?? null;
}

/**
 * Token count on the context-meter axis where omp auto-compaction fires, or
 * null when the window is unknown/zero and no position can be drawn.
 *
 * `model` is the live session model (null before the first `config_update`);
 * when present and the map is enabled, a matching `modelThresholds` entry
 * folds into a local settings copy the way omp's `applyModelCompactionThreshold`
 * does — a plain number is a base (global `thresholdPercent` kept), an
 * `f<n>`/`N%` entry overrides percent and tokens. `reserveTokens` is never
 * touched by the match.
 */
export function compactionThresholdTokens(
  contextWindow: number,
  settings: CompactionThresholdSettings,
  model: ModelSelector | null = null,
): number | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  let thresholdPercent = settings.thresholdPercent;
  let thresholdTokens = settings.thresholdTokens;
  let baseWindowTokens: number | undefined;
  if (
    model !== null &&
    settings.modelThresholds !== undefined &&
    settings.modelThresholdsEnabled !== false
  ) {
    const match = matchModelCompactionThreshold(settings.modelThresholds, model);
    if (match !== null) {
      if (match.thresholdTokens > 0 && match.fixed !== true) {
        // Plain-number base: global percent survives (omp spreads the settings).
        thresholdTokens = -1;
        baseWindowTokens = match.thresholdTokens;
      } else {
        thresholdPercent = match.thresholdPercent;
        thresholdTokens = match.thresholdTokens;
      }
    }
  }
  // omp resolveThresholdTokens, in order.
  if (typeof thresholdTokens === "number" && Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
    // 18.8.8: a fixed trigger at or above the effective window is window −
    // reserve, not window − 1.
    if (thresholdTokens >= contextWindow) return windowMinusReserve(contextWindow, settings);
    return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
  }
  let e = contextWindow;
  if (typeof baseWindowTokens === "number" && Number.isFinite(baseWindowTokens) && baseWindowTokens > 0) {
    e = Math.min(e, baseWindowTokens);
  }
  if (typeof thresholdPercent !== "number" || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0) {
    return windowMinusReserve(e, settings);
  }
  const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
  return Math.floor(e * (clampedThresholdPercent / 100));
}

/** omp `KOo`: `max(0, min(e − 1, e − reserve(e)))`. */
function windowMinusReserve(
  contextWindow: number,
  settings: CompactionThresholdSettings,
): number {
  return Math.max(0, Math.min(contextWindow - 1,
    contextWindow - resolveBudgetReserveTokens(contextWindow, settings)));
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

/** omp `_Bt(value, allowFixed: true)` for one `modelThresholds` value. */
function parseModelCompactionEntry(value: unknown): CompactionModelThreshold | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0
      ? { thresholdPercent: -1, thresholdTokens: value }
      : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const fixed = /^f(\d+)$/i.exec(trimmed);
    if (fixed) {
      const tokens = Number(fixed[1]);
      return Number.isSafeInteger(tokens) && tokens > 0
        ? { thresholdPercent: -1, thresholdTokens: tokens, fixed: true }
        : undefined;
    }
    const percent = /^(\d+(?:\.\d+)?)%$/.exec(trimmed);
    const ratio = percent ? Number(percent[1]) : Number.NaN;
    return ratio > 0 && ratio <= 100 ? { thresholdPercent: ratio, thresholdTokens: -1 } : undefined;
  }
  return undefined;
}

/** Malformed keys omp's validator (`Jcl`) would reject; drop them defensively. */
function validModelSelectorKey(key: string): boolean {
  const star = key.indexOf("*");
  if (star !== -1 && star !== key.length - 1) return false;
  const slash = key.indexOf("/");
  return slash > 0 && slash !== key.length - 1;
}

/** The compaction keys out of a readOmpSettings snapshot's entries. */
export function compactionSettingsFromEntries(
  entries: OmpSettingEntry[],
): CompactionThresholdSettings {
  const num = (key: string): number | undefined => {
    const entry = entries.find((e) => e.key === key);
    if (!entry) return undefined;
    return typeof entry.value === "number" && Number.isFinite(entry.value) ? entry.value : undefined;
  };
  const bool = (key: string): boolean | undefined => {
    const entry = entries.find((e) => e.key === key);
    return entry && typeof entry.value === "boolean" ? entry.value : undefined;
  };
  const record = entries.find((e) => e.key === "compaction.modelThresholds");
  let modelThresholds: Record<string, CompactionModelThreshold> | undefined;
  if (record && typeof record.value === "object" && record.value !== null && !Array.isArray(record.value)) {
    const parsed: Record<string, CompactionModelThreshold> = {};
    let any = false;
    for (const [key, value] of Object.entries(record.value as Record<string, unknown>)) {
      if (!validModelSelectorKey(key)) continue;
      const threshold = parseModelCompactionEntry(value);
      if (!threshold) continue;
      parsed[key] = threshold;
      any = true;
    }
    if (any) modelThresholds = parsed;
  }
  return {
    thresholdPercent: num("compaction.thresholdPercent"),
    thresholdTokens: num("compaction.thresholdTokens"),
    reserveTokens: num("compaction.reserveTokens"),
    modelThresholds,
    modelThresholdsEnabled: bool("compaction.modelThresholdsEnabled"),
  };
}
