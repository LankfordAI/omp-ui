// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RenderItem } from "../lib/transcript";
import { TranscriptView } from "./TranscriptView";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver, and TranscriptView's mount effect constructs
// one unconditionally. The stub records the callback so tests can fire it the
// way a browser would.
let resizeCallback: ResizeObserverCallback | null = null;
class ResizeObserverStub {
  constructor(cb: ResizeObserverCallback) {
    resizeCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

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

// jsdom does no layout: scrollHeight/clientHeight are defined per test and
// scrollTop is settable, which is enough to drive the follow-mode machine.
function scrollEl(el: HTMLDivElement): HTMLDivElement {
  const scroller = el.querySelector<HTMLDivElement>(".overflow-y-auto");
  if (!scroller) throw new Error("scroll container not found");
  return scroller;
}

function setGeometry(scroller: HTMLDivElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: clientHeight });
}

function scrollTo(scroller: HTMLDivElement, top: number) {
  scroller.scrollTop = top;
  act(() => {
    scroller.dispatchEvent(new Event("scroll"));
  });
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

describe("TranscriptView follow mode", () => {
  // Render with geometry in place and deliver the pin the browser produces
  // via the ResizeObserver's initial-observe callback (jsdom fires neither
  // layout nor the initial observe).
  function renderPinned(items: RenderItem[], scrollHeight: number, clientHeight: number) {
    const { el, root } = render(items);
    const scroller = scrollEl(el);
    setGeometry(scroller, scrollHeight, clientHeight);
    act(() => {
      resizeCallback!({} as never, {} as never);
    });
    return { el, root, scroller };
  }

  function jumpButton(el: HTMLDivElement): HTMLButtonElement {
    const button = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("jump to latest"),
    );
    if (!button) throw new Error("jump to latest button not found");
    return button;
  }

  it("stays pinned through a burst of new items", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1000, 500);
    expect(scroller.scrollTop).toBe(1000);

    const six = [
      ...three,
      assistant("a4", "four"),
      assistant("a5", "five"),
      assistant("a6", "six"),
    ];
    setGeometry(scroller, 1400, 500);
    act(() => {
      root.render(<TranscriptView items={six} />);
    });
    expect(scroller.scrollTop).toBe(1400);

    // The echo of our own pin is not user intent: no "jump to latest".
    scrollTo(scroller, 1400);
    expect(el.textContent).not.toContain("jump to latest");
    act(() => root.unmount());
  });

  it("stays pinned when content resizes without new items", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1000, 500);
    expect(scroller.scrollTop).toBe(1000);

    // ToolCard expansion grows the content without touching `items`.
    setGeometry(scroller, 1600, 500);
    act(() => {
      resizeCallback!({} as never, {} as never);
    });
    expect(scroller.scrollTop).toBe(1600);
    expect(el.textContent).not.toContain("jump to latest");
    act(() => root.unmount());
  });

  it("a deliberate scroll up exits follow mode and stays put", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1400, 500);
    expect(scroller.scrollTop).toBe(1400);

    // Distance 600 > 64 and moving upward: deliberate leave of the tail.
    scrollTo(scroller, 300);
    expect(el.textContent).toContain("jump to latest");

    const five = [...three, assistant("a4", "four"), assistant("a5", "five")];
    setGeometry(scroller, 1800, 500);
    act(() => {
      root.render(<TranscriptView items={five} />);
    });
    expect(scroller.scrollTop).toBe(300);
    expect(el.textContent).toContain("jump to latest");
    act(() => root.unmount());
  });

  it("scrolling back to the bottom resumes follow", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1800, 500);
    scrollTo(scroller, 300);
    expect(el.textContent).toContain("jump to latest");

    // Distance 50 ≤ 64: back at the tail, follow resumes and re-pins.
    scrollTo(scroller, 1250);
    expect(el.textContent).not.toContain("jump to latest");
    expect(scroller.scrollTop).toBe(1800);
    act(() => root.unmount());
  });

  it("jump to latest resumes follow", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1800, 500);
    scrollTo(scroller, 300);
    expect(el.textContent).toContain("jump to latest");

    act(() => {
      jumpButton(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("jump to latest");
    expect(scroller.scrollTop).toBe(1800);
    act(() => root.unmount());
  });
});
