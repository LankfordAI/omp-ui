import type { PlanDiagnostic, PlanRenderResult } from "@omp-ui/core/plan";
import { preparePlanDocument } from "./plan-document";
import {
  probePlanLayout,
  type LayoutProbe,
  type LayoutProbeResult,
} from "./plan-probe";
import { currentThemeId, resolveTheme, type Theme } from "./themes";

/** One reviewed-pipeline outcome for the surfaces (§3). */
export type PreparedReviewOutcome =
  | { status: "ready"; doc: string; diagnostics: PlanDiagnostic[] }
  | { status: "failed"; doc: string | null; diagnostics: PlanDiagnostic[] }
  | { status: "unavailable"; doc: string | null; diagnostics: PlanDiagnostic[] };

function hasError(diagnostics: PlanDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

export interface PlanReviewOptions {
  probe?: LayoutProbe;
  theme?: Theme;
  widths?: readonly number[];
  /** Cap on the prepared output; exceeding it is PLAN_RESOURCE_LIMIT — an
   * application limitation, never an instruction to shorten the plan. */
  preparedByteLimit?: number;
}

/**
 * Full review pipeline (§3): prepare → structural verify → layout probe at
 * each given width. A layout-inconclusive result is UNAVAILABLE, never
 * passed: an inconclusive probe may not masquerade as success (that gap was
 * this plan's starting observation). The document is still carried so a
 * surface can show it while naming what could not be confirmed.
 */
export async function preparePlanForReview(
  html: string,
  probe: LayoutProbe = probePlanLayout,
  theme: Theme = resolveTheme(currentThemeId()),
  options: PlanReviewOptions = {},
): Promise<PreparedReviewOutcome> {
  const widths = options.widths ?? [800];
  const prepared = await preparePlanDocument(html, theme);
  if (options.preparedByteLimit !== undefined && utf8Length(prepared.doc) > options.preparedByteLimit) {
    return {
      status: "unavailable",
      doc: null,
      diagnostics: prepared.diagnostics.concat([
        {
          code: "PLAN_RESOURCE_LIMIT",
          stage: "prepare",
          repair: "application",
          severity: "error",
          message: "the prepared document exceeds the verifier's byte limit",
          detail: `limit ${options.preparedByteLimit}`,
        },
      ]),
    };
  }
  if (hasError(prepared.diagnostics)) {
    return { status: "failed", doc: prepared.doc === "" ? null : prepared.doc, diagnostics: prepared.diagnostics };
  }
  const diagnostics = [...prepared.diagnostics];
  let inconclusive: LayoutProbeResult | null = null;
  for (const width of widths) {
    let result: LayoutProbeResult;
    try {
      result = await probe(prepared.doc, width);
    } catch (err) {
      result = {
        status: "inconclusive",
        code: "VERIFIER_UNAVAILABLE",
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      };
    }
    if (result.status === "inconclusive") {
      inconclusive = result;
      diagnostics.push({
        code: result.code,
        stage: "layout",
        repair: "application",
        severity: "warning",
        message: "the layout probe could not conclude",
        detail: result.detail ?? `width ${width}px`,
      });
      break;
    }
    diagnostics.push(...result.diagnostics);
  }
  if (inconclusive !== null) {
    return { status: "unavailable", doc: prepared.doc, diagnostics };
  }
  if (hasError(diagnostics)) {
    return { status: "failed", doc: prepared.doc, diagnostics };
  }
  return { status: "ready", doc: prepared.doc, diagnostics };
}

const textEncoder = new TextEncoder();

function utf8Length(text: string): number {
  return textEncoder.encode(text).length;
}

/**
 * The render-stage preflight (§3): the SAME parser, transforms, structural
 * checks, and layout probe that `preparePlanForReview` runs, shaped for the
 * main process to combine with its own source hash. The verifier page calls
 * this with the theme resolved from the explicitly passed themeId — never
 * from localStorage or an `ompBackend` bridge.
 */
export async function renderPlanPreflight(
  html: string,
  theme: Theme = resolveTheme(currentThemeId()),
  options: PlanReviewOptions = {},
): Promise<PlanRenderResult> {
  const outcome = await preparePlanForReview(html, options.probe ?? probePlanLayout, theme, {
    ...options,
    widths: options.widths ?? [800, 360],
  });
  if (outcome.status === "ready") {
    return { status: "passed", diagnostics: outcome.diagnostics };
  }
  return { status: outcome.status, diagnostics: outcome.diagnostics };
}
