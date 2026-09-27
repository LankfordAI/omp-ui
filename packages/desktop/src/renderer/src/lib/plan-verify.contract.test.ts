// @vitest-environment jsdom
// jsdom for the module graph (./themes reads `window` at boot).
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePlanForReview } from "./plan-verify";
import { resolveTheme } from "./themes";

/**
 * `preparePlanDocument` contracts never to reject (plan-document.ts), but four
 * regions sit outside its `try` blocks — the synchronous resource scans, the
 * guardrail stylesheet, the structural verify, and the transform fan-out
 * itself (issue #652). This is the boundary that has to hold the contract when
 * they don't: the surfaces render whatever this returns, and a rejection here
 * used to leave them on `pending`, which is a blank white document.
 */
const seams = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock("./plan-document", () => ({
  preparePlanDocument: vi.fn(async () => {
    if (seams.failure !== null) throw seams.failure;
    return { doc: "<html><body><p>prepared</p></body></html>", diagnostics: [] };
  }),
}));

describe("preparePlanForReview holds the never-rejects contract (issue #652)", () => {
  afterEach(() => {
    seams.failure = null;
  });

  it("turns a throwing preparation stage into a named application failure", async () => {
    seams.failure = new Error("verifyPlanStructure threw");

    const outcome = await preparePlanForReview("<h1>Fix</h1>", undefined, resolveTheme("light"));

    expect(outcome.status).toBe("failed");
    if (outcome.status === "ready") throw new Error("a throwing stage cannot be ready");
    expect(outcome.doc).toBeNull();
    expect(outcome.diagnostics).toHaveLength(1);
    const [diagnostic] = outcome.diagnostics;
    expect(diagnostic!.code).toBe("RENDER_INVARIANT");
    expect(diagnostic!.stage).toBe("prepare");
    expect(diagnostic!.repair).toBe("application");
    expect(diagnostic!.severity).toBe("error");
    // The throw is named, so the surface says what broke instead of showing
    // nothing and leaving the reason in a devtools console nobody reads.
    expect(diagnostic!.detail).toContain("verifyPlanStructure threw");
  });

  it("still resolves normally when the pipeline behaves", async () => {
    const outcome = await preparePlanForReview("<h1>Fix</h1>", undefined, resolveTheme("light"));

    // The layout probe is the real one, and jsdom lays out nothing: the honest
    // verdict is inconclusive, never an implied pass.
    expect(outcome.status).toBe("unavailable");
    expect(outcome.doc).toContain("prepared");
  });
});
