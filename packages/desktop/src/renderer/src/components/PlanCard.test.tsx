// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanItem } from "../lib/transcript";
import { PlanCard } from "./PlanCard";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

/** Pumps macrotasks until the predicate holds: the prepared document lands. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !ok(); i += 1) {
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 10);
      await promise;
    });
  }
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

describe("PlanCard mermaid diagrams (issue #285)", () => {
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
});
