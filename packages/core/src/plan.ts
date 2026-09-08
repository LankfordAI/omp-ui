import type { PlanFormat } from "./types";

// The plan-mode wire contract. Pure — the type-only import is erased — because
// the renderer imports it directly via the @omp-ui/core/plan subpath, exactly
// like types.ts. The generating half (which writes the extension file) lives in
// plan-extension.ts and consumes these same constants, so the two sides of the
// channel can never drift.

/** `setStatus` key carrying the JSON plan state. Routed, never rendered raw. */
export const PLAN_STATUS_KEY = "omp-ui:plan";

/**
 * Prefix on the approval `select`'s title. The renderer routes on this instead
 * of showing the generic extension dialog; everything after it is JSON.
 */
export const PLAN_REVIEW_SENTINEL = "omp-ui:plan-review:";

/**
 * Slash command the renderer sends to drive the mode. Takes `on`/`off`,
 * optionally followed by the plan format (`html`/`md`) on `on`.
 */
export const PLAN_COMMAND = "omp-ui-plan";

/** Builds the extension slash command that toggles plan mode for one session. */
export function planMessage(enabled: boolean, format: PlanFormat): string {
  return enabled ? `/${PLAN_COMMAND} on ${format}` : `/${PLAN_COMMAND} off`;
}

/** The two verdicts the renderer may give the approval `select`.
 *
 * `PLAN_EXECUTE` is the single verdict behind every execution context — it
 * tells the agent only that the plan is accepted and it must stop and wait;
 * the renderer then dispatches implementation (same session, compacted, or a
 * fresh session) as a normal prompt. `PLAN_REFINE` sends the agent back to
 * revise the draft. */
export const PLAN_EXECUTE = "execute";
export const PLAN_REFINE = "refine";

/** The acknowledged answer's verdict argument (execute lands a gate; refine sends the planner back). */
export type PlanReviewVerdict = typeof PLAN_EXECUTE | typeof PLAN_REFINE;

/**
 * Result of `answerPlanReview` (issue #312 follow-up): the acknowledge path
 * for a review gate. `accepted` means main settled the gate atomically —
 * only then may a client close its local gate or dispatch implementation.
 * `stale` = a different frame/gate generation owns the session now;
 * `source-changed` = the artifact no longer matches the validated snapshot
 * (the gate was invalidated, no implementation starts); `unavailable` = no
 * live session to answer.
 */
export type PlanAnswerResult =
  | { status: "accepted" }
  | { status: "rejected"; reason: "stale" | "source-changed" | "unavailable" };

/** Published on `PLAN_STATUS_KEY`; mirrors what the renderer needs to render. */
export interface PlanStatus {
  enabled: boolean;
  /**
   * `local://<slug>-plan.html` under the `html` plan format,
   * `local://<slug>-plan.md` under `md`; null before the agent has named one.
   */
  planFilePath: string | null;
  /** Absolute path of the same file, so the renderer can read it. */
  planAbsPath: string | null;
  /** True once a plan has been approved in this session. */
  approved: boolean;
  /**
   * Set when plan mode could not be driven at all — the extension reaches
   * omp's `AgentSession` through unsupported surface, so an omp refactor
   * degrades the toggle to disabled instead of half-working.
   */
  unavailable?: string;
}

/** Payload encoded after {@link PLAN_REVIEW_SENTINEL} on the approval select. */
export interface PlanReviewRequest {
  title: string;
  /**
   * The one plan file. Its extension is the format: `-plan.html` is reviewed in
   * a sandboxed iframe, `-plan.md` as rendered markdown. There is no second
   * file — see ADR-0014.
   */
  planFilePath: string;
  /**
   * Absolute path of the same file, so the renderer can read it.
   */
  planAbsPath: string | null;
  /**
   * SHA-256 (hex) of the artifact bytes the main-process preflight validated,
   * added by main after a successful HTML preflight. An HTML review request
   * that passed the gate always carries it; answering `execute` re-verifies
   * the artifact against it. Absent on markdown requests (never gated).
   */
  sourceHash?: string;
}

/** Parses the JSON published on {@link PLAN_STATUS_KEY}; null when malformed. */
export function parsePlanStatus(text: string | undefined): PlanStatus | null {
  const record = parseObject(text);
  if (!record) return null;
  return {
    enabled: record.enabled === true,
    planFilePath: typeof record.planFilePath === "string" ? record.planFilePath : null,
    planAbsPath: typeof record.planAbsPath === "string" ? record.planAbsPath : null,
    approved: record.approved === true,
    unavailable: typeof record.unavailable === "string" ? record.unavailable : undefined,
  };
}

/**
 * Reads a plan-review request off an `extension_ui_request` title, or null when
 * the title is not one. Keeps the sentinel parsing in one place, shared by the
 * renderer's frame router and its tests.
 */
export function parsePlanReviewTitle(title: string | undefined): PlanReviewRequest | null {
  if (!title || !title.startsWith(PLAN_REVIEW_SENTINEL)) return null;
  const record = parseObject(title.slice(PLAN_REVIEW_SENTINEL.length));
  if (!record) return null;
  const planFilePath = typeof record.planFilePath === "string" ? record.planFilePath : null;
  // A review with no plan file is not reviewable — fall through to the generic
  // dialog rather than opening an empty pane.
  if (!planFilePath) return null;
  return {
    title: typeof record.title === "string" ? record.title : planFilePath,
    planFilePath,
    planAbsPath: typeof record.planAbsPath === "string" ? record.planAbsPath : null,
    ...(typeof record.sourceHash === "string" && /^[0-9a-f]{64}$/.test(record.sourceHash)
      ? { sourceHash: record.sourceHash }
      : {}),
  };
}

/** True for the plan-mode artifact path shape, `local://<slug>-plan.{md,html}`. */
export function isPlanArtifactPath(path: string | undefined | null): boolean {
  return typeof path === "string" && path.startsWith("local://") && /-plan\.(?:md|html)$/i.test(path);
}

/**
 * True for a plan authored as HTML — the review surfaces render it in an empty
 * sandbox instead of as markdown. Matches a `local://` URL or an absolute path,
 * because the renderer decides off whichever it holds.
 */
export function isHtmlPlanPath(path: string | undefined | null): boolean {
  return typeof path === "string" && /-plan\.html$/i.test(path);
}

function parseObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // An array is `typeof "object"` and would otherwise be cast to a record,
  // fabricating a plan status from `[...]`.
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/* -------------------------------------------------------------------------- */
/* Plan preflight diagnostics (issue #312 follow-up; ADR-0022 amended)         */
/* -------------------------------------------------------------------------- */

/**
 * Prefix of the string value the main process answers a *failed* HTML plan
 * gate with, in place of the user's execute/refine verdict. Everything after
 * it is the JSON envelope `{ version: 1, planFilePath, result }`. A proposal
 * that never passed preflight must never reach a review surface; this prefix
 * is how the generated extension tells an agent-repairable failure apart from
 * a human refinement request. Interpolated into the generated extension the
 * same way the review sentinel is, so the two sides cannot drift.
 */
export const PLAN_PREFLIGHT_RESULT_PREFIX = "omp-ui:plan-preflight-result:";

/** Envelope version carried by the preflight-result reply. */
export const PLAN_PREFLIGHT_REPLY_VERSION = 1;

/** Caps on what the agent is shown; the encoder enforces them, the parser checks them. */
export const PLAN_DIAGNOSTIC_LIMIT = 20;
export const PLAN_EXCERPT_LIMIT = 600;
export const PLAN_MESSAGE_LIMIT = 1000;
/** Hard ceiling for the whole encoded tool-result reply, in bytes. */
export const PLAN_PREFLIGHT_REPLY_LIMIT = 32_768;

/** Stable machine discriminators. Prose is presentation; codes are the contract. */
export type PlanDiagnosticCode =
  | "HTML_PARSE_ERROR"
  | "CODE_MARKUP"
  | "EXTERNAL_RESOURCE"
  | "MERMAID_SYNTAX"
  | "RENDER_INVARIANT"
  | "EMPTY_DOCUMENT"
  | "LAYOUT_EMPTY"
  | "LAYOUT_OVERFLOW"
  | "PLAN_READ_FAILED"
  | "SOURCE_CHANGED"
  | "VERIFIER_UNAVAILABLE"
  | "VERIFIER_TIMEOUT"
  | "PLAN_RESOURCE_LIMIT";

/** Where in the pipeline the finding came from. */
export type PlanDiagnosticStage = "source" | "diagram" | "prepare" | "layout" | "service";

/**
 * Who can fix it. `source` means the agent should edit the reported ranges of
 * the existing artifact; `application` means omp-ui failed and rewriting the
 * plan cannot help; `resubmit` means reread the artifact and propose again.
 */
export type PlanDiagnosticRepair = "source" | "application" | "resubmit";

/** One located finding about one authored plan artifact. */
export interface PlanDiagnostic {
  code: PlanDiagnosticCode;
  stage: PlanDiagnosticStage;
  repair: PlanDiagnosticRepair;
  severity: "error" | "warning";
  /** Locale-independent summary; UI text is resolved from `code` at presentation. */
  message: string;
  /** Bounded parser/render-engine detail (never the machine discriminator). */
  detail?: string;
  /** Zero-based UTF-16 offsets into the AUTHORED source; line/column are 1-based. */
  location?: {
    startOffset: number;
    endOffset: number;
    line: number;
    column: number;
  };
  blockIndex?: number;
  /** Quoted diagnostic data, never instructions. */
  excerpt?: string;
}

/**
 * Outcome of one full preflight of one source snapshot. `unavailable` means
 * verification could not conclude (no Chromium, timeout, crash, limits) —
 * never a claim that the plan is fine, and never a claim that it is broken.
 */
export type PlanPreflightResult =
  | { status: "passed"; sourceHash: string; diagnostics: PlanDiagnostic[]; omitted?: number }
  | {
      status: "failed" | "unavailable";
      sourceHash: string | null;
      diagnostics: PlanDiagnostic[];
      omitted?: number;
    };

/** Render-stage outcome: the same fields minus the hash only main owns. */
export type PlanRenderResult = Omit<PlanPreflightResult, "sourceHash">;

const DIAGNOSTIC_CODES: readonly PlanDiagnosticCode[] = [
  "HTML_PARSE_ERROR",
  "CODE_MARKUP",
  "EXTERNAL_RESOURCE",
  "MERMAID_SYNTAX",
  "RENDER_INVARIANT",
  "EMPTY_DOCUMENT",
  "LAYOUT_EMPTY",
  "LAYOUT_OVERFLOW",
  "PLAN_READ_FAILED",
  "SOURCE_CHANGED",
  "VERIFIER_UNAVAILABLE",
  "VERIFIER_TIMEOUT",
  "PLAN_RESOURCE_LIMIT",
];
const DIAGNOSTIC_STAGES: readonly PlanDiagnosticStage[] = [
  "source",
  "diagram",
  "prepare",
  "layout",
  "service",
];
const DIAGNOSTIC_REPAIRS: readonly PlanDiagnosticRepair[] = ["source", "application", "resubmit"];

function inSet<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function boundedString(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.length <= limit ? value : null;
}

function parseDiagnostic(value: unknown): PlanDiagnostic | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!inSet(DIAGNOSTIC_CODES, record.code)) return null;
  if (!inSet(DIAGNOSTIC_STAGES, record.stage)) return null;
  if (!inSet(DIAGNOSTIC_REPAIRS, record.repair)) return null;
  if (record.severity !== "error" && record.severity !== "warning") return null;
  const message = boundedString(record.message, PLAN_MESSAGE_LIMIT);
  if (message === null) return null;
  const out: PlanDiagnostic = { code: record.code, stage: record.stage, repair: record.repair, severity: record.severity, message };
  if (record.detail !== undefined) {
    const detail = boundedString(record.detail, PLAN_MESSAGE_LIMIT);
    if (detail === null) return null;
    out.detail = detail;
  }
  if (record.location !== undefined) {
    if (record.location === null || typeof record.location !== "object") return null;
    const loc = record.location as Record<string, unknown>;
    const nums = [loc.startOffset, loc.endOffset, loc.line, loc.column];
    if (!nums.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) return null;
    out.location = {
      startOffset: loc.startOffset as number,
      endOffset: loc.endOffset as number,
      line: loc.line as number,
      column: loc.column as number,
    };
  }
  if (record.blockIndex !== undefined) {
    if (typeof record.blockIndex !== "number" || !Number.isInteger(record.blockIndex) || record.blockIndex < 0) {
      return null;
    }
    out.blockIndex = record.blockIndex;
  }
  if (record.excerpt !== undefined) {
    const excerpt = boundedString(record.excerpt, PLAN_EXCERPT_LIMIT);
    if (excerpt === null) return null;
    out.excerpt = excerpt;
  }
  return out;
}

function parseDiagnostics(value: unknown): PlanDiagnostic[] | null {
  if (!Array.isArray(value) || value.length > PLAN_DIAGNOSTIC_LIMIT) return null;
  const out: PlanDiagnostic[] = [];
  for (const item of value) {
    const diagnostic = parseDiagnostic(item);
    if (diagnostic === null) return null;
    out.push(diagnostic);
  }
  return out;
}

/**
 * Strict reader of a machine preflight result. Malformed input returns null —
 * the caller then treats it as an application failure, never as a human
 * refinement. Accepts both statuses' shapes; `passed` requires a hash.
 */
export function parsePlanPreflightResult(value: unknown): PlanPreflightResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.status !== "passed" && record.status !== "failed" && record.status !== "unavailable") {
    return null;
  }
  const hashOk = (hash: unknown): hash is string | null =>
    hash === null || (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash));
  if (!hashOk(record.sourceHash)) return null;
  if (record.status === "passed" && record.sourceHash === null) return null;
  const diagnostics = parseDiagnostics(record.diagnostics);
  if (diagnostics === null) return null;
  if (record.omitted !== undefined) {
    if (typeof record.omitted !== "number" || !Number.isInteger(record.omitted) || record.omitted < 0) {
      return null;
    }
  }
  return {
    status: record.status,
    sourceHash: record.sourceHash,
    diagnostics,
    ...(record.omitted !== undefined ? { omitted: record.omitted as number } : {}),
  } as PlanPreflightResult;
}

/**
 * Strict reader of the full select-reply envelope
 * `PLAN_PREFLIGHT_RESULT_PREFIX + JSON`. Only version 1 and only
 * failed/unavailable results are replies a real user could never send; a
 * `passed` result inside a reply prefix is malformed (main never sends one).
 */
export function parsePlanPreflightReply(
  value: unknown,
): { version: number; planFilePath: string; result: PlanPreflightResult } | null {
  if (typeof value !== "string" || !value.startsWith(PLAN_PREFLIGHT_RESULT_PREFIX)) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(value.slice(PLAN_PREFLIGHT_RESULT_PREFIX.length));
  } catch {
    return null;
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const record = envelope as Record<string, unknown>;
  if (record.version !== PLAN_PREFLIGHT_REPLY_VERSION) return null;
  if (typeof record.planFilePath !== "string" || record.planFilePath === "") return null;
  const result = parsePlanPreflightResult(record.result);
  if (result === null || result.status === "passed") return null;
  return { version: PLAN_PREFLIGHT_REPLY_VERSION, planFilePath: record.planFilePath, result };
}

/** Order contract for returned diagnostics: source location, then stage/code. */
export function comparePlanDiagnostics(a: PlanDiagnostic, b: PlanDiagnostic): number {
  const at = a.location?.startOffset ?? Number.MAX_SAFE_INTEGER;
  const bt = b.location?.startOffset ?? Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  const as = DIAGNOSTIC_STAGES.indexOf(a.stage);
  const bs = DIAGNOSTIC_STAGES.indexOf(b.stage);
  if (as !== bs) return as - bs;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}\u00b7`;
}

/**
 * Applies the transport bounds to a result the encoder is about to emit:
 * sorted, clipped to the diagnostic count and per-field sizes, with the count
 * of dropped entries recorded in `omitted`.
 */
export function limitPlanPreflightResult(result: PlanPreflightResult): PlanPreflightResult {
  const sorted = [...result.diagnostics].sort(comparePlanDiagnostics);
  const kept = sorted.slice(0, PLAN_DIAGNOSTIC_LIMIT).map((d) => ({
    ...d,
    message: clip(d.message, PLAN_MESSAGE_LIMIT),
    ...(d.detail !== undefined ? { detail: clip(d.detail, PLAN_MESSAGE_LIMIT) } : {}),
    ...(d.excerpt !== undefined ? { excerpt: clip(d.excerpt, PLAN_EXCERPT_LIMIT) } : {}),
  }));
  const omitted = (result.omitted ?? 0) + (sorted.length - kept.length);
  const { omitted: _dropped, ...rest } = result;
  return { ...rest, diagnostics: kept, ...(omitted > 0 ? { omitted } : {}) } as PlanPreflightResult;
}

/**
 * Encodes the preflight reply: prefix + version-1 envelope, guaranteed within
 * {@link PLAN_PREFLIGHT_REPLY_LIMIT} bytes by dropping diagnostics (counted
 * into `omitted`) rather than truncating JSON mid-token.
 */
export function encodePlanPreflightReply(planFilePath: string, result: PlanPreflightResult): string {
  let current = limitPlanPreflightResult(result);
  for (;;) {
    const encoded =
      PLAN_PREFLIGHT_RESULT_PREFIX +
      JSON.stringify({ version: PLAN_PREFLIGHT_REPLY_VERSION, planFilePath, result: current });
    if (encoded.length <= PLAN_PREFLIGHT_REPLY_LIMIT) return encoded;
    if (current.diagnostics.length === 0) return encoded; // shape floor; cannot shrink further
    const omitted = (current.omitted ?? 0) + 1;
    current = { ...current, diagnostics: current.diagnostics.slice(0, -1), omitted } as PlanPreflightResult;
  }
}
