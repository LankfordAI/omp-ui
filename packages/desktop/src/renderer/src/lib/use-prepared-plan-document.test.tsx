// @vitest-environment jsdom
// jsdom for the module graph (./themes reads `window` at boot) and for the
// `visibilitychange` the retry path listens for.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PreparedPlanState } from "./plan-document";
import type { PreparedReviewOutcome } from "./plan-verify";
import { PREPARE_BUDGET_MS, usePreparedPlanDocument } from "./use-prepared-plan-document";

/**
 * The reviewed pipeline is replaced wholesale (issue #652). What is under test
 * is what the hook DOES with an outcome it did not expect — a rejection, a
 * verdict that arrives only after the budget, or none at all — and none of
 * those are reachable through the real preparation, which always settles.
 */
const prepare = vi.hoisted(() => vi.fn());
vi.mock("./plan-verify", () => ({
  preparePlanForReview: (html: string, probe?: unknown, theme?: unknown) =>
    prepare(html, probe, theme),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Harness {
  /** Every state the hook has rendered, oldest first. */
  states: PreparedPlanState[];
  last: () => PreparedPlanState;
  unmount: () => void;
}

function mount(html: string | null, identity?: string): Harness {
  const states: PreparedPlanState[] = [];
  function Probe(): null {
    states.push(usePreparedPlanDocument(html, identity));
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  act(() => root.render(createElement(Probe)));
  return {
    states,
    last: () => states.at(-1)!,
    unmount: () =>
      act(() => {
        root.unmount();
        host.remove();
      }),
  };
}

/** Drain the effect's promise callbacks so any settle it queued is flushed. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

/** A promise the test settles by hand: the harness never guesses its timing. */
function deferred(): {
  promise: Promise<PreparedReviewOutcome>;
  resolve: (outcome: PreparedReviewOutcome) => void;
} {
  let resolve!: (outcome: PreparedReviewOutcome) => void;
  const promise = new Promise<PreparedReviewOutcome>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function ready(doc: string): PreparedReviewOutcome {
  return { status: "ready", doc, diagnostics: [] };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("usePreparedPlanDocument settles every path (issue #652)", () => {
  it("names the throw instead of latching pending when the pipeline rejects", async () => {
    prepare.mockRejectedValue(new Error("guardrailStylesheet exploded"));

    const harness = mount("<h1>Fix</h1>", "sha-abc");
    await flush();

    const state = harness.last();
    expect(state.status).toBe("failed");
    if (state.status === "pending") throw new Error("the rejection was swallowed");
    expect(state.doc).toBeNull();
    expect(state.identity).toBe("sha-abc");
    expect(state.diagnostics).toHaveLength(1);
    expect(state.diagnostics[0]!.code).toBe("RENDER_INVARIANT");
    expect(state.diagnostics[0]!.stage).toBe("prepare");
    expect(state.diagnostics[0]!.repair).toBe("application");
    expect(state.diagnostics[0]!.severity).toBe("error");
    // The throw is named where the user can see it: nothing about this state
    // ever reaches main.log, which is main-process only.
    expect(state.diagnostics[0]!.detail).toContain("guardrailStylesheet exploded");

    harness.unmount();
  });

  it("names a preparation that never settles once the budget runs out, and retries it when the document is shown again", () => {
    vi.useFakeTimers();
    prepare.mockReturnValue(new Promise<PreparedReviewOutcome>(() => {}));

    const harness = mount("<h1>Fix</h1>", "sha-abc");
    act(() => {
      vi.advanceTimersByTime(PREPARE_BUDGET_MS - 1);
    });
    expect(harness.last().status).toBe("pending");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const state = harness.last();
    expect(state.status).toBe("unavailable");
    if (state.status === "pending") throw new Error("the watchdog never fired");
    // Inconclusive, never a failed plan: nothing here indicts the source.
    expect(state.doc).toBeNull();
    expect(state.identity).toBe("sha-abc");
    expect(state.diagnostics).toHaveLength(1);
    expect(state.diagnostics[0]!.code).toBe("VERIFIER_TIMEOUT");
    expect(state.diagnostics[0]!.stage).toBe("prepare");
    expect(state.diagnostics[0]!.repair).toBe("application");
    expect(state.diagnostics[0]!.severity).toBe("warning");
    expect(state.diagnostics[0]!.detail).toContain(String(PREPARE_BUDGET_MS));

    // An inconclusive verdict keeps the #415 visibility retry, so a stalled
    // lazy chunk fetch is re-prepared when the user returns to the tab.
    const calls = prepare.mock.calls.length;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(prepare).toHaveBeenCalledTimes(calls + 1);

    harness.unmount();
  });

  it("lets the real verdict replace the watchdog verdict when preparation settles late", async () => {
    vi.useFakeTimers();
    const outcome = deferred();
    prepare.mockReturnValue(outcome.promise);

    const harness = mount("<h1>Fix</h1>", "sha-abc");
    act(() => {
      vi.advanceTimersByTime(PREPARE_BUDGET_MS);
    });
    expect(harness.last().status).toBe("unavailable");

    act(() => {
      outcome.resolve(ready("<html>slow but real</html>"));
    });
    await flush();
    const state = harness.last();
    // The late real verdict is authoritative: a healthy-but-slow preparation
    // must not stay wearing the timeout's label.
    expect(state.status).toBe("ready");
    if (state.status === "pending") throw new Error("the late verdict never landed");
    expect(state.doc).toBe("<html>slow but real</html>");
    expect(state.identity).toBe("sha-abc");

    harness.unmount();
  });

  it("clears the watchdog on unmount and ignores a verdict that arrives after", async () => {
    vi.useFakeTimers();
    const outcome = deferred();
    prepare.mockReturnValue(outcome.promise);

    const harness = mount("<h1>Fix</h1>", "sha-abc");
    const rendered = harness.states.length;
    harness.unmount();
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      outcome.resolve(ready("<html>too late</html>"));
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(PREPARE_BUDGET_MS * 2);
    });
    // A dead surface renders nothing: no state after the unmount, and no
    // watchdog left to declare one.
    expect(harness.states.length).toBe(rendered);
  });

  it("re-prepares on a source change and never lets the abandoned run answer", async () => {
    const first = deferred();
    const second = deferred();
    prepare.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const states: PreparedPlanState[] = [];
    function Surface({ html }: { html: string }): null {
      states.push(usePreparedPlanDocument(html));
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    act(() => root.render(createElement(Surface, { html: "a" })));
    await flush();
    await act(async () => {
      root.render(createElement(Surface, { html: "b" }));
    });
    expect(prepare).toHaveBeenCalledTimes(2);

    // The live run reports first; the abandoned one reports after. The state
    // on screen must stay the live run's verdict, never the stale one.
    act(() => {
      second.resolve(ready("<html>b</html>"));
    });
    await flush();
    act(() => {
      first.resolve(ready("<html>a</html>"));
    });
    await flush();
    const last = states.at(-1);
    expect(last?.status).toBe("ready");
    expect(last?.status === "ready" ? last.doc : undefined).toBe("<html>b</html>");

    await act(async () => {
      root.unmount();
    });
  });

  it("holds pending with no preparation at all for a source-less plan", () => {
    const harness = mount(null);
    expect(prepare).not.toHaveBeenCalled();
    expect(harness.last().status).toBe("pending");
    harness.unmount();
  });
});
