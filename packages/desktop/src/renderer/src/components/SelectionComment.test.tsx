// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFrameSelection, useSelectionCommentButton } from "./SelectionComment";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function Surface({ framed = false }: { framed?: boolean }) {
  const surface = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const native = useSelectionCommentButton(surface, !framed);
  const plan = useFrameSelection(frame, framed);
  return (
    <>
      <div ref={surface} data-selectable>First sentence. Second sentence.</div>
      {framed && <iframe ref={setFrame} title="Plan" sandbox="allow-same-origin" />}
      <output>{(framed ? plan.anchor : native.anchor)?.quote ?? "hidden"}</output>
    </>
  );
}

function renderSurface(framed = false): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Surface framed={framed} />));
  return host;
}

function pointer(doc: Document, type: string, target: EventTarget = doc): void {
  act(() => target.dispatchEvent(new MouseEvent(type, { button: 0, bubbles: true })));
}

function select(doc: Document, el: Element, end = 15): void {
  const range = doc.createRange();
  range.setStart(el.firstChild!, 0);
  range.setEnd(el.firstChild!, end);
  // jsdom has no layout. Real range/button geometry is covered by the CDP smoke.
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(20, 100, 180, 40),
    getClientRects: () => [new DOMRect(20, 100, 180, 20), new DOMRect(20, 120, 80, 20)],
  });
  const selection = doc.getSelection()!;
  act(() => {
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new Event("selectionchange"));
  });
}

function quote(host: Element): string | null {
  return host.querySelector("output")!.textContent;
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  act(() => vi.runOnlyPendingTimers());
  if (root !== null) act(() => root!.unmount());
  root = null;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("selection comment gestures", () => {
  it("waits for drag release, hides during re-selection, and still follows keyboard selections", () => {
    const host = renderSurface();
    const surface = host.querySelector("[data-selectable]")!;
    pointer(document, "pointerdown", surface);
    select(document, surface);
    expect(quote(host)).toBe("hidden");
    select(document, surface, 22);
    expect(quote(host)).toBe("hidden");
    pointer(document, "pointerup");
    expect(quote(host)).toBe("First sentence. Second");

    pointer(document, "pointerdown", surface);
    expect(quote(host)).toBe("hidden");
    pointer(document, "pointercancel");
    select(document, surface);
    expect(quote(host)).toBe("First sentence.");
    act(() => surface.dispatchEvent(new Event("scroll")));
    expect(quote(host)).toBe("hidden");
    select(document, surface, 22);
    expect(quote(host)).toBe("First sentence. Second");
    act(() => window.getSelection()!.removeAllRanges());
    act(() => document.dispatchEvent(new Event("selectionchange")));
    expect(quote(host)).toBe("hidden");
  });

  it("defers plan-frame selections through a parent-window release and hides on scroll", () => {
    const host = renderSurface(true);
    const frame = host.querySelector("iframe")!;
    const doc = frame.contentDocument!;
    doc.body.innerHTML = "<p>First sentence. Second sentence.</p>";
    act(() => frame.dispatchEvent(new Event("load")));
    const prose = doc.querySelector("p")!;
    pointer(doc, "pointerdown", prose);
    // Focusing a child frame blurs its parent window without ending the drag.
    act(() => window.dispatchEvent(new Event("blur")));
    select(doc, prose, 22);
    expect(quote(host)).toBe("hidden");
    pointer(document, "pointerup");
    expect(quote(host)).toBe("First sentence. Second");
    act(() => doc.dispatchEvent(new Event("scroll")));
    expect(quote(host)).toBe("hidden");
    select(doc, prose);
    expect(quote(host)).toBe("First sentence.");
  });
});
