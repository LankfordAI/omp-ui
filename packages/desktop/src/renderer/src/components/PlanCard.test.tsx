// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanDiagnostic } from "@omp-ui/core/plan";
import type { PlanItem } from "../lib/transcript";
import type { PreparedPlanState } from "../lib/plan-document";
import { PlanCard } from "./PlanCard";

/**
 * Pinned settled state for the prepared-document hook: `null` runs the real
 * pipeline (parse, transforms, structural verify, and a layout probe jsdom
 * resolves as inconclusive without ever creating a frame); an object pins what
 * the card sees, which is how the failed case names its diagnostics.
 */
const planPrepared = vi.hoisted(() => ({ state: null as PreparedPlanState | null }));

/**
 * The submission bridge. A transcript card is historical content: opening one
 * must never answer a gate or start a validation request (issue #312
 * follow-up), so the entry points a submission would use are spied here.
 */
const bridge = vi.hoisted(() => ({
  rpcSend: vi.fn(),
  answerPlanReview: vi.fn(async () => ({ status: "accepted" as const })),
}));

vi.mock("../lib/plan-document", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/plan-document")>();
  return {
    ...original,
    // The original hook always runs first so hook order stays stable even on
    // the render that switches to the pinned state.
    usePreparedPlanDocument: (html: string | null, identity?: string) => {
      const state = original.usePreparedPlanDocument(html, identity);
      return planPrepared.state ?? state;
    },
  };
});

// Issue #329: the mermaid leaf renderer sits behind a real dynamic import
// (~440 ms in this environment), which raced this file's wait budget under
// full-suite load. Stubbing the renderer the pipeline injects keeps the
// substitution, guardrail and verification behaviour under test real while
// making the pipeline microtask-only. Real-engine coverage lives in
// lib/plan-diagrams.smoke.test.ts.
vi.mock("../lib/plan-diagrams", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/plan-diagrams")>();
  return {
    ...original,
    renderMermaid: async (id: string) =>
      `<svg data-diagram="${id}" viewBox="0 0 10 10"></svg>`,
  };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// The bridge is present so a submission attempt from a historical card would
// be recorded rather than silently reaching a real backend.
Object.assign(window, { ompBackend: bridge });

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function htmlPlanItem(text: string): PlanItem {
  return {
    kind: "plan",
    id: "p1",
    title: "Fix the login race",
    planFilePath: "local://fix-login-race-plan.html",
    planAbsPath: "/x/fix-login-race-plan.html",
    text,
    status: "pending",
  };
}

function render(item: PlanItem): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<PlanCard item={item} />));
}

/**
 * Flushes act until the predicate holds. With the leaf renderer stubbed the
 * prepared-document pipeline is microtask-only, so each flush drains it
 * wholesale: no wall-clock budget, so suite load cannot decide the outcome
 * (issue #329). The trailing assertion names the real cause instead of letting
 * a later `toContain` miss stand in for it.
 */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 5 && !ok(); i += 1) {
    await act(async () => {});
  }
  expect(ok(), "the prepared plan document never settled").toBe(true);
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

describe("PlanCard html plan documents (issues #285, #312)", () => {
  const planFrame = (): HTMLIFrameElement | null =>
    document.body.querySelector<HTMLIFrameElement>('iframe[title="proposed plan"]');

  it("renders a mermaid block inside the guardrailed document once opened", async () => {
    // The card is collapsed by default: the iframe mounts only after the
    // disclosure opens.
    expect(planFrame()).toBeNull();
    render(
      htmlPlanItem('<h1>Fix</h1><pre class="mermaid">flowchart TD; A--&gt;B</pre><p>after</p>'),
    );

    const disclosure = document.body.querySelector<HTMLButtonElement>("button")!;
    await act(async () => disclosure.click());

    const frame = planFrame()!;
    expect(frame.getAttribute("sandbox")).toBe("");
    await until(() => (frame.getAttribute("srcdoc") ?? "") !== "");
    const srcdoc = frame.getAttribute("srcdoc")!;
    expect(srcdoc).not.toContain('<pre class="mermaid">');
    expect(srcdoc).toContain("<p>after</p>");
    expect(srcdoc).toContain('id="omp-ui-plan-guardrails"');
    // The displayed document carries the restrictive plan CSP next to the
    // guardrails: no scripts, no network, no forms, no navigation.
    expect(srcdoc).toContain('<meta http-equiv="Content-Security-Policy"');
    // Containment carve-out rides along so the diagram scales with the column.
    expect(srcdoc).toContain(".omp-ui-diagram svg {");
    expect(srcdoc).toContain("max-width: 100% !important;");
    expect(srcdoc).toContain("height: auto !important;");
  });

  it("leaves markdown plans on the Markdown path", async () => {
    render({
      kind: "plan",
      id: "p2",
      title: "Fix",
      planFilePath: "local://fix-plan.md",
      planAbsPath: "/x/fix-plan.md",
      text: "# Fix\n\nsteps",
      status: "pending",
    });

    const disclosure = document.body.querySelector<HTMLButtonElement>("button")!;
    await act(async () => disclosure.click());

    expect(planFrame()).toBeNull();
    expect(document.body.textContent).toContain("Fix");
    expect(document.body.textContent).toContain("steps");
  });

  it("names the diagnostics and the raw source instead of the iframe when preparation fails", async () => {
    const diagnostic: PlanDiagnostic = {
      code: "EMPTY_DOCUMENT",
      stage: "prepare",
      repair: "source",
      severity: "error",
      message: "the document body has no visible content",
      detail: "0 painted elements at 800px",
      location: { startOffset: 13, endOffset: 35, line: 2, column: 7 },
    };
    planPrepared.state = { status: "failed", doc: null, diagnostics: [diagnostic] };
    try {
      render(htmlPlanItem("<html><body></body></html>"));

      const disclosure = document.body.querySelector<HTMLButtonElement>("button")!;
      await act(async () => disclosure.click());
      await until(() => document.body.textContent!.includes("could not be displayed"));

      expect(planFrame()).toBeNull();
      expect(document.body.textContent).toContain("could not be displayed as a document");
      // The finding is named from its stable code through the localized
      // catalog, with its source location and engine detail.
      expect(document.body.textContent).toContain("no visible content after preparation");
      expect(document.body.textContent).toContain("2:7");
      expect(document.body.textContent).toContain("0 painted elements at 800px");
      // Settled history gets no rewrite instruction: nothing here can send the
      // agent back to repair a plan whose gate is already closed.
      expect(document.body.textContent).not.toContain("rewrite");
      expect(document.body.querySelector("pre[data-selectable]")!.textContent).toContain(
        "<html><body></body></html>",
      );
    } finally {
      planPrepared.state = null;
    }
  });
  it("shows the prepared document under an incomplete-verification note when the probe cannot conclude", async () => {
    // The historical card must agree with the review dock (issue #415): a
    // timed-out local check over a prepared document says the CHECK did not
    // finish, never that display failed.
    const diagnostic: PlanDiagnostic = {
      code: "VERIFIER_TIMEOUT",
      stage: "layout",
      repair: "application",
      severity: "warning",
      message: "verification timed out",
      detail: "no measurement after document load within 4000 ms",
    };
    planPrepared.state = { status: "unavailable", doc: "<h1>Fix</h1>", diagnostics: [diagnostic] };
    try {
      render(htmlPlanItem("<h1>Fix</h1>"));

      const disclosure = document.body.querySelector<HTMLButtonElement>("button")!;
      await act(async () => disclosure.click());
      await until(() => (planFrame()?.getAttribute("srcdoc") ?? "") !== "");

      expect(planFrame()!.getAttribute("srcdoc")).toContain("<h1>Fix</h1>");
      expect(document.body.textContent).toContain("could not finish checking its layout");
      expect(document.body.textContent).not.toContain("could not be displayed as a document");
      // Settled history: opening the card answers no gate and submits nothing.
      expect(bridge.answerPlanReview).not.toHaveBeenCalled();
      expect(bridge.rpcSend).not.toHaveBeenCalled();
    } finally {
      planPrepared.state = null;
    }
  });

  it("submits nothing while a historical plan is opened", async () => {
    render(htmlPlanItem("<h1>Fix</h1><p>settled work</p>"));
    const disclosure = document.body.querySelector<HTMLButtonElement>("button")!;
    await act(async () => disclosure.click());
    await until(() => (planFrame()?.getAttribute("srcdoc") ?? "") !== "");

    // Opening a card renders content. It never answers a gate and never asks
    // main to validate anything, so it cannot start a repair loop.
    expect(bridge.answerPlanReview).not.toHaveBeenCalled();
    expect(bridge.rpcSend).not.toHaveBeenCalled();
  });
});
