// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RenderItem } from "../lib/transcript";
// Statically imported even though the module is mocked: vi.mock hoists above
// imports, so this binding is the mock, not the window.ompBackend reader.
import { backend } from "../backend";
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

// NoticeLine's open/reveal actions call the bridge directly; the module reads
// window.ompBackend at load, so mock the module instead of the global.
vi.mock("../backend", () => ({
  backend: {
    openPath: vi.fn(async () => {}),
    showPathInFolder: vi.fn(async () => {}),
  },
}));

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

  it("scrolling back to the exact bottom resumes follow", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1800, 500);
    scrollTo(scroller, 300);
    expect(el.textContent).toContain("jump to latest");

    // scrollTop 1800 is exactly the value the last pin wrote (the clamped
    // max, where a browser terminates "reach the bottom"). Without the guard
    // removal this event is misread as the pin's echo and follow stays off.
    scrollTo(scroller, 1800);
    expect(el.textContent).not.toContain("jump to latest");
    expect(scroller.scrollTop).toBe(1800);
    act(() => root.unmount());
  });

  it("resumes follow at the exact bottom and re-pins through a burst", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1800, 500);
    scrollTo(scroller, 300);
    expect(el.textContent).toContain("jump to latest");

    // Exact-bottom re-entry resumes follow.
    scrollTo(scroller, 1800);
    expect(el.textContent).not.toContain("jump to latest");
    expect(scroller.scrollTop).toBe(1800);

    // A burst arriving right after re-entry must stay pinned.
    setGeometry(scroller, 2000, 500);
    act(() => {
      root.render(<TranscriptView items={[...three, assistant("a4", "four")]} />);
    });
    expect(scroller.scrollTop).toBe(2000);
    expect(el.textContent).not.toContain("jump to latest");
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

describe("UsageStrip", () => {
  it("ends the receipt with the turn's local completion time", () => {
    const timestamp = new Date(2026, 7, 5, 14, 32, 7).getTime();
    const item: RenderItem = {
      kind: "assistant",
      id: "a1",
      text: "done",
      thinking: "",
      streaming: false,
      model: "openai/gpt-5.6-sol",
      usage: { input: 3, output: 268, cacheRead: 0, cacheWrite: 0, total: 271, cost: 0 },
      timestamp,
    };
    const { el, root } = render([item]);

    const at = new Date(timestamp);
    const expected = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const stamp = el.querySelector(".text-ink-faint span[title]");
    expect(stamp).not.toBeNull();
    expect(stamp!.textContent).toBe(expected);
    expect(stamp!.getAttribute("title")).toBe(at.toLocaleString());
    act(() => root.unmount());
  });
});

describe("NoticeLine path actions (issue #84)", () => {
  function notice(text: string, path?: string): RenderItem {
    return { kind: "notice", id: "n1", text, level: "info", ...(path === undefined ? {} : { path }) };
  }

  it("opens the file on text click and reveals it on the glyph click", () => {
    const { el, root } = render([notice("exported to /tmp/session.html", "/tmp/session.html")]);

    const open = el.querySelector<HTMLButtonElement>('button[title="open /tmp/session.html"]');
    const reveal = el.querySelector<HTMLButtonElement>('button[aria-label="reveal in file manager"]');
    expect(open).not.toBeNull();
    expect(reveal).not.toBeNull();
    expect(open!.textContent).toBe("exported to /tmp/session.html");

    act(() => {
      open!.click();
    });
    expect(vi.mocked(backend.openPath).mock.calls).toEqual([["/tmp/session.html"]]);
    expect(vi.mocked(backend.showPathInFolder).mock.calls).toEqual([]);

    act(() => {
      reveal!.click();
    });
    expect(vi.mocked(backend.showPathInFolder).mock.calls).toEqual([["/tmp/session.html"]]);
    act(() => root.unmount());
  });

  it("keeps a pathless notice inert text", () => {
    const { el, root } = render([notice("plan approved")]);
    expect(el.textContent).toContain("plan approved");
    expect(el.querySelector("button")).toBeNull();
    act(() => root.unmount());
  });
});
