import { useEffect, useMemo, useState } from "react";
import type { PreparedPlanState } from "./plan-document";
import { preparePlanForReview } from "./plan-verify";
import { useTheme } from "./themes";

/** Wall-clock budget for one preparation before it is named inconclusive.
 * Every internal stage is bounded (probe 4 s + settle 250 ms) except a stalled
 * lazy chunk fetch; 15 s is generous headroom for a cold packaged disk.
 * Exported so the watchdog tests advance the real budget, not a copy. */
export const PREPARE_BUDGET_MS = 15_000;

/**
 * Prepares the current authored plan for display. Inconclusive probes retry
 * when the document becomes visible; source failures wait for new input.
 */
export function usePreparedPlanDocument(
  html: string | null,
  identity?: string,
  sourceKey?: string,
): PreparedPlanState {
  const theme = useTheme();
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<{
    html: string;
    identity?: string;
    sourceKey?: string;
    theme: typeof theme;
    generation: number;
    state: PreparedPlanState;
  } | null>(null);
  const pending = useMemo<PreparedPlanState>(
    () => ({ status: "pending", ...(sourceKey === undefined ? {} : { sourceKey }) }),
    [sourceKey],
  );
  // Effects run after rendering: return pending immediately when any source
  // input changes, rather than lending the next read the previous verdict.
  const state: PreparedPlanState =
    html !== null &&
    result !== null &&
    result.html === html &&
    result.identity === identity &&
    result.sourceKey === sourceKey &&
    result.theme === theme &&
    result.generation === generation
      ? result.state
      : pending;
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
    if (html === null) return;
    let alive = true;
    let ended = false;
    const publish = (outcome: PreparedPlanState): void => {
      if (!alive) return;
      setResult({
        html,
        identity,
        sourceKey,
        theme,
        generation,
        state: { ...outcome, ...(sourceKey === undefined ? {} : { sourceKey }) },
      });
    };
    // A preparation that never settles must still name itself: an unresolved
    // promise is indistinguishable from a healthy slow one, and pending renders
    // no document at all (issue #652). The verdict is inconclusive — never a
    // failed plan — and the existing visibility retry re-prepares it (#415).
    const timer = setTimeout(() => {
      if (!alive || ended) return;
      ended = true;
      publish({
        status: "unavailable",
        doc: null,
        identity,
        diagnostics: [
          {
            code: "VERIFIER_TIMEOUT",
            stage: "prepare",
            repair: "application",
            severity: "warning",
            message: "preparation never reported an outcome",
            detail: `no settled outcome within ${PREPARE_BUDGET_MS} ms`,
          },
        ],
      });
    }, PREPARE_BUDGET_MS);
    void preparePlanForReview(html, undefined, theme).then(
      (settled) => {
        ended = true;
        clearTimeout(timer);
        publish({ ...settled, identity } as PreparedPlanState);
      },
      (err: unknown) => {
        // The pipeline's "never rejects" contract broken somewhere: settle
        // terminal with the throw named instead of latching pending forever
        // as an unhandled rejection (issue #652).
        ended = true;
        clearTimeout(timer);
        if (!alive) return;
        publish({
          status: "failed",
          doc: null,
          identity,
          diagnostics: [
            {
              code: "RENDER_INVARIANT",
              stage: "prepare",
              repair: "application",
              severity: "error",
              message: "preparation threw outside the pipeline's diagnostics",
              detail: (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(
                0,
                1000,
              ),
            },
          ],
        });
      },
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [html, theme, identity, sourceKey, generation]);
  return state;
}
