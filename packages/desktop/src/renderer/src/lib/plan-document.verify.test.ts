// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  preparePlanDocument,
  preparePlanForReview,
  probePlanLayout,
  verifyPlanStructure,
} from "./plan-document";
import { currentThemeId, resolveTheme } from "./themes";
import type { CodeTokenizer } from "./plan-highlight";
import type { Theme } from "./themes";

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

// Stub shiki (same seam as plan-document.test.ts): default `null` leaves
// blocks plain; the highlighted cases install a fixed-token result.
const highlight = vi.hoisted(() => ({
  tokenize: null as CodeTokenizer | null,
}));

vi.mock("./plan-highlight", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plan-highlight")>();
  return {
    ...original,
    highlightCodeBlocks: (html: string, theme: Theme) =>
      original.highlightCodeBlocks(html, theme, highlight.tokenize ?? (async () => null)),
  };
});

afterEach(() => {
  diagrams.failure = null;
  highlight.tokenize = null;
});

const NORMAL_PLAN = "<html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>";
const MARKER = 'id="omp-ui-plan-guardrails"';

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

  it("fails when a highlight placeholder survived substitution", async () => {
    const prepared = await preparePlanDocument(
      "<html><head></head><body><h1>Plan</h1><!--omp-ui-highlight-0--></body></html>",
    );
    expect(verifyPlanStructure(prepared)).toBe("a highlight placeholder survived substitution");
  });

  it("passes a plan whose code block was highlighted, token CSS included", async () => {
    highlight.tokenize = async () => [
      [{ content: "x", color: "#123456", offset: 0 }],
    ];
    const prepared = await preparePlanDocument(
      '<html><head></head><body><h1>Plan</h1><pre><code class="language-python">x</code></pre></body></html>',
    );

    expect(prepared).toContain('<pre class="omp-ui-hl">');
    expect(prepared).toContain(".omp-ui-hl .tk-0 { color: #123456 !important; }");
    expect(verifyPlanStructure(prepared)).toBeNull();
  });

  it("fails when the prepared document carries no guardrail stylesheet", async () => {
    // The reason stays reachable for bytes that never went through
    // preparation; verifyPlanStructure takes prepared bytes as its input.
    expect(verifyPlanStructure(NORMAL_PLAN)).toBe(
      "the readability guardrail stylesheet is missing",
    );
  });

  it("passes when a non-style element shares the marker id with the stylesheet", async () => {
    // Duplicate ids: an id lookup returns the <meta> that parses first and
    // would mask the injected stylesheet, so the check queries style[id=…].
    const prepared = await preparePlanDocument(
      `<html><head><meta ${MARKER} name="x"></head><body><h1>Plan</h1></body></html>`,
    );

    expect(prepared).toContain(`<style ${MARKER}>`);
    expect(verifyPlanStructure(prepared)).toBeNull();
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

  it("settles ready with token spans when the code block is highlighted", async () => {
    highlight.tokenize = async () => [
      [{ content: "def", color: "#123456", offset: 0 }],
    ];
    const result = await preparePlanForReview(
      '<html><head></head><body><h1>Plan</h1><pre><code class="language-python">def</code></pre></body></html>',
      async () => "visible",
      resolveTheme(currentThemeId()),
    );

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.doc).toContain('<pre class="omp-ui-hl">');
      expect(result.doc).toContain("<span class=\"tk-0\">def</span>");
      expect(result.doc).toContain(".omp-ui-hl .tk-0 { color: #123456 !important; }");
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
