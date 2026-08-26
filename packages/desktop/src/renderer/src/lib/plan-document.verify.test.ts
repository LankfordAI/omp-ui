// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  preparePlanDocument,
  preparePlanForReview,
  probePlanLayout,
  verifyPlanStructure,
} from "./plan-document";

const diagrams = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock("./plan-diagrams", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plan-diagrams")>();
  return {
    ...original,
    // Stub the network-weight renderer (same seam as plan-document.test.ts),
    // with a switchable rejection so the preparation-failure path is testable.
    renderMermaidBlocks: (html: string) => {
      if (diagrams.failure) return Promise.reject(diagrams.failure);
      return original.renderMermaidBlocks(html, async (id) => `<svg data-diagram="${id}"></svg>`);
    },
  };
});

afterEach(() => {
  diagrams.failure = null;
});

const NORMAL_PLAN = "<html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>";

describe("verifyPlanStructure", () => {
  it("passes a prepared normal plan", async () => {
    expect(verifyPlanStructure(await preparePlanDocument(NORMAL_PLAN))).toBeNull();
  });

  it("fails when a diagram placeholder survived substitution", async () => {
    const prepared = await preparePlanDocument(
      "<html><head></head><body><h1>Plan</h1><!--omp-ui-diagram-0--></body></html>",
    );
    expect(verifyPlanStructure(prepared)).toBe("a diagram placeholder survived substitution");
  });

  it("fails when the marker id sits on a non-style element and dodged injection", async () => {
    // Mirrors the injection-skip case: preparePlanDocument returns the
    // document unchanged, so no guardrail <style> exists.
    const marked = "<article ID='omp-ui-plan-guardrails'>leave unchanged</article>";
    const prepared = await preparePlanDocument(marked);
    expect(prepared).toBe(marked);
    expect(verifyPlanStructure(prepared)).toBe(
      "the readability guardrail stylesheet is missing",
    );
  });

  it("fails a body swallowed by an unclosed comment", async () => {
    const prepared = await preparePlanDocument(
      "<html><head></head><body><!-- oops <h1>Plan</h1></body></html>",
    );
    expect(verifyPlanStructure(prepared)).toBe("the document body has no visible content");
  });

  it("fails a head-only document with an empty body", async () => {
    const prepared = await preparePlanDocument(
      "<html><head><title>Plan</title></head><body></body></html>",
    );
    expect(verifyPlanStructure(prepared)).toBe("the document body has no visible content");
  });

  it("fails a body containing only style and script text", async () => {
    const prepared = await preparePlanDocument(
      "<html><head></head><body><style>p{color:red}</style><script>void 0</script></body></html>",
    );
    expect(verifyPlanStructure(prepared)).toBe("the document body has no visible content");
  });

  it("passes an svg-only body", async () => {
    const prepared = await preparePlanDocument(
      '<html><head></head><body><svg width="40" height="40"><circle r="10"/></svg></body></html>',
    );
    expect(verifyPlanStructure(prepared)).toBeNull();
  });
});

describe("preparePlanForReview", () => {
  it("settles failed with the preparation message when preparation rejects", async () => {
    diagrams.failure = new Error("mermaid exploded");
    const result = await preparePlanForReview(NORMAL_PLAN);
    expect(result).toEqual({
      status: "failed",
      reason: "document preparation failed: mermaid exploded",
    });
  });

  it("settles failed when the layout probe measures empty", async () => {
    const result = await preparePlanForReview(NORMAL_PLAN, async () => "empty");
    expect(result).toEqual({ status: "failed", reason: "prepared document rendered empty" });
  });

  it("settles ready on a visible probe verdict", async () => {
    const result = await preparePlanForReview(NORMAL_PLAN, async () => "visible");
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.doc).toContain('id="omp-ui-plan-guardrails"');
      expect(result.doc).toContain("<h1>Plan</h1>");
    }
  });

  it("passes an inconclusive probe through as ready", async () => {
    const result = await preparePlanForReview(NORMAL_PLAN, async () => "inconclusive");
    expect(result.status).toBe("ready");
  });

  it("treats a throwing probe as inconclusive", async () => {
    const result = await preparePlanForReview(NORMAL_PLAN, async () => {
      throw new Error("measurement blew up");
    });
    expect(result.status).toBe("ready");
  });

  it("fails structurally before the probe ever runs", async () => {
    const probe = vi.fn(async () => "visible" as const);
    const result = await preparePlanForReview(
      "<html><head></head><body></body></html>",
      probe,
    );
    expect(result).toEqual({
      status: "failed",
      reason: "the document body has no visible content",
    });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("probePlanLayout", () => {
  it("resolves inconclusive in a layout-less environment without creating a frame", async () => {
    // jsdom lays out nothing: the capability gate must short-circuit before
    // any probe iframe exists, well inside the test timeout.
    const result = await probePlanLayout(await preparePlanDocument(NORMAL_PLAN));
    expect(result).toBe("inconclusive");
    expect(document.querySelector("iframe")).toBeNull();
  });
});
