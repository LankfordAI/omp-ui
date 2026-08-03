// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RenderItem } from "../lib/transcript";
import { TranscriptView } from "./TranscriptView";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function assistant(id: string, text: string): RenderItem {
  return { kind: "assistant", id, text, thinking: "", streaming: false };
}

function render(items: RenderItem[]): { el: HTMLDivElement; root: Root } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<TranscriptView items={items} />);
  });
  return { el, root };
}

describe("TranscriptView error containment", () => {
  it("renders healthy rows normally", () => {
    const { el, root } = render([assistant("a1", "hello")]);
    expect(el.textContent).toContain("hello");
    expect(el.textContent).not.toContain("message failed to render");
    act(() => root.unmount());
  });

  it("collapses a throwing row to a broken-row card and keeps its siblings", () => {
    // `notes: undefined` poisons AdvisoryNotes the same way the stale-HMR
    // table bug did: a field the renderer `.map`s over is missing.
    const poisoned = {
      kind: "advisory",
      id: "bad",
      notes: undefined,
    } as unknown as RenderItem;

    // React logs caught errors loudly in dev; silence for the assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { el, root } = render([assistant("a1", "before"), poisoned, assistant("a2", "after")]);
    spy.mockRestore();

    expect(el.textContent).toContain("before");
    expect(el.textContent).toContain("after");
    expect(el.textContent).toContain("message failed to render");
    act(() => root.unmount());
  });
});
