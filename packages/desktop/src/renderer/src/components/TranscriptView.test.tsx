// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  historyToItems,
  planProposalItem,
  type CommandItem,
  type RenderItem,
  type ToolItem,
} from "../lib/transcript";
// Statically imported even though the module is mocked: vi.mock hoists above
// imports, so this binding is the mock, not the window.ompBackend reader.
import { backend } from "../backend";
import { localeTag } from "../lib/i18n";
import { backendState, rpcTabState } from "../test/fixtures";
import { useStore } from "../store";
import { TranscriptView, type FindState } from "./TranscriptView";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** Parent-driven ToolCard renders, for the row-memoization contract (issue #187). */
const toolCardRenders = vi.hoisted((): string[] => []);
vi.mock("./ToolCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ToolCard")>();
  return {
    ...actual,
    ToolCard: function ToolCardProbe({ item, tabId }: { item: ToolItem; tabId?: string }) {
      toolCardRenders.push(item.id);
      return <actual.ToolCard item={item} tabId={tabId} />;
    },
  };
});

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

function render(items: RenderItem[], tabId?: string): { el: HTMLDivElement; root: Root } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<TranscriptView items={items} tabId={tabId} />);
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

  it("attributes a gateway turn: requested model first, upstream inline, facts on hover", () => {
    const timestamp = new Date(2026, 7, 5, 14, 32, 7).getTime();
    const item: RenderItem = {
      kind: "assistant",
      id: "a1",
      text: "done",
      thinking: "",
      streaming: false,
      model: "auto",
      provider: "openrouter",
      upstreamProvider: "Anthropic",
      responseId: "gen-test-123",
      usage: { input: 3, output: 268, cacheRead: 0, cacheWrite: 0, total: 271, cost: 0 },
      timestamp,
    };
    const { el, root } = render([item]);

    const strip = el.querySelector<HTMLDivElement>("div.text-ink-faint");
    expect(strip).not.toBeNull();

    // The receipt reports what was requested, never what the gateway selected:
    // the requested model stays the first inline part, the upstream follows it.
    const inline = [...strip!.querySelectorAll("span")].filter((s) => !s.hasAttribute("title"));
    expect(inline[0]!.textContent).toBe("auto");
    expect(strip!.textContent).toContain("via Anthropic");

    // The response id never shows inline — hover only.
    expect(strip!.textContent).not.toContain("gen-test-123");

    // Hover fact order: gateway, upstream, response, completion time.
    const tooltip = strip!.getAttribute("title") ?? "";
    const at = new Date(timestamp);
    const gateway = tooltip.indexOf("gateway: openrouter");
    const upstream = tooltip.indexOf("upstream: Anthropic");
    const response = tooltip.indexOf("response: gen-test-123");
    const stamp = tooltip.indexOf(at.toLocaleString(localeTag()));
    expect(gateway).toBeGreaterThanOrEqual(0);
    expect(upstream).toBeGreaterThan(gateway);
    expect(response).toBeGreaterThan(upstream);
    expect(stamp).toBeGreaterThan(response);

    // The completion time keeps its own title and stays the last receipt part.
    const stampSpan = strip!.querySelector("span[title]");
    expect(stampSpan).not.toBeNull();
    expect(stampSpan!.getAttribute("title")).toBe(at.toLocaleString(localeTag()));
    const allSpans = [...strip!.querySelectorAll("span")];
    expect(allSpans[allSpans.length - 1]).toBe(stampSpan);
    act(() => root.unmount());
  });

  it("keeps a direct-provider receipt unchanged inline", () => {
    const timestamp = new Date(2026, 7, 5, 14, 32, 7).getTime();
    const item: RenderItem = {
      kind: "assistant",
      id: "a1",
      text: "done",
      thinking: "",
      streaming: false,
      model: "anthropic/claude-sonnet-4.5",
      provider: "anthropic",
      usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, total: 8, cost: 0 },
      timestamp,
    };
    const { el, root } = render([item]);

    const strip = el.querySelector<HTMLDivElement>("div.text-ink-faint");
    expect(strip).not.toBeNull();
    // No upstream metadata: inline content stays exactly as it was.
    expect(strip!.textContent).not.toContain("via");
    const inline = [...strip!.querySelectorAll("span")].filter((s) => !s.hasAttribute("title"));
    expect(inline[0]!.textContent).toBe("anthropic/claude-sonnet-4.5");
    // The gateway fact still labels the hover, with no upstream/response lines.
    const tooltip = strip!.getAttribute("title") ?? "";
    expect(tooltip.startsWith("gateway: anthropic")).toBe(true);
    expect(tooltip).not.toContain("upstream:");
    expect(tooltip).not.toContain("response:");
    act(() => root.unmount());
  });

  it("renders the decode rate after the duration", () => {
    const timestamp = new Date(2026, 7, 5, 14, 32, 7).getTime();
    const item: RenderItem = {
      kind: "assistant",
      id: "a1",
      text: "done",
      thinking: "",
      streaming: false,
      model: "anthropic/claude-sonnet-4.5",
      usage: { input: 63_600, output: 1513, cacheRead: 0, cacheWrite: 0, total: 65_113, cost: 0 },
      ttftMs: 340,
      durationMs: 26_800,
      stopReason: "max_tokens",
      timestamp,
    };
    const { el, root } = render([item]);

    const strip = el.querySelector<HTMLDivElement>("div.text-ink-faint");
    expect(strip).not.toBeNull();
    const inline = [...strip!.querySelectorAll("span")].filter((s) => !s.hasAttribute("title"));
    const texts = inline.map((s) => s.textContent);
    // 1513 tokens over the 26.8s − 340ms window → 57.18, rendered rounded.
    const rate = texts.indexOf("57 t/s");
    expect(rate).toBeGreaterThan(-1);
    expect(texts[rate - 1]).toBe("26.8s");
    expect(texts[rate - 2]).toBe("ttft 340ms");
    // The stop reason still lands after the rate…
    expect(texts.indexOf("max_tokens")).toBeGreaterThan(rate);
    // …and the completion time stays the trailing span, rate part before it.
    const allSpans = [...strip!.querySelectorAll("span")];
    expect(allSpans[allSpans.length - 1]!.hasAttribute("title")).toBe(true);
    expect(allSpans.findIndex((s) => s.textContent === "57 t/s")).toBeLessThan(allSpans.length - 1);
    act(() => root.unmount());
  });

  it("shows one decimal for slow rates and nothing for zero-output turns", () => {
    const slow: RenderItem = {
      kind: "assistant",
      id: "a1",
      text: "done",
      thinking: "",
      streaming: false,
      model: "local/qwen3-8b",
      usage: { input: 120, output: 42, cacheRead: 0, cacheWrite: 0, total: 162, cost: 0 },
      ttftMs: 200,
      durationMs: 6_200,
    };
    const { el, root } = render([slow]);
    const strip = el.querySelector<HTMLDivElement>("div.text-ink-faint");
    expect(strip).not.toBeNull();
    // 42 over 6.0s is exactly 7: one decimal below 10 so a slow model never reads 0.
    expect(strip!.textContent).toContain("7.0 t/s");
    act(() => root.unmount());

    const aborted: RenderItem = {
      kind: "assistant",
      id: "a2",
      text: "",
      thinking: "",
      streaming: false,
      model: "local/qwen3-8b",
      usage: { input: 120, output: 0, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0 },
      ttftMs: 200,
      durationMs: 6_200,
      stopReason: "aborted",
    };
    const { el: el2, root: root2 } = render([aborted]);
    const strip2 = el2.querySelector<HTMLDivElement>("div.text-ink-faint");
    expect(strip2).not.toBeNull();
    const inline2 = [...strip2!.querySelectorAll("span")].filter((s) => !s.hasAttribute("title"));
    expect(inline2.some((s) => s.textContent!.includes("t/s"))).toBe(false);
    // The rest of the receipt still settles normally around the missing rate.
    expect(inline2.map((s) => s.textContent)).toContain("aborted");
    act(() => root2.unmount());
  });

  it("suppresses the rate without a usable post-ttft window", () => {
    // Clock-skewed gateway: duration no longer than ttft → never ∞, never negative.
    const skewed: RenderItem = {
      kind: "assistant",
      id: "a1",
      text: "done",
      thinking: "",
      streaming: false,
      model: "anthropic/claude-sonnet-4.5",
      usage: { input: 120, output: 300, cacheRead: 0, cacheWrite: 0, total: 420, cost: 0 },
      ttftMs: 340,
      durationMs: 300,
    };
    const { el, root } = render([skewed]);
    const strip = el.querySelector<HTMLDivElement>("div.text-ink-faint");
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain("300ms");
    expect(strip!.textContent).not.toContain("t/s");
    act(() => root.unmount());

    // Hydrated older session file: duration present, ttft never recorded.
    const noTtft: RenderItem = {
      kind: "assistant",
      id: "a2",
      text: "done",
      thinking: "",
      streaming: false,
      model: "anthropic/claude-sonnet-4.5",
      usage: { input: 120, output: 1513, cacheRead: 0, cacheWrite: 0, total: 1633, cost: 0 },
      durationMs: 26_800,
    };
    const { el: el2, root: root2 } = render([noTtft]);
    const strip2 = el2.querySelector<HTMLDivElement>("div.text-ink-faint");
    expect(strip2).not.toBeNull();
    expect(strip2!.textContent).toContain("26.8s");
    expect(strip2!.textContent).not.toContain("t/s");
    act(() => root2.unmount());
  });
});

describe("UserBubble resolved file mentions", () => {
  it("renders accessible truncating chips without raw resolved context", () => {
    const longPath = `src/${"deeply-nested/".repeat(20)}fixture.ts`;
    const prompt = `Compare @src/short.ts with @${longPath}`;
    const expanded =
      `${prompt}\n\n<file path="src/short.ts">\nraw short body\n</file>\n\n` +
      `<file path="${longPath}">\nraw long body\n</file>`;
    const items = historyToItems([
      { role: "user", content: [{ type: "text", text: expanded }] },
    ]);
    const { el, root } = render(items);

    expect(el.textContent).toContain(prompt);
    expect(el.textContent).not.toContain("<file");
    expect(el.textContent).not.toContain("raw short body");
    expect(el.textContent).not.toContain("raw long body");
    const group = el.querySelector('[role="group"][aria-label="resolved file mentions"]');
    expect(group).not.toBeNull();
    const chips = group!.querySelectorAll<HTMLElement>("span[title]");
    expect([...chips].map((chip) => chip.getAttribute("title"))).toEqual([
      "src/short.ts",
      longPath,
    ]);
    expect(chips[0]!.textContent).toBe("@src/short.ts");
    expect(chips[1]!.textContent).toBe(`@${longPath}`);
    expect(chips[1]!.className).toContain("max-w-full");
    expect(chips[1]!.querySelector(".truncate")).not.toBeNull();
    act(() => root.unmount());
  });
});

describe("UserBubble copy affordances (issue #644)", () => {
  /** CopyButton prefers `navigator.clipboard`; jsdom ships no Clipboard API. */
  function stubClipboard(): Mock<(text: string) => Promise<void>> {
    const writeText: Mock<(text: string) => Promise<void>> = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator, "clipboard");
    vi.useRealTimers();
  });

  /** The mention-expanded form of a prompt as omp stores it on the message. */
  function mentionPrompt(prompt: string): RenderItem[] {
    return historyToItems([
      {
        role: "user",
        content: [{ type: "text", text: `${prompt}\n\n<file path="src/a.ts">\nraw body\n</file>` }],
      },
    ]);
  }

  function bubble(el: HTMLDivElement): HTMLElement {
    const card = el.querySelector<HTMLDivElement>(".speaker-run > div.group");
    if (!card) throw new Error("user bubble not found");
    return card;
  }

  function copyChip(el: HTMLDivElement): HTMLButtonElement {
    const button = [...bubble(el).querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "copy",
    );
    if (!button) throw new Error("copy chip not found");
    return button;
  }

  it("copies the displayed prompt, without the resolved mention body", () => {
    const writeText = stubClipboard();
    const prompt = "Compare @src/a.ts and @src/b.ts";
    const { el, root } = render(mentionPrompt(prompt));

    act(() => copyChip(el).click());

    expect(writeText).toHaveBeenCalledWith(prompt);
    expect(writeText.mock.calls[0]?.[0]).not.toContain("<file");
    expect(writeText.mock.calls[0]?.[0]).not.toContain("raw body");
    act(() => root.unmount());
  });

  it("stays hidden until hover or keyboard focus", () => {
    stubClipboard();
    const { el, root } = render(mentionPrompt("anything"));
    // The chip wrapper, like the other controls floating over content.
    const wrapper = copyChip(el).parentElement!;
    expect(wrapper.className).toContain("opacity-0");
    expect(wrapper.className).toContain("group-hover:opacity-100");
    expect(wrapper.className).toContain("group-focus-within:opacity-100");
    // Reachable while invisible, which is what lets focus reveal it.
    expect(wrapper.className).not.toContain("pointer-events-none");
    act(() => root.unmount());
  });

  it("reports the copy in place, then reverts", async () => {
    vi.useFakeTimers();
    stubClipboard();
    const { el, root } = render(mentionPrompt("anything"));
    const button = copyChip(el);

    act(() => button.click());
    await act(async () => {});
    expect(button.textContent).toBe("copied");

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(button.textContent).toBe("copy");
    act(() => root.unmount());
  });

  it("renders no chip for a prompt with no prose", () => {
    stubClipboard();
    const items = historyToItems([
      {
        role: "user",
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      },
    ]);
    const { el, root } = render(items);

    expect(el.textContent).not.toContain("copy");
    // The image renders as an enlarge button, so count only copy chips.
    expect(
      [...bubble(el).querySelectorAll("button")].filter(
        (b) => b.textContent === "copy",
      ),
    ).toHaveLength(0);
    expect(el.querySelector("img")).not.toBeNull();
    act(() => root.unmount());
  });

  it("carries the prompt's markdown source for the selection menu (issue #644)", () => {
    stubClipboard();
    const prompt = "Compare @src/a.ts and **bold**";
    const { el, root } = render(
      historyToItems([
        {
          role: "user",
          content: [{ type: "text", text: `${prompt}\n\n<file path="src/a.ts">\nraw body\n</file>` }],
        },
      ]),
    );

    // The observable input to "Copy as Markdown" in the selection menu.
    expect(bubble(el).getAttribute("data-markdown-source")).toBe(prompt);
    act(() => root.unmount());
  });

  it("omits the markdown source when there is no prose to copy", () => {
    stubClipboard();
    const { el, root } = render(
      historyToItems([
        { role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
      ]),
    );
    expect(bubble(el).hasAttribute("data-markdown-source")).toBe(false);
    act(() => root.unmount());
  });
});

describe("UserBubble image enlarge trigger (issue #645)", () => {
  it("dispatches the viewer event with every image in order and the clicked index", () => {
    const seen: Array<{ detail?: { images: { src: string }[]; index: number } }> = [];
    const onOpen = (e: Event): void => {
      seen.push({ detail: (e as CustomEvent).detail });
    };
    window.addEventListener("omp-ui:image-viewer", onOpen);
    try {
      const { el, root } = render(
        historyToItems([
          {
            role: "user",
            content: [
              { type: "image", data: "AAAB", mimeType: "image/png" },
              { type: "image", data: "BBAC", mimeType: "image/jpeg" },
            ],
          },
        ]),
      );
      const triggers = [...el.querySelectorAll<HTMLButtonElement>("button")].filter(
        (b) => b.querySelector("img") !== null,
      );
      expect(triggers).toHaveLength(2);
      act(() => triggers[1]!.click());
      expect(seen).toHaveLength(1);
      expect(seen[0]!.detail?.index).toBe(1);
      expect(seen[0]!.detail?.images.map((i) => i.src)).toEqual([
        "data:image/png;base64,AAAB",
        "data:image/jpeg;base64,BBAC",
      ]);
      act(() => root.unmount());
    } finally {
      window.removeEventListener("omp-ui:image-viewer", onOpen);
    }
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

describe("PlanCard (issue #93)", () => {
  it("renders the inline plan proposal with its title and pending status", () => {
    const { el, root } = render([planProposalItem("Auth refresh", "local://auth-plan.md", null)]);
    expect(el.textContent).toContain("Auth refresh");
    expect(el.textContent).toContain("pending");
    // No text loaded yet — the card falls back to the plan's path.
    expect(el.textContent).toContain("local://auth-plan.md");
    act(() => root.unmount());
  });

  it("renders a loaded html plan through the guarded empty-sandbox iframe", async () => {
    const html = "<h1>Auth refresh</h1><p>html-plan-body</p>";
    const item = {
      ...planProposalItem("Auth refresh", "local://auth-plan.html", null),
      text: html,
    };
    const { el, root } = render([item]);

    const disclosure = [...el.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("show plan"),
    );
    expect(disclosure).toBeDefined();
    act(() => disclosure!.click());
    // The card names the wait while preparation is in flight (#652), so the
    // iframe appears when the preparation reports a document, not before.
    for (let i = 0; i < 5 && el.querySelector("iframe") === null; i += 1) {
      await act(async () => {});
    }

    const frame = el.querySelector<HTMLIFrameElement>('iframe[title="proposed plan"]');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("sandbox")).toBe("");
    expect(frame!.getAttribute("srcdoc")).toContain(html);
    expect(frame!.getAttribute("srcdoc")).toContain('id="omp-ui-plan-guardrails"');
    act(() => root.unmount());
  });
});

describe("row memoization (issue #187)", () => {
  beforeEach(() => {
    toolCardRenders.length = 0;
  });

  it("re-renders only the changed tail row on a stream update", () => {
    const settled: RenderItem = {
      kind: "tool",
      id: "t1",
      toolCallId: "t1",
      name: "bash",
      args: { command: "make" },
      status: "done",
      resultText: "built",
    };
    const running: RenderItem = {
      kind: "tool",
      id: "t2",
      toolCallId: "t2",
      name: "bash",
      args: { command: "npm test" },
      status: "running",
    };
    const { el, root } = render([settled, running]);
    expect(toolCardRenders).toEqual(["t1", "t2"]);

    // Tail-only update: `reduceEvent` copies the changed item, so t1's row
    // props stay shallow-equal and memo skips it entirely.
    const finished = { ...running, status: "done" as const, resultText: "ok" };
    act(() => root.render(<TranscriptView items={[settled, finished]} />));

    expect(toolCardRenders).toEqual(["t1", "t2", "t2"]);
    expect(el.textContent).toContain("ok");
    act(() => root.unmount());
  });
});

describe("stream-stall indicator (issue #228)", () => {
  const TAB = "tab-stall";

  const runningTool: RenderItem = {
    kind: "tool",
    id: "t1",
    toolCallId: "t1",
    name: "bash",
    args: { command: "sleep 40" },
    status: "running",
  };

  beforeEach(() => {
    useStore.setState({ rpc: {} });
  });

  it("reads the tab's stall field into the running chip and freezes the sweep", () => {
    useStore.setState({
      rpc: { [TAB]: { ...rpcTabState(), status: "running", streamStallMs: 30_000 } },
    });
    const { el, root } = render([runningTool], TAB);
    expect(el.textContent).toContain("stalled 30.0s");
    // The chip stays copper ("running, attention") with its observation-only
    // tooltip (#228, #179) — it does not flip to an error tone.
    const chip = el.querySelector('span[title^="No model-stream frame"]');
    expect(chip?.className).toContain("text-copper");
    const sweep = el.querySelector("[data-progress-sweep]");
    expect(sweep?.getAttribute("data-paused")).toBe("true");
    act(() => root.unmount());
  });

  it("keeps the plain running chip and a live sweep without a stall field", () => {
    useStore.setState({
      rpc: { [TAB]: { ...rpcTabState(), status: "running" } },
    });
    const { el, root } = render([runningTool], TAB);
    expect(el.textContent).toContain("running");
    expect(el.textContent).not.toContain("stalled");
    const sweep = el.querySelector("[data-progress-sweep]");
    expect(sweep?.hasAttribute("data-paused")).toBe(false);
    act(() => root.unmount());
  });

  it("mounts without a tab (SubagentView shape) and shows plain running", () => {
    const { el, root } = render([runningTool]);
    expect(el.textContent).toContain("running");
    expect(el.textContent).not.toContain("stalled");
    act(() => root.unmount());
  });
});

describe("command rows (slash-command parity)", () => {
  function command(status: CommandItem["status"], extra?: Partial<CommandItem>): RenderItem {
    return { kind: "command", id: `c-${status}`, name: "mcp", args: "reauth linear", status, ...extra };
  }

  const TAB = "tab-command";
  /** omp's verbatim refusal from its non-TUI slash handler (issue #243). */
  const TUI_REFUSAL = "/mcp reauth requires OAuth or browser flows only available in the TUI client.";

  function handoffButton(el: HTMLDivElement): HTMLButtonElement | undefined {
    return [...el.querySelectorAll("button")].find((b) => b.textContent === "run in omp TUI");
  }

  beforeEach(() => {
    useStore.setState({ rpc: {}, startTuiHandoff: vi.fn() });
  });

  it("shows the literal line with a live caret while running", () => {
    const { el, root } = render([command("running")]);
    expect(el.textContent).toContain("/mcp reauth linear");
    expect(el.querySelector(".animate-caret")).not.toBeNull();
    act(() => root.unmount());
  });

  it("omits the trailing space when args are empty", () => {
    const { el, root } = render([
      { kind: "command", id: "c0", name: "usage", args: "", status: "done" },
    ]);
    expect(el.textContent).toContain("/usage");
    expect(el.textContent).not.toContain("/usage ");
    act(() => root.unmount());
  });

  it("settles done to a quiet check", () => {
    const { el, root } = render([command("done")]);
    expect(el.textContent).toContain("✓");
    expect(el.querySelector(".animate-caret")).toBeNull();
    act(() => root.unmount());
  });

  it("renders failed in rose with the rpc error on a second line", () => {
    const { el, root } = render([command("failed", { error: "session is busy" })]);
    expect(el.textContent).toContain("session is busy");
    const line = [...el.querySelectorAll(".text-rose")];
    expect(line.length).toBeGreaterThanOrEqual(2); // command line + error line
    act(() => root.unmount());
  });

  it("renders agent status with no affix at all", () => {
    const { el, root } = render([command("agent")]);
    expect(el.textContent).toContain("/mcp reauth linear");
    expect(el.textContent).not.toContain("✓");
    expect(el.querySelector(".animate-caret")).toBeNull();
    act(() => root.unmount());
  });

  it("shows command_output as a selectable preformatted block", () => {
    const { el, root } = render([command("done", { output: "tokens: 1234\ncost: $0.02" })]);
    const pre = [...el.querySelectorAll("pre")].find((p) =>
      p.textContent?.includes("tokens: 1234"),
    );
    expect(pre).toBeDefined();
    expect(pre!.getAttribute("data-selectable")).not.toBeNull();
    expect(pre!.className).toContain("whitespace-pre-wrap");
    act(() => root.unmount());
  });

  it("keeps a command row out of the adjacent user group", () => {
    const user: RenderItem = { kind: "user", id: "u1", text: "hello" };
    const { el, root } = render([user, command("done")]);
    // The user bubble and the command slab are separate runs: the slab is
    // never inside the right-aligned user column.
    const slab = el.querySelector(".bg-sunken.font-mono");
    expect(slab).not.toBeNull();
    expect(slab!.closest(".items-end")).toBeNull();
    act(() => root.unmount());
  });

  it("offers the TUI handoff on omp's terminal-only refusal and stages the line", () => {
    const { el, root } = render([command("done", { output: TUI_REFUSAL })], TAB);
    const button = handoffButton(el);
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(vi.mocked(useStore.getState().startTuiHandoff).mock.calls).toEqual([
      [TAB, "/mcp reauth linear"],
    ]);
    act(() => root.unmount());
  });

  it("leaves ordinary command output without a handoff button", () => {
    const { el, root } = render([command("done", { output: "linear  http  connected" })], TAB);
    expect(handoffButton(el)).toBeUndefined();
    act(() => root.unmount());
  });

  it("renders a share URL as a linkified pre with an open link and copy row", () => {
    const shareOutput =
      "Share URL: https://my.omp.sh/s/abc123#kZ9_a\nNote: large content was trimmed to fit the share size limit.";
    const { el, root } = render([command("done", { output: shareOutput })], TAB);
    // The bare URL autolinks inside the pre, fragment intact (issue #679).
    const preLink = [...el.querySelectorAll("a")].find((a) =>
      a.getAttribute("title")?.endsWith("#kZ9_a"),
    );
    expect(preLink).toBeDefined();
    // The dedicated affordance row: open + copy the URL alone.
    const openLink = [...el.querySelectorAll("a")].find(
      (a) => a.textContent === "open share link",
    );
    expect(openLink).toBeDefined();
    expect(openLink!.getAttribute("title")).toBe("https://my.omp.sh/s/abc123#kZ9_a");
    const copy = [...el.querySelectorAll("button")].find((b) => b.textContent === "copy");
    expect(copy).toBeDefined();
    act(() => root.unmount());
  });

  it("routes the share link click through window.open, never a navigation", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { el, root } = render([
      command("done", { output: "Share URL: https://my.omp.sh/s/abc#key" }),
    ]);
    const link = [...el.querySelectorAll("a")].find((a) => a.getAttribute("title")?.includes("#key"))!;
    expect(link.getAttribute("href")).toBeNull();
    act(() => link.click());
    expect(open).toHaveBeenCalledWith(
      "https://my.omp.sh/s/abc#key",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
    act(() => root.unmount());
  });

  it("adds no share row for output without a Share URL line", () => {
    const { el, root } = render([command("done", { output: "Share URL: not-a-url" })], TAB);
    expect([...el.querySelectorAll("a")].some((a) => a.textContent === "open share link")).toBe(false);
    expect(el.textContent).toContain("Share URL: not-a-url");
    act(() => root.unmount());
  });

  it("withholds the handoff in the subagent view, which owns no tab", () => {
    const { el, root } = render([command("done", { output: TUI_REFUSAL })]);
    expect(el.textContent).toContain("the TUI client");
    expect(handoffButton(el)).toBeUndefined();
    act(() => root.unmount());
  });
});

describe("in-session find (issue #270)", () => {
  // jsdom has no scrollIntoView; the jump effect centres the active row with
  // it, exactly like the palettes do.
  const scrollIntoViewSpy = vi.fn();
  // jsdom leaves scrollIntoView undefined; restore whatever was there (if
  // anything) after the suite.
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    scrollIntoViewSpy.mockClear();
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;
  });

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });

  function renderFind(items: RenderItem[], find?: FindState | null) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => {
      root.render(<TranscriptView items={items} find={find ?? null} />);
    });
    return { el, root };
  }

  function four() {
    return [
      assistant("a1", "one"),
      assistant("a2", "two"),
      assistant("a3", "three"),
      assistant("a4", "four"),
    ];
  }

  function wrapper(el: HTMLDivElement, id: string): HTMLElement {
    const node = el.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
    if (!node) throw new Error(`row wrapper for ${id} not found`);
    return node;
  }

  it("washes matched rows, centres the active match, and exits follow mode", () => {
    const { el, root } = renderFind(four(), {
      ids: ["a1", "a2", "a3"],
      activeId: "a2",
      nonce: 1,
    });
    // The active match is mid-list: centreing it leaves the tail behind.
    expect(el.textContent).toContain("jump to latest");
    expect(wrapper(el, "a2").className).toBe("find-hit find-hit-active");
    expect(wrapper(el, "a1").className).toBe("find-hit");
    expect(wrapper(el, "a3").className).toBe("find-hit");
    // An unmatched row stays plain.
    expect(wrapper(el, "a4").className).toBe("");
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "center" });
    act(() => root.unmount());
  });

  it("leaves follow mode untouched when the active match is the last row", () => {
    const { el, root } = renderFind(four(), {
      ids: ["a1", "a2", "a3", "a4"],
      activeId: "a4",
      nonce: 1,
    });
    expect(el.textContent).not.toContain("jump to latest");
    expect(wrapper(el, "a4").className).toBe("find-hit find-hit-active");
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "center" });
    act(() => root.unmount());
  });

  it("re-fires the scroll on a nonce bump, and not on item churn without one", () => {
    const { root } = renderFind(four(), {
      ids: ["a1", "a2", "a3"],
      activeId: "a2",
      nonce: 5,
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);

    // Churn: a fresh items array with the same ids does not re-jump.
    act(() => {
      root.render(
        <TranscriptView items={four()} find={{ ids: ["a1", "a2", "a3"], activeId: "a2", nonce: 5 }} />,
      );
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);

    // A nonce bump does.
    act(() => {
      root.render(
        <TranscriptView items={four()} find={{ ids: ["a1", "a2", "a3"], activeId: "a2", nonce: 6 }} />,
      );
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it("renders plain rows with no find prop: no wash, no scroll, no follow change", () => {
    const { el, root } = renderFind(four());
    expect(el.querySelector(".find-hit")).toBeNull();
    expect(el.textContent).not.toContain("jump to latest");
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

describe("rewind affordances (issue #680)", () => {
  const TAB = "tab-rewind";

  function liveRpcState(status: "ready" | "running" = "ready"): void {
    const record = {
      tabId: TAB,
      sessionId: "s",
      lineageDir: "d",
      projectCwd: "/p",
      launchedAt: "t",
      mode: "rpc-ui" as const,
      worktree: null,
      planImplementationSource: null,
      experiment: null,
      agentMode: "plan" as const,
      compactionMethod: null,
      approvalMode: null,
      serviceTier: null,
      model: null,
      thinkingLevel: null,
      advisor: false,
      advisorModel: null,
      subagentModels: null,
      proposedPlans: [],
      cachedTitle: null,
      cachedModified: null,
      title: "t",
      status: null,
      live: "live" as const,
      pendingPlan: null,
      planSettle: null,
      streamStalled: false,
    };
    useStore.setState({
      state: { ...backendState(), projects: [{ project: { path: "/p", name: "p", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null, browserClock: false, reviewRoster: null }, sessions: [record] }] },
      rpc: { [TAB]: rpcTabState({ status }) },
    });
  }

  function rewindButton(el: HTMLElement, label: string): HTMLButtonElement | undefined {
    return [...el.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === label,
    );
  }

  it("renders the two affordances only for a live rpc-ui tab", () => {
    const user: RenderItem = { kind: "user", id: "u1", text: "hello" };
    liveRpcState();
    const { el, root } = render([user], TAB);
    expect(rewindButton(el, "rewind here")).toBeDefined();
    expect(rewindButton(el, "edit and resend")).toBeDefined();
    act(() => root.unmount());

    // A dormant tab has no process to branch: no affordance.
    useStore.setState({
      state: {
        ...backendState(),
        projects: [
          {
            project: { path: "/p", name: "p", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null, browserClock: false, reviewRoster: null },
            sessions: [{ ...useStore.getState().state!.projects[0]!.sessions[0]!, live: "dormant" }],
          },
        ],
      },
    });
    const second = render([user], TAB);
    expect(rewindButton(second.el, "rewind here")).toBeUndefined();
    act(() => second.root.unmount());

    // No tabId (the subagent read-only view) shows nothing either.
    liveRpcState();
    const third = render([user]);
    expect(rewindButton(third.el, "rewind here")).toBeUndefined();
    act(() => third.root.unmount());
  });

  it("stages the click's position among user items and disables while running", () => {
    const stageRewind = vi.fn(async () => {});
    useStore.setState({ stageRewind });
    liveRpcState();
    const items: RenderItem[] = [
      { kind: "user", id: "u1", text: "first" },
      assistant("a1", "answer"),
      { kind: "user", id: "u2", text: "second" },
    ];
    const { el, root } = render(items, TAB);
    // The second user row is position 1 among user items.
    const rows = [...el.querySelectorAll(".speaker-run.items-end")];
    const secondBubble = rows[1]!;
    const button = [...secondBubble.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "edit and resend",
    )!;
    act(() => button.click());
    expect(stageRewind).toHaveBeenCalledWith(TAB, 1, true);
    act(() => root.unmount());

    // Running: the affordances render but are disabled (the guard re-checks).
    liveRpcState("running");
    const second = render(items, TAB);
    const running = rewindButton(second.el, "rewind here");
    expect(running?.hasAttribute("disabled")).toBe(true);
    act(() => second.root.unmount());
  });
});
