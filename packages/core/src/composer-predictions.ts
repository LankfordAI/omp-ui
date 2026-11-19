// The composer next-message prediction wire contract (issue #1239). Pure —
// zero runtime imports — because the renderer imports it through the
// @omp-ui/core/composer-predictions subpath; composer-predictions-extension.ts
// interpolates these same constants, so the publisher and the parser can
// never drift.
//
// OMP 19's TUI predicts the user's next message after a completed turn (its
// own composer-prediction-controller.ts) by running one ephemeral side turn
// over the session context. There is no RPC command or event for it — the
// only host-reachable route is an extension's ctx.runEphemeralTurn, which
// both 18.22.x and 19.0.0 expose to extension command contexts. This bridge
// takes that route: the renderer asks at a completed turn while its composer
// is empty, the bridge re-checks omp's effective `composer.predictions`
// (ADR-0036) before any billed request, runs the side turn, journals the
// spend as a `model_usage` entry with purpose "composer-prediction", and
// publishes the reply on `ui.setStatus`. Word completion (`predict_word`) is
// a different upstream feature and stays untouched.

/** setStatus key the generated bridge publishes on. Routed, never rendered raw. */
export const COMPOSER_PREDICTIONS_STATUS_KEY = "omp-ui:composer-predictions";

/** Hidden slash command: bare = arm + republish; `request <json>` = one prediction. */
export const COMPOSER_PREDICTIONS_COMMAND = "omp-ui-composer-predictions";

/** Prefix of the request arg, exactly like the side-commands render prefix. */
export const COMPOSER_PREDICTIONS_REQUEST_PREFIX = "request ";

/** Cap on one prediction reply carried by the wire; longer choices are dropped upstream. */
export const COMPOSER_PREDICTION_MAX_CHARS = 500;
/** Most alternatives one request offers; matches upstream MAX_PREDICTION_CHOICES. */
export const COMPOSER_PREDICTION_MAX_CHOICES = 4;
/** Snapshots over this many UTF-8 bytes are refused rather than trusted. */
export const COMPOSER_PREDICTIONS_STATUS_BYTE_LIMIT = 32 * 1024;

/** model_usage purpose the bridge journals its side turn under — upstream's own. */
export const COMPOSER_PREDICTION_USAGE_PURPOSE = "composer-prediction";

/** Why a request returned nothing usable. */
export const COMPOSER_PREDICTION_FAILURES = [
  /** `composer.predictions` reads off, or its effective value cannot be read: no request was ever sent. */
  "off",
  /** No bound session, no ctx.runEphemeralTurn, or the model is unset: nothing to ask. */
  "unavailable",
  /** The session was streaming or compacting when the request arrived. */
  "busy",
  /** The turn ended mid-request; the conversation moved past what was predicted. */
  "stale",
  /** The model replied NO_PREDICTION or nothing parseable. */
  "skipped",
  /** The side turn failed or timed out. */
  "failed",
] as const;
export type ComposerPredictionFailure = (typeof COMPOSER_PREDICTION_FAILURES)[number];

export interface ComposerPredictionRequest {
  requestId: string;
}

export type ComposerPredictionResult =
  | { requestId: string; ok: true; choices: string[] }
  | { requestId: string; ok: false; reason: ComposerPredictionFailure };

export interface ComposerPredictionsSnapshot {
  version: 1;
  processKey: string;
  revision: number;
  /** True when a request COULD bill: side turns reachable and the master setting reads on. */
  available: boolean;
  /** Null exactly when available. */
  unavailable: string | null;
  /** The latest request's outcome, correlated by the client's requestId; republished until replaced. */
  result: ComposerPredictionResult | null;
}

/** The hidden prompt that binds the bridge and republishes availability. */
export function composerPredictionsArmMessage(): string {
  return `/${COMPOSER_PREDICTIONS_COMMAND}`;
}

/** The hidden prompt that asks the bridge for one prediction. */
export function composerPredictionRequestMessage(request: ComposerPredictionRequest): string {
  return `/${COMPOSER_PREDICTIONS_COMMAND} ${COMPOSER_PREDICTIONS_REQUEST_PREFIX}${JSON.stringify(request)}`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function parseResult(value: unknown): ComposerPredictionResult | null | undefined {
  if (value === null) return null;
  const raw = asObject(value);
  if (raw === null || !isNonEmptyString(raw.requestId)) return undefined;
  const requestId = raw.requestId;
  if (raw.ok === true) {
    if (!Array.isArray(raw.choices) || raw.choices.length === 0) return undefined;
    if (raw.choices.length > COMPOSER_PREDICTION_MAX_CHOICES) return undefined;
    for (const choice of raw.choices) {
      if (!isNonEmptyString(choice)) return undefined;
      if (choice.length > COMPOSER_PREDICTION_MAX_CHARS) return undefined;
    }
    return { requestId, ok: true, choices: [...(raw.choices as string[])] };
  }
  if (raw.ok === false) {
    if (!COMPOSER_PREDICTION_FAILURES.includes(raw.reason as ComposerPredictionFailure)) {
      return undefined;
    }
    return { requestId, ok: false, reason: raw.reason as ComposerPredictionFailure };
  }
  return undefined;
}

/** Total parser; null for anything malformed or over the byte limit. */
export function parseComposerPredictionsSnapshot(
  text: string | undefined,
): ComposerPredictionsSnapshot | null {
  if (text === undefined) return null;
  if (new TextEncoder().encode(text).length > COMPOSER_PREDICTIONS_STATUS_BYTE_LIMIT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = asObject(parsed);
  if (raw === null) return null;
  const { version, processKey, revision, available, unavailable } = raw;
  if (version !== 1 || !isNonEmptyString(processKey)) return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
  if (typeof available !== "boolean") return null;
  if (available ? unavailable !== null : !isNonEmptyString(unavailable)) return null;
  const result = parseResult(raw.result);
  if (result === undefined) return null;
  return {
    version: 1,
    processKey,
    revision,
    available,
    unavailable: unavailable as string | null,
    result,
  };
}
