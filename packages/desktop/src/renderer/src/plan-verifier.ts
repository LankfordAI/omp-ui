/**
 * The trusted verifier page entry (issue #312 follow-up, §4). It imports the
 * shared plan library ONLY — never the app bootstrap, store, session UI, or
 * backend bridge (there is no preload here at all). It exposes a single
 * function on `window.ompPlanVerifier`; main calls it with JSON data.
 *
 * Inside the call, authored HTML goes to parse5 and the composition pipeline;
 * the displayed document lives only in plan-document's script-less probe
 * iframe. Diagnostics stay machine-readable and locale-independent; UI
 * localization happens at the presentation boundary, never here.
 */
import {
  DEFAULT_THEME_ID,
  PLAN_PREFLIGHT_WIDTHS,
  renderPlanPreflight,
  resolveTheme,
} from "@omp-ui/plan-doc";
import type { PlanDiagnostic, PlanRenderResult } from "@omp-ui/core/plan";

interface VerifyArgs {
  html?: unknown;
  themeId?: unknown;
  preparedByteLimit?: unknown;
}

function verify(raw: VerifyArgs): Promise<PlanRenderResult> {
  if (typeof raw?.html !== "string") {
    return Promise.resolve({
      status: "unavailable",
      diagnostics: [
        {
          code: "VERIFIER_UNAVAILABLE",
          stage: "service",
          repair: "application",
          severity: "error",
          message: "the verifier was invoked without an HTML payload",
        } satisfies PlanDiagnostic,
      ],
    });
  }
  const themeId = typeof raw.themeId === "string" ? raw.themeId : DEFAULT_THEME_ID;
  // The theme arrives EXPLICITLY from main (registry.getSetting("themeId"));
  // this page has no localStorage dependency and no ompBackend bridge.
  const theme = resolveTheme(themeId);
  const preparedByteLimit =
    typeof raw.preparedByteLimit === "number" ? raw.preparedByteLimit : undefined;
  return renderPlanPreflight(raw.html, theme, {
    widths: PLAN_PREFLIGHT_WIDTHS,
    preparedByteLimit,
  }).catch((err: unknown) => ({
    status: "unavailable" as const,
    diagnostics: [
      {
        code: "VERIFIER_UNAVAILABLE",
        stage: "service",
        repair: "application",
        severity: "error",
        message: "the verifier threw while rendering the plan",
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      } satisfies PlanDiagnostic,
    ],
  }));
}

declare global {
  interface Window {
    ompPlanVerifier?: { verify: (raw: VerifyArgs) => Promise<PlanRenderResult> };
  }
}

window.ompPlanVerifier = { verify };
