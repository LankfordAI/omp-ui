// The provider-limits wire contract. Pure — zero imports — because the
// renderer imports it directly via the @omp-ui/core/limits subpath, exactly
// like advisor-stats.ts. The generating half (which writes the extension
// file) lives in limits-extension.ts and consumes these same constants, so
// the two sides of the channel can never drift.

/**
 * `setStatus` key carrying the JSON rate-window snapshot. Routed, never
 * rendered raw.
 *
 * omp's rpc surface reports no quota state (issue #673: no `get_state`
 * field, no rpc command, no frame). The generated extension reads the root
 * `AgentSession.fetchUsageReports()` — the same surface `/usage` and the
 * TUI status line use — and publishes the reduced view over this key.
 */
export const LIMITS_STATUS_KEY = "omp-ui:limits";

/** Slash command the renderer sends to pull a fresh rate-window snapshot. */
export const LIMITS_COMMAND = "omp-ui-limits";

/** One provider rate window, e.g. Anthropic's rolling 5-hour cap. */
export interface LimitsWindow {
  /** Stable bucket id from omp's scope, e.g. "anthropic:5h"; fallback label when absent. */
  id: string;
  /** omp's display label for the window ("5 hour", "week", …). */
  label: string;
  /** 0–100 percent used, null when the provider reported only a reset time. */
  percent: number | null;
  /** Absolute wall-clock reset, ms epoch; null when unknown. */
  resetsAtMs: number | null;
}

/**
 * The stable limits wire view. The windows describe the provider the
 * session's model resolves to; per-account matrices stay in omp's `/usage`.
 */
export interface LimitsView {
  /** True when the extension reached the session and read usage at all. */
  available: boolean;
  /** Populated when the extension could not read omp's surface. */
  unavailable?: string;
  /** Provider the snapshot describes; null until a model is resolved. */
  provider: string | null;
  windows: LimitsWindow[];
  /** Banked provider rate-limit resets (Anthropic/Codex "reset credits"); 0 unknown-or-none. */
  bankedResets: number;
  /** Wall-clock ms of the snapshot; the HUD renders staleness from this. */
  fetchedAtMs: number;
}

/** Parses the JSON published on {@link LIMITS_STATUS_KEY}; null when malformed. */
export function parseLimits(text: string | undefined): LimitsView | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.available !== true) {
    // An unavailable publisher still carries the reason to show.
    if (typeof record.unavailable === "string") {
      return { available: false, unavailable: record.unavailable, provider: null, windows: [], bankedResets: 0, fetchedAtMs: 0 };
    }
    return null;
  }
  return {
    available: true,
    provider: typeof record.provider === "string" ? record.provider : null,
    windows: Array.isArray(record.windows) ? record.windows.flatMap(parseWindow) : [],
    bankedResets:
      typeof record.bankedResets === "number" && Number.isFinite(record.bankedResets)
        ? Math.max(0, Math.floor(record.bankedResets))
        : 0,
    fetchedAtMs:
      typeof record.fetchedAtMs === "number" && Number.isFinite(record.fetchedAtMs)
        ? record.fetchedAtMs
        : 0,
  };
}

/**
 * One wire entry → zero or one window. Non-finite numbers coerce to null;
 * a window with neither a percent nor a reset time says nothing (omp's own
 * OK() rule) and drops, so the HUD never renders an empty row.
 */
function parseWindow(value: unknown): LimitsWindow[] {
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.label !== "string" || record.label === "") return [];
  const percent =
    typeof record.percent === "number" && Number.isFinite(record.percent) ? record.percent : null;
  const resetsAtMs =
    typeof record.resetsAtMs === "number" && Number.isFinite(record.resetsAtMs) ? record.resetsAtMs : null;
  if (percent === null && resetsAtMs === null) return [];
  return [
    {
      id: typeof record.id === "string" && record.id !== "" ? record.id : record.label,
      label: record.label,
      percent,
      resetsAtMs,
    },
  ];
}
