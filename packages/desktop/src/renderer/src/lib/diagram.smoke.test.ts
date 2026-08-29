// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../components/Markdown";

// Real-mermaid coverage for the transcript fence branch (issue #361). The
// stubbed pipeline lives in components/Markdown.test.tsx; this is the engine
// check, cloning the jsdom measurement stubs and the 30 s budget from
// plan-diagrams.smoke.test.ts (issues #329/#332: the real transforms are
// slow under full-suite contention, which exceeded the 5 s default).

// jsdom implements no SVG text measurement, which mermaid's layout relies on.
// Stub getBBox and getComputedTextLength with fixed sizes so the render
// pipeline completes; getComputedTextLength is only reached since
// htmlLabels:false (#303) made labels pure SVG text.
const svgProto = SVGElement.prototype as unknown as {
  getBBox?: () => DOMRect;
  getComputedTextLength?: () => number;
};
svgProto.getBBox ??= () =>
  ({
    x: 0,
    y: 0,
    width: 40,
    height: 20,
    top: 0,
    right: 40,
    bottom: 20,
    left: 0,
    toJSON: () => ({}),
  }) as DOMRect;
svgProto.getComputedTextLength ??= () => 40;

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function render(text: string, trailing?: ReactNode): { el: HTMLDivElement; root: Root } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(createElement(Markdown, { text, trailing }));
  });
  return { el, root };
}

describe("Markdown mermaid via real mermaid (issue #361)", () => {
  it(
    "renders a settled flowchart fence to SVG through the hook",
    async () => {
      const renderSpy = vi.spyOn(mermaid, "render");
      const src = "flowchart LR; A-->B";
      const { el, root } = render("```mermaid\n" + src + "\n```");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      const diagram = el.querySelector(".md-diagram");
      expect(diagram).not.toBeNull();
      expect(diagram!.querySelectorAll("svg")).toHaveLength(1);
      // Labels are SVG <text>, never foreignObject HTML (#303).
      expect(diagram!.innerHTML).not.toContain("<foreignObject");
      expect(diagram!.innerHTML).toContain("<text");
      // The fence body is replaced by the diagram, not echoed beside it.
      expect(el.textContent).not.toContain("flowchart LR");
      expect(renderSpy).toHaveBeenCalledTimes(1);

      // A second mount of the same source hits the (dark, source) cache and
      // must not re-enter mermaid.render.
      const second = render("```mermaid\n" + src + "\n```");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(second.el.querySelector(".md-diagram svg")).not.toBeNull();
      expect(renderSpy).toHaveBeenCalledTimes(1);

      act(() => root.unmount());
      act(() => second.root.unmount());
      renderSpy.mockRestore();
    },
    30_000,
  );
});
