// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolItem } from "../lib/transcript";
import { applyTheme, DEFAULT_THEME_ID, resolveTheme } from "../lib/themes";
import { ToolCard } from "./ToolCard";

// No hook mocks here (contrast ToolCard.test.tsx): real
// useIncrementalHighlightTokens, real shiki, real HTML grammar — the exact
// renderer path of the native transcript's live write card (issue #369).
// Content streams the way `reduceEvent` grows args: growing `content` on a
// running item, re-rendered per commit. Real timers are deliberate: the
// hook's batch yields are real setTimeouts; the polls wait on the DOM
// signal (colored spans / exact text), never a guessed sleep.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

const BLOCK = [
  "<!-- a streamed comment <div> that must not toggle -->",
  '<section class="plan" data-step="4">',
  "  <h2>Incremental highlighting</h2>",
  "  <style>",
  "    .plan { color: #222; }",
  "  </style>",
  '  <a href="#x" title="a &quot;b&quot; c">link</a>',
  "</section>",
  "",
].join("\n");

function sample(chars: number): string {
  return BLOCK.repeat(Math.ceil(chars / BLOCK.length)).slice(0, chars);
}

function tool(content: string): ToolItem {
  return {
    kind: "tool",
    id: "t1",
    toolCallId: "call-1",
    name: "Write",
    status: "running",
    argsStreaming: true,
    args: { content, file_path: "local://highlight-smoke.html" },
  };
}

/**
 * Token spans are the only spans inside the slab carrying an inline colour
 * that differs from the block's default ink (plain fallback = no styles).
 */
function coloredSpans(el: HTMLElement): number {
  const ink = getComputedStyle(el).color;
  let n = 0;
  for (const s of el.querySelectorAll<HTMLElement>("pre span")) {
    const c = s.style.color;
    if (c && c !== ink) n++;
  }
  return n;
}

/** Lets the card run until its slab shows exactly `want`, or the poll cap. */
async function settle(pre: HTMLElement, want: string): Promise<boolean> {
  for (let i = 0; i < 600; i++) {
    if (pre.textContent === want) return true;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  return pre.textContent === want;
}

function mount(item: ToolItem): { el: HTMLDivElement; root: Root; pre: HTMLElement } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<ToolCard item={item} />));
  const pre = el.querySelector("pre")!;
  expect(pre).not.toBeNull();
  return { el, root, pre };
}

describe("ToolCard live write draft (real highlighter)", () => {
  beforeEach(() => {
    applyTheme(resolveTheme(DEFAULT_THEME_ID));
  });

  it(
    "streams a 25k html draft: exact text at every commit, colored past the one-shot cap",
    { timeout: 60_000 },
    async () => {
      const full = sample(25_000);
      const { root, pre } = mount(tool(full.slice(0, 4_000)));
      for (let end = 8_000; end <= full.length; end += 4_000) {
        const snapshot = full.slice(0, end);
        act(() => root.render(<ToolCard item={tool(snapshot)} />));
        // The rendered text must always equal the source — never stale,
        // never duplicated characters. (Plain fallback also satisfies this;
        // the colour check below proves the tokenized state.)
        expect(pre.textContent, `exact text at ${end}`).toBe(snapshot);
        if (end > 20_000) {
          // Past the old one-shot cap the incremental path must still land
          // colored tokens; wait on that signal, not a fixed sleep.
          let colored = false;
          for (let g = 0; g < 300 && !colored; g++) {
            await act(async () => {
              await new Promise((r) => setTimeout(r, 5));
            });
            colored = coloredSpans(pre) > 10;
            expect(pre.textContent, `text stable while coloring at ${end}`).toBe(snapshot);
          }
          expect(colored, `colours at ${end}`).toBe(true);
        }
      }
      act(() => root.unmount());
    },
  );

  it(
    "a stable line's DOM node is reused across tail growth",
    { timeout: 60_000 },
    async () => {
      const first = sample(9_000);
      const { root, pre } = mount(tool(first));
      expect(await settle(pre, first)).toBe(true);

      const firstRow = pre.firstElementChild!;
      const growth = `${first}${sample(9_000)}`;
      act(() => root.render(<ToolCard item={tool(growth)} />));
      expect(await settle(pre, growth)).toBe(true);
      // Same source prefix ⇒ same stable rows ⇒ same memoized DOM nodes.
      expect(pre.firstElementChild).toBe(firstRow);
      act(() => root.unmount());
    },
  );

  it(
    "100k and a 4k physical line both render exact plain text, no tokens",
    { timeout: 60_000 },
    async () => {
      const atCap = sample(100_000);
      const { root, pre } = mount(tool(atCap));
      expect(await settle(pre, atCap)).toBe(true);
      expect(coloredSpans(pre)).toBe(0);
      act(() => root.unmount());

      const longLine = `ok\n${"z".repeat(4_000)}\ntail`;
      const second = mount(tool(longLine));
      expect(second.pre.textContent).toBe(longLine);
      expect(coloredSpans(second.pre)).toBe(0);
      act(() => second.root.unmount());
    },
  );

  it("an unknown extension stays plain through the real hook", async () => {
    const { root, pre } = mount({
      ...tool("<p>hello</p>\n"),
      args: { content: "<p>hello</p>\n", file_path: "notes.xyz123" },
    });
    expect(pre.textContent).toBe("<p>hello</p>\n");
    expect(coloredSpans(pre)).toBe(0);
    act(() => root.unmount());
  });
});
