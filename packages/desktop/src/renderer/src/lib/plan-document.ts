/**
 * The renderer's view onto the HTML plan document pipeline (issue #312,
 * ADR-0022). The pipeline itself — parse, transforms, structural verify,
 * layout probe — lives in `@omp-ui/plan-doc`, shared with the headless
 * verifier; this module adds the one thing only a live React surface needs:
 * a hook that re-prepares a plan for the applied theme.
 */
import { useEffect, useState } from "react";
import { preparePlanForReview, type PreparedPlanState } from "@omp-ui/plan-doc";
import { useTheme } from "./themes";

export type { PreparedPlanState } from "@omp-ui/plan-doc";

/**
 * Prepared-document state for the two plan surfaces (PlanReview dock and the
 * transcript PlanCard): runs the full verification pipeline whenever the
 * INPUT changes — `pending` while the first run is in flight, the previous
 * settled state while a re-run is in flight, so the iframe never blanks
 * mid-review. The settled state echoes the `identity` it was prepared for so
 * a previous plan's ready state can never enable a NEW proposal (§6).
 */
export function usePreparedPlanDocument(
  html: string | null,
  identity?: string,
): PreparedPlanState {
  const theme = useTheme();
  const [state, setState] = useState<PreparedPlanState>({ status: "pending" });
  useEffect(() => {
    if (html === null) {
      setState({ status: "pending" });
      return;
    }
    let alive = true;
    void preparePlanForReview(html, undefined, theme).then((settled) => {
      if (!alive) return;
      const withIdentity = { ...settled, identity } as PreparedPlanState;
      setState(withIdentity);
    });
    return () => {
      alive = false;
    };
    // Tokens carry their colour as inline classes, so a theme switch only
    // reaches the rendered plan by re-preparing it.
  }, [html, theme, identity]);
  return state;
}
