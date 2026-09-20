import { useEffect, useState } from "react";
import type { PreparedPlanState } from "./plan-document";
import { preparePlanForReview } from "./plan-verify";
import { useTheme } from "./themes";

/**
 * Prepares the current authored plan for display. Inconclusive probes retry
 * when the document becomes visible; source failures wait for new input.
 */
export function usePreparedPlanDocument(
  html: string | null,
  identity?: string,
): PreparedPlanState {
  const theme = useTheme();
  const [state, setState] = useState<PreparedPlanState>({ status: "pending" });
  const [generation, setGeneration] = useState(0);
  const inconclusive = state.status === "unavailable";
  useEffect(() => {
    if (!inconclusive) return;
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") setGeneration((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [inconclusive]);
  useEffect(() => {
    if (html === null) {
      setState({ status: "pending" });
      return;
    }
    let alive = true;
    void preparePlanForReview(html, undefined, theme).then((settled) => {
      if (!alive) return;
      setState({ ...settled, identity } as PreparedPlanState);
    });
    return () => {
      alive = false;
    };
  }, [html, theme, identity, generation]);
  return state;
}
