// @vitest-environment jsdom
// The pipeline itself is covered in @omp-ui/plan-doc; these cases pin the
// renderer hook that wraps it. The fixture carries no diagram or code block,
// so neither mermaid nor shiki is ever loaded here.
import { describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { usePreparedPlanDocument, type PreparedPlanState } from "./plan-document";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const NORMAL_PLAN = "<html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>";
/** The sha256-shaped identity main validates the artifact against (§6). */
const SOURCE_HASH = "a".repeat(63) + "f";

describe("usePreparedPlanDocument identity", () => {
  /** Mount the hook and collect every state it renders. */
  function mount(html: string | null, identity?: string) {
    const states: PreparedPlanState[] = [];
    function Probe(): null {
      states.push(usePreparedPlanDocument(html, identity));
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(Probe)));
    return {
      /** Await the effect's prepare promise INSIDE act, so the state update
       * it schedules is flushed rather than queued behind the test. */
      settled: async () => {
        await act(async () => {
          // The reviewed pipeline is await-only in a layout-less environment
          // (the probe short-circuits before any timer), so flushing its
          // microtasks inside act settles it deterministically.
          for (let i = 0; i < 8 && states.length < 2; i += 1) await Promise.resolve();
        });
        const settled = states.at(-1);
        if (settled === undefined || settled.status === "pending")
          throw new Error("the preparation never settled");
        return settled;
      },
      unmount: () => act(() => root.unmount()),
    };
  }

  it("echoes the sha256 identity the state was prepared for", async () => {
    const harness = mount(NORMAL_PLAN, SOURCE_HASH);
    const state = await harness.settled();

    // The hook runs the REAL probe, and jsdom lays out nothing: the verdict is
    // unavailable, never an implied pass — while the identity still rides.
    expect(state.status).toBe("unavailable");
    expect(state.identity).toBe(SOURCE_HASH);
    harness.unmount();
  });

  it("carries no identity when none was prepared for", async () => {
    const harness = mount(NORMAL_PLAN);
    const state = await harness.settled();

    expect(state.identity).toBeUndefined();
    harness.unmount();
  });
});
