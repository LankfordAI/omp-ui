// @vitest-environment jsdom
// jsdom for the module graph (./themes reads `window` at boot) plus the DOM the
// probe path would need. No real layout happens here: every probe verdict is
// delivered through the injected LayoutProbe, which is exactly the seam §3
// gives the reviewed pipeline.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  PLAN_DOCUMENT_CSP,
  preparePlanDocument,
  preparePlanForReview,
  probePlanLayout,
  renderPlanPreflight,
  usePreparedPlanDocument,
  type LayoutProbe,
  type PreparedPlanState,
} from "./plan-document";
import { resolveTheme } from "./themes";
import type { CodeTokenizer } from "./plan-highlight";
import type { DiagramRenderer, PlanCanvas } from "./plan-diagrams";
import type { PlanDiagnostic } from "@omp-ui/core/plan";
import type { ParsedPlanSource } from "./plan-source";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const seams = vi.hoisted(() => ({
  failure: null as Error | null,
  tokenize: null as CodeTokenizer | null,
}));

vi.mock("./plan-diagrams", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plan-diagrams")>();
  return {
    ...original,
    // Stub the network-weight renderer (same seam as plan-document.test.ts),
    // with a switchable rejection so an ENGINE failure — as opposed to a
    // mermaid parse failure — is reachable without mermaid.
    planDiagramTransform: (
      parsed: ParsedPlanSource,
      _render: DiagramRenderer,
      canvas?: PlanCanvas,
    ) =>
      original.planDiagramTransform(
        parsed,
        async (id: string) => {
          if (seams.failure !== null) throw seams.failure;
          return `<svg data-diagram="${id}"></svg>`;
        },
        canvas,
      ),
  };
});

// Stub shiki (same seam): default `null` leaves blocks plain; the highlighted
// case installs a fixed-token result.
vi.mock("./plan-highlight", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plan-highlight")>();
  return {
    ...original,
    planHighlightTransform: (
      parsed: ParsedPlanSource,
      theme: Parameters<typeof original.planHighlightTransform>[1],
      tokenize?: CodeTokenizer,
    ) =>
      original.planHighlightTransform(
        parsed,
        theme,
        tokenize ?? seams.tokenize ?? (async () => null),
      ),
  };
});

afterEach(() => {
  seams.failure = null;
  seams.tokenize = null;
});

const NORMAL_PLAN = "<html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PLAN_DOCUMENT_CSP}">`;
const MARKER = 'id="omp-ui-plan-guardrails"';
/** The sha256-shaped identity main validates the artifact against (§6). */
const SOURCE_HASH = "a".repeat(63) + "f";

/**
 * The diagnostic a real probe frame yields for an empty layout (§4); the
 * reviewed pipeline must fold it into `failed` unchanged.
 */
const LAYOUT_EMPTY_PIN: PlanDiagnostic = {
  code: "LAYOUT_EMPTY",
  stage: "layout",
  repair: "source",
  severity: "error",
  message: "the document laid out no visible content",
  detail: "measured at 360px",
};

/** A probe fixture whose every sample measures with these diagnostics. */
function measuredBy(...diagnostics: PlanDiagnostic[]): LayoutProbe {
  return async () => ({ status: "measured", diagnostics });
}

/** A probe fixture that cannot conclude — which must never become `ready`. */
function inconclusiveBy(
  code: "VERIFIER_TIMEOUT" | "VERIFIER_UNAVAILABLE",
  detail?: string,
): LayoutProbe {
  return async () => ({ status: "inconclusive", code, detail });
}

/** A probe fixture that throws out of the review pipeline's try. */
const throwingProbe: LayoutProbe = async () => {
  throw new Error("measurement blew up");
};

function errorsOf(diagnostics: PlanDiagnostic[]): string[] {
  return diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

describe("preparePlanForReview status matrix", () => {
  it("settles ready on a measured layout verdict, carrying the composed document", async () => {
    const result = await preparePlanForReview(NORMAL_PLAN, measuredBy());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // No doctype is authored, so a warning rides along; nothing errors.
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(result.doc).toContain("<h1>Plan</h1>");
    expect(result.doc).toContain(MARKER);
    expect(result.doc).toContain(CSP_META);
  });

  it("settles failed on a structural source error before the probe ever runs", async () => {
    const probe = vi.fn(measuredBy());
    const result = await preparePlanForReview(
      '<html><head></head><body><h1>Plan</h1><script src="https://cdn.example/app.js"></script></body></html>',
      probe,
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(errorsOf(result.diagnostics)).toContain("EXTERNAL_RESOURCE");
    // The document still rides along so a surface can show what was authored.
    expect(result.doc).toContain("<h1>Plan</h1>");
    expect(probe).not.toHaveBeenCalled();
  });

  it("settles failed on an empty document", async () => {
    const result = await preparePlanForReview("<html><head></head><body></body></html>");
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(
      result.diagnostics
        .filter((d) => d.code === "EMPTY_DOCUMENT")
        .map((d) => [d.code, d.stage, d.repair]),
    ).toEqual([["EMPTY_DOCUMENT", "prepare", "source"]]);
  });

  it("settles failed when the diagram engine fails after a successful parse", async () => {
    seams.failure = new Error("mermaid exploded");
    const result = await preparePlanForReview(
      '<html><head></head><body><h1>Plan</h1><pre class="mermaid">flowchart TD; A-->B</pre></body></html>',
      measuredBy(),
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    const [diag] = result.diagnostics.filter((d) => d.code === "RENDER_INVARIANT");
    // An engine failure is nobody-else's-fault by absence: application repair,
    // never a request to rewrite the diagram source.
    expect([diag?.stage, diag?.repair]).toEqual(["diagram", "application"]);
    // The failed block still shows its source in the delivered document.
    expect(result.doc).toContain("omp-ui-diagram-error");
    expect(result.doc).toContain("flowchart TD; A--&gt;B");
  });

  it("settles unavailable — never ready — when the probe cannot conclude", async () => {
    const result = await preparePlanForReview(NORMAL_PLAN, inconclusiveBy("VERIFIER_UNAVAILABLE"));

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(
      result.diagnostics
        .filter((d) => d.code === "VERIFIER_UNAVAILABLE")
        .map((d) => [d.stage, d.repair, d.severity]),
    ).toEqual([["layout", "application", "warning"]]);
    // The document is carried so the surface can show it while naming what
    // could not be confirmed.
    expect(result.doc).toContain(MARKER);
  });

  it("names a timed-out sample as VERIFIER_TIMEOUT with the phase it never left", async () => {
    const result = await preparePlanForReview(
      NORMAL_PLAN,
      inconclusiveBy("VERIFIER_TIMEOUT", "no measurement after document load within 4000 ms"),
    );

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    const [diag] = result.diagnostics.filter((d) => d.code === "VERIFIER_TIMEOUT");
    expect([diag?.stage, diag?.severity, diag?.detail]).toEqual([
      "layout",
      "warning",
      "no measurement after document load within 4000 ms",
    ]);
  });

  it("treats a throwing probe as an inconclusive sample, not a crash", async () => {
    const result = await preparePlanForReview(NORMAL_PLAN, throwingProbe);

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    const [diag] = result.diagnostics.filter((d) => d.code === "VERIFIER_UNAVAILABLE");
    expect(diag?.detail).toBe("measurement blew up");
  });

  it("stops at the first inconclusive width", async () => {
    const probe = vi.fn(inconclusiveBy("VERIFIER_UNAVAILABLE"));
    const result = await preparePlanForReview(NORMAL_PLAN, probe, undefined, {
      widths: [800, 360],
    });

    expect(result.status).toBe("unavailable");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("reports PLAN_RESOURCE_LIMIT as unavailable, with no document to show", async () => {
    const probe = vi.fn(measuredBy());
    const { doc } = await preparePlanDocument(NORMAL_PLAN);
    // One byte under the composed document: an application limitation, never
    // an instruction to shorten the plan.
    const result = await preparePlanForReview(NORMAL_PLAN, probe, undefined, {
      preparedByteLimit: doc.length - 1,
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.doc).toBeNull();
    const [diag] = result.diagnostics.filter((d) => d.code === "PLAN_RESOURCE_LIMIT");
    expect([diag?.stage, diag?.repair, diag?.severity]).toEqual(["prepare", "application", "error"]);
    expect(diag?.detail).toContain("limit");
    expect(probe).not.toHaveBeenCalled();
  });

  it("measures every width and merges the layout verdicts", async () => {
    const probe = vi.fn<LayoutProbe>(async (_doc, width) =>
      width === 360
        ? { status: "measured", diagnostics: [LAYOUT_EMPTY_PIN] }
        : { status: "measured", diagnostics: [] },
    );
    const result = await preparePlanForReview(NORMAL_PLAN, probe, undefined, {
      widths: [800, 360],
    });

    expect(probe.mock.calls.map(([, width]) => width)).toEqual([800, 360]);
    // A measured failure at any width fails the review; the clean sample adds
    // nothing, and no inconclusive warning appears.
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(errorsOf(result.diagnostics)).toEqual(["LAYOUT_EMPTY"]);
    expect(result.doc).toContain(MARKER);
  });

  it("defaults to the 800 px sample", async () => {
    const probe = vi.fn(measuredBy());
    await preparePlanForReview(NORMAL_PLAN, probe);
    expect(probe.mock.calls[0]?.[1]).toBe(800);
  });

  it("honours the explicit theme for the composed document", async () => {
    const result = await preparePlanForReview(NORMAL_PLAN, measuredBy(), resolveTheme("light"));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.doc).toContain("color-scheme: light !important;");
  });
});

describe("renderPlanPreflight", () => {
  it("maps the review outcome onto the verifier verdict", async () => {
    const passed = await renderPlanPreflight(NORMAL_PLAN, undefined, { probe: measuredBy() });
    expect(passed.status).toBe("passed");
    expect(errorsOf(passed.diagnostics)).toEqual([]);

    const failed = await renderPlanPreflight("<html><body></body></html>", undefined, {
      probe: measuredBy(),
    });
    expect(failed.status).toBe("failed");
    expect(errorsOf(failed.diagnostics)).toContain("EMPTY_DOCUMENT");

    const halted = await renderPlanPreflight(NORMAL_PLAN, undefined, {
      probe: inconclusiveBy("VERIFIER_TIMEOUT"),
    });
    expect(halted.status).toBe("unavailable");
  });

  it("samples 800 and 360 by default and takes the widths from options", async () => {
    const byDefault: number[] = [];
    await renderPlanPreflight(NORMAL_PLAN, undefined, {
      probe: async (_doc, width) => {
        byDefault.push(width);
        return { status: "measured", diagnostics: [] };
      },
    });
    expect(byDefault).toEqual([800, 360]);

    const explicit: number[] = [];
    await renderPlanPreflight(NORMAL_PLAN, undefined, {
      widths: [1_200],
      probe: async (_doc, width) => {
        explicit.push(width);
        return { status: "measured", diagnostics: [] };
      },
    });
    expect(explicit).toEqual([1_200]);
  });

  it("passes the prepared byte limit through as an unavailable verdict", async () => {
    const result = await renderPlanPreflight(NORMAL_PLAN, undefined, {
      preparedByteLimit: 32,
      probe: measuredBy(),
    });
    expect(result.status).toBe("unavailable");
    expect(errorsOf(result.diagnostics)).toContain("PLAN_RESOURCE_LIMIT");
  });
});

describe("probePlanLayout", () => {
  it("resolves inconclusive in a layout-less environment without creating a frame", async () => {
    // jsdom lays out nothing: the capability gate must short-circuit before
    // any probe iframe exists, well inside the test timeout.
    const { doc } = await preparePlanDocument(NORMAL_PLAN);
    // LayoutProbe's signature makes the width explicit even though the
    // implementation defaults it; the probe is the same either way.
    expect(await probePlanLayout(doc, 800)).toEqual({
      status: "inconclusive",
      code: "VERIFIER_UNAVAILABLE",
      detail: "this environment performs no layout",
    });
    expect(document.querySelector("iframe")).toBeNull();
  });
});

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
