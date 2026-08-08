// The plan-mode wire contract. Pure — zero imports — because the renderer
// imports it directly via the @omp-ui/core/plan subpath, exactly like types.ts.
// The generating half (which writes the extension file) lives in
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

/** The two verdicts the renderer may give the approval `select`.
 *
 * `PLAN_EXECUTE` is the single verdict behind every execution context — it
 * tells the agent only that the plan is accepted and it must stop and wait;
 * the renderer then dispatches implementation (same session, compacted, or a
 * fresh session) as a normal prompt. `PLAN_REFINE` sends the agent back to
 * revise the draft. */
export const PLAN_EXECUTE = "execute";
export const PLAN_REFINE = "refine";

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
  /** Absolute path of the same file, so the renderer can read it. */
  planAbsPath: string | null;
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
  return parsed !== null && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : null;
}
