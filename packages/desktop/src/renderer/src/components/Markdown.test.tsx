// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { DiagramRenderer } from "../lib/plan-diagrams";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { linkify, Markdown, ObsidianNoteLinkContext } from "./Markdown";
import { obsidianReplyLink, type ObsidianNoteTarget } from "@omp-ui/core/vault-shared";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function render(text: string, trailing?: ReactNode): { el: HTMLDivElement; root: Root } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<Markdown text={text} trailing={trailing} />);
  });
  return { el, root };
}

describe("Markdown lists", () => {
  it("renders a flat bullet list", () => {
    const { el, root } = render("- a\n- b");
    expect(el.textContent).toContain("a");
    expect(el.textContent).toContain("b");
    expect(el.querySelectorAll("li")).toHaveLength(2);
    act(() => root.unmount());
  });

  it("renders a nested list inside its parent item", () => {
    const { el, root } = render("- outer\n  - inner one\n  - inner two\n- tail");
    const items = el.querySelectorAll("li");
    expect(items).toHaveLength(4);
    expect(el.textContent).toContain("inner one");
    // The nested list lives inside the first top-level item, not as a sibling.
    const nested = items[0]!.querySelector("ul");
    expect(nested).not.toBeNull();
    expect(nested!.querySelectorAll("li")).toHaveLength(2);
    act(() => root.unmount());
  });

  it("keeps ordered markers on nested ordered lists", () => {
    const { el, root } = render("1. one\n   1. sub\n2. two");
    const nested = el.querySelectorAll("li")[0]!.querySelector("ul");
    expect(nested).not.toBeNull();
    expect(nested!.textContent).toContain("1.");
    act(() => root.unmount());
  });

  it("numbers ordered items continuously across a nested bullet section (issue #8)", () => {
    const { el, root } = render("1. First\n   - nested a\n   - nested b\n2. Second\n3. Third");
    const rootList = el.querySelector("ul");
    expect(rootList).not.toBeNull();
    const topItems = Array.from(rootList!.children);
    expect(topItems).toHaveLength(3);
    // The split-block bug restarted numbering after the nested run.
    const markers = topItems.map((li) => li.firstElementChild?.textContent);
    expect(markers).toEqual(["1.", "2.", "3."]);
    // The bullets nest inside First's item, not a separate block.
    const nested = topItems[0]!.querySelector("ul");
    expect(nested).not.toBeNull();
    expect(nested!.querySelectorAll(":scope > li")).toHaveLength(2);
    act(() => root.unmount());
  });

  it("rides the streaming caret on the deepest last node of a nested list", () => {
    // The last top-level item has a child list: the caret recurses into the
    // child's last item rather than sitting after the parent's text.
    const { el, root } = render(
      "1. First\n2. Second\n   - sub",
      <span data-testid="caret" />,
    );
    const caret = el.querySelector('[data-testid="caret"]');
    expect(caret).not.toBeNull();
    const topItems = el.querySelector("ul")!.children;
    const nested = topItems[1]!.querySelector("ul");
    expect(nested).not.toBeNull();
    expect(nested!.contains(caret)).toBe(true);
    act(() => root.unmount());

    // The last top-level item is a leaf: the caret sits after its text, and
    // never leaks into an earlier item's nested list.
    const leaf = render("1. First\n   - sub\n2. Second", <span data-testid="caret" />);
    const leafCaret = leaf.el.querySelector('[data-testid="caret"]');
    expect(leafCaret).not.toBeNull();
    const leafTop = leaf.el.querySelector("ul")!.children;
    expect(leafTop[1]!.contains(leafCaret)).toBe(true);
    expect(leafTop[0]!.querySelector("ul")!.contains(leafCaret)).toBe(false);
    act(() => leaf.root.unmount());
  });
});

// Issue #361: the transcript mermaid branch runs the real diagram hook
// against a stubbed leaf renderer — the same injection seam the plan tests use
// (issue #329) so nothing pays the real dynamic-import cost here. Real-engine
// coverage lives in lib/diagram.smoke.test.ts.
const mermaidRenders = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../lib/plan-diagrams", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/plan-diagrams")>();
  const render: DiagramRenderer = async (id, source) => {
    mermaidRenders.calls.push(`${id}\u0000${source}`);
    // A source of "fail" models a mermaid parse rejection.
    if (source === "fail") throw new Error("Parse error on line 1");
    return `<svg data-diagram="${id}" viewBox="0 0 10 10"></svg>`;
  };
  return { ...original, renderMermaid: render };
});

/** Unique source per case: diagram.ts caches rendered SVG module-wide, so
 *  reused sources would skip the stub renderer and defeat call counting. */
let srcSeq = 0;
const uniq = (body: string) => `${body} // u${srcSeq++}`;
const callsFor = (source: string) =>
  mermaidRenders.calls.filter((c) => c.split("\u0000")[1] === source).length;

describe("Markdown mermaid blocks (issue #361)", () => {
  it("renders a settled mermaid fence to the diagram", async () => {
    const src = uniq("flowchart TD; A-->B");
    const { el, root } = render("```mermaid\n" + src + "\n```");
    await act(async () => {});
    expect(el.querySelector(".md-diagram svg")).not.toBeNull();
    const pre = el.querySelector("pre");
    expect(pre).toBeNull();
    expect(el.textContent).not.toContain(src);
    act(() => root.unmount());
  });

  it("streams as a code block without calling mermaid", async () => {
    const src = uniq("flowchart TD; A-->B");
    const { el, root } = render("```mermaid\n" + src, <span data-testid="caret" />);
    await act(async () => {});
    expect(el.querySelector(".md-diagram")).toBeNull();
    expect(el.querySelector("pre")?.textContent).toContain(src);
    expect(el.querySelector('[data-testid="caret"]')).not.toBeNull();
    expect(callsFor(src)).toBe(0);
    act(() => root.unmount());
  });

  it("failed render falls back to the source with no toggle", async () => {
    // The failing stub is keyed on the exact source "fail", so this fence's
    // body must be exactly that (no uniq suffix).
    const { el, root } = render("```mermaid\nfail\n```");
    await act(async () => {});
    expect(el.querySelector(".md-diagram")).toBeNull();
    expect(el.querySelector("pre")?.textContent).toContain("fail");
    const buttons = Array.from(el.querySelectorAll("button"));
    // Only CopyButton chrome; no source/diagram toggle.
    expect(buttons.some((b) => b.textContent === "source" || b.textContent === "diagram")).toBe(
      false,
    );
    expect(buttons.length).toBeGreaterThan(0);
    act(() => root.unmount());
  });

  it("toggles between diagram and source", async () => {
    const src = uniq("flowchart TD; A-->B");
    const { el, root } = render("```mermaid\n" + src + "\n```");
    await act(async () => {});
    const toggle = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "source",
    );
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle!.click();
    });
    expect(el.querySelector(".md-diagram")).toBeNull();
    expect(el.querySelector("pre")?.textContent).toContain(src);
    const back = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "diagram");
    expect(back).toBeDefined();
    await act(async () => {
      back!.click();
    });
    expect(el.querySelector(".md-diagram svg")).not.toBeNull();
    act(() => root.unmount());
  });

  it("renders once per source across messages, twice across distinct sources", async () => {
    const srcA = uniq("flowchart LR; A-->B");
    const one = render("```mermaid\n" + srcA + "\n```");
    await act(async () => {});
    const two = render("```mermaid\n" + srcA + "\n```");
    await act(async () => {});
    // Cache dedupe: the identical second source never re-enters the renderer.
    expect(callsFor(srcA)).toBe(1);
    const srcB = uniq("flowchart LR; A-->B");
    const three = render("```mermaid\n" + srcB + "\n```");
    await act(async () => {});
    expect(callsFor(srcA)).toBe(1);
    expect(callsFor(srcB)).toBe(1);
    act(() => one.root.unmount());
    act(() => two.root.unmount());
    act(() => three.root.unmount());
  });

  it("leaves non-mermaid fences untouched", async () => {
    const { el, root } = render("```ts\nconst x = 1\n```");
    await act(async () => {});
    expect(el.querySelector(".md-diagram")).toBeNull();
    expect(el.querySelector("pre")?.textContent).toContain("const x = 1");
    act(() => root.unmount());
  });
});

describe("Markdown nested spans and item blocks (issues #40, #41)", () => {
  it("renders inline code inside strong without literal backticks", () => {
    const { el, root } = render("**After each `rs.add()`**");
    expect(el.querySelector("strong code")?.textContent).toBe("rs.add()");
    expect(el.textContent).not.toContain("`");
    act(() => root.unmount());
  });

  it("renders a fenced code block nested inside a list item", () => {
    // The issue-41 repro: the fence markers must not appear as literal text,
    // and the body must land in a <pre> under the "Exact member configuration"
    // item — not flattened into a paragraph.
    const { el, root } = render(
      [
        "5. **After each `rs.add()`**",
        "   - Wait for SECONDARY.",
        "   - `health: 1`.",
        "   - Exact member configuration:",
        "     ```javascript",
        "     hidden: true",
        "     priority: 0",
        "     votes: 0",
        "     ```",
      ].join("\n"),
    );
    const items = Array.from(el.querySelectorAll("li"));
    const exact = items.find((li) => li.textContent?.includes("Exact member configuration"));
    expect(exact).toBeDefined();
    const pre = exact!.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("hidden: true");
    expect(pre!.textContent).toContain("priority: 0");
    expect(pre!.textContent).toContain("votes: 0");
    expect(el.textContent).not.toContain("```");
    act(() => root.unmount());
  });
});

describe("bare URL autolinking (issue #101)", () => {
  it("renders a bare URL as one clickable anchor", () => {
    const { el, root } = render("see https://a.dev now");
    const anchors = el.querySelectorAll('a[role="link"]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("title")).toBe("https://a.dev");
    expect(anchors[0]!.textContent).toBe("https://a.dev");
    expect(el.textContent).toContain("https://a.dev");
    act(() => root.unmount());
  });

  it("leaves a URL inside a code span unlinked", () => {
    const { el, root } = render("`https://a.dev`");
    expect(el.querySelectorAll('a[role="link"]')).toHaveLength(0);
    act(() => root.unmount());
  });
});

describe("linkify (tool slabs, issue #101)", () => {
  it("turns bare URLs into anchors and keeps surrounding text", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <pre>
          {linkify("run curl https://a.dev/x now")}
        </pre>,
      );
    });
    const anchors = host.querySelectorAll('a[role="link"]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("title")).toBe("https://a.dev/x");
    expect(host.textContent).toBe("run curl https://a.dev/x now");
    act(() => root.unmount());
    host.remove();
  });

  it("keeps trimmed punctuation as plain text in the slab", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <pre>
          {linkify("see https://a.dev). done")}
        </pre>,
      );
    });
    const anchors = host.querySelectorAll('a[role="link"]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("title")).toBe("https://a.dev");
    expect(host.textContent).toBe("see https://a.dev). done");
    act(() => root.unmount());
    host.remove();
  });

  it("leaves scheme-only and word-glued text unlinked", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <pre>
          {linkify("https:// foohttps://a.dev")}
        </pre>,
      );
    });
    expect(host.querySelectorAll('a[role="link"]')).toHaveLength(0);
    act(() => root.unmount());
    host.remove();
  });
});

describe("LaTeX math (issue #191)", () => {
  it("renders a valid inline expression as KaTeX with MathML and no source delimiters", () => {
    const { el, root } = render("the energy is $E = mc^2$ today");
    const math = el.querySelector(".katex");
    expect(math).not.toBeNull();
    // Display markup is reserved for display mode.
    expect(el.querySelector(".katex-display")).toBeNull();
    // Accessible MathML accompanies the visual HTML.
    expect(el.querySelector("math")).not.toBeNull();
    // The dollar delimiters are consumed by the parser, not echoed.
    expect(el.textContent).toContain("the energy is");
    expect(el.textContent).toContain("today");
    expect(el.textContent).not.toContain("$");
    act(() => root.unmount());
  });

  it("renders a valid display expression in its own scrollable block", () => {
    const { el, root } = render("$$\ny = y_0 + y_1\n$$");
    const display = el.querySelector(".katex-display");
    expect(display).not.toBeNull();
    expect(el.querySelector(".md-math-display")).not.toBeNull();
    expect(el.querySelector("math")).not.toBeNull();
    expect(el.textContent).not.toContain("$");
    expect(el.textContent).toContain("y");
    act(() => root.unmount());
  });

  it("keeps malformed TeX visible instead of throwing or unmounting", () => {
    const { el, root } = render("Malformed: $\\notacommand{x}$ done");
    // The render item survives with its neighbours intact.
    expect(el.querySelector(".katex")).not.toBeNull();
    expect(el.textContent).toContain("Malformed:");
    expect(el.textContent).toContain("done");
    // The offending source is shown (KaTeX's error styling), not dropped.
    expect(el.textContent).toContain("\\notacommand");
    act(() => root.unmount());
  });

  it("renders an untrusted command without images, links or smuggled attributes", () => {
    const { el, root } = render(
      "Unsafe: $\\includegraphics{https://example.com/x.png}$",
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("[src]")).toBeNull();
    expect(el.querySelector("[href]")).toBeNull();
    // The command name stays visible as KaTeX error text.
    expect(el.textContent).toContain("\\includegraphics");
    act(() => root.unmount());
  });

  it("rides the streaming caret after inline math, outside KaTeX markup", () => {
    const { el, root } = render("E is $a^2$", <span data-testid="caret" />);
    const caret = el.querySelector('[data-testid="caret"]');
    expect(caret).not.toBeNull();
    const math = el.querySelector(".katex");
    expect(math).not.toBeNull();
    expect(math!.contains(caret)).toBe(false);
    expect(el.querySelector("p")!.contains(caret)).toBe(true);
    act(() => root.unmount());
  });

  it("rides the streaming caret inside the display block, after the formula", () => {
    const { el, root } = render("$$x^2$$", <span data-testid="caret" />);
    const caret = el.querySelector('[data-testid="caret"]');
    expect(caret).not.toBeNull();
    const wrapper = el.querySelector(".md-math-display");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.contains(caret)).toBe(true);
    // The caret never enters KaTeX-owned markup.
    const katexHtml = el.querySelector(".katex-display")!.parentElement;
    expect(katexHtml!.contains(caret)).toBe(false);
    act(() => root.unmount());
  });

  it("keeps dollar math literal inside code spans", () => {
    const { el, root } = render("`$not_math$`");
    expect(el.querySelector(".katex")).toBeNull();
    expect(el.querySelector("code")?.textContent).toBe("$not_math$");
    act(() => root.unmount());
  });
});

describe("Markdown tables (issue #365)", () => {
  it("renders table with matching header and body column counts for blank leading header", () => {
    const src = "| | Model A | Model B |\n|---|---|---|\n| Label | A | B |";
    const { el, root } = render(src);
    const ths = Array.from(el.querySelectorAll("thead th"));
    expect(ths).toHaveLength(3);
    expect(ths.map((th) => th.textContent)).toEqual(["", "Model A", "Model B"]);

    const tds = Array.from(el.querySelectorAll("tbody td"));
    expect(tds).toHaveLength(3);
    expect(tds.map((td) => td.textContent)).toEqual(["Label", "A", "B"]);
    act(() => root.unmount());
  });
});

describe("claim marker chip (issue #558)", () => {
  it("renders [INFERENCE] as a subscript INF chip, not prose", () => {
    const { el, root } = render("a [INFERENCE] b");
    const chip = el.querySelector('[title="Model-flagged inference: not verified against sources"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("INF");
    // Sibling text spans survive; the raw token never reaches the screen.
    expect(chip!.previousElementSibling?.textContent).toBe("a ");
    expect(chip!.nextElementSibling?.textContent).toBe(" b");
    expect(el.textContent).not.toContain("[INFERENCE]");
    act(() => root.unmount());
  });

  it("keeps the marker literal inside inline code", () => {
    const { el, root } = render("`[INFERENCE]`");
    expect(el.querySelector("code")?.textContent).toBe("[INFERENCE]");
    expect(el.querySelector('[title="Model-flagged inference: not verified against sources"]')).toBeNull();
    act(() => root.unmount());
  });

  it("renders one chip for the marker and a link for [INFERENCE](url)", () => {
    const { el, root } = render("[INFERENCE](https://a.dev) [INFERENCE]");
    expect(el.querySelectorAll('a[role="link"]')).toHaveLength(1);
    const chips = Array.from(el.querySelectorAll("span")).filter(
      (s) => s.textContent === "INF",
    );
    expect(chips).toHaveLength(1);
    act(() => root.unmount());
  });
});

// Issue #741: a settled message that is one whole html plan document — bare or
// in an html fence — renders through the real plan pipeline into an empty
// sandbox. jsdom's layout probe is inconclusive, so a good document settles as
// `unavailable` with its prepared document; the mermaid leaf stays stubbed
// above, keeping the pipeline microtask-only.
describe("Markdown html plan documents", () => {
  const PLAN =
    "<!doctype html>\n<html><head><title>p</title></head><body><h1>Pasted</h1><p>plan-body</p></body></html>\n";
  const frameIn = (el: HTMLElement): HTMLIFrameElement | null =>
    el.querySelector<HTMLIFrameElement>('iframe[title="html plan"]');
  const srcdocOf = (el: HTMLElement): string => frameIn(el)?.getAttribute("srcdoc") ?? "";
  const buttonIn = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
    Array.from(el.querySelectorAll("button")).find((b) => b.textContent === text);

  /** Flushes act until the predicate holds; the stubbed pipeline is
   *  microtask-only, so a bounded flush count decides, never wall-clock. */
  async function until(ok: () => boolean): Promise<void> {
    for (let i = 0; i < 5 && !ok(); i += 1) {
      await act(async () => {});
    }
    expect(ok(), "the prepared plan document never settled").toBe(true);
  }

  /** Drains the pipeline fully so a negative assertion is not a race. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {});
    }
  }

  function dispose({ el, root }: { el: HTMLDivElement; root: Root }): void {
    act(() => root.unmount());
    el.remove();
  }

  it("renders a whole-text document in an empty sandbox with guardrails and CSP", async () => {
    const view = render(PLAN);
    try {
      await until(() => srcdocOf(view.el) !== "");
      const frame = frameIn(view.el)!;
      expect(frame.getAttribute("sandbox")).toBe("");
      const srcdoc = srcdocOf(view.el);
      expect(srcdoc).toContain('id="omp-ui-plan-guardrails"');
      expect(srcdoc).toContain('<meta http-equiv="Content-Security-Policy"');
      expect(srcdoc).toContain("plan-body");
      expect(view.el.querySelector("pre")).toBeNull();
    } finally {
      dispose(view);
    }
  });

  it("renders a settled html fence after prose", async () => {
    const view = render("Here it is:\n\n```html\n" + PLAN + "```");
    try {
      await until(() => srcdocOf(view.el) !== "");
      expect(srcdocOf(view.el)).toContain("plan-body");
      expect(view.el.textContent).toContain("Here it is:");
    } finally {
      dispose(view);
    }
  });

  it.each([
    ["a fragment html fence", "```html\n<div>frag</div>\n```", "frag"],
    ["a document followed by prose", PLAN + "\n\nthoughts?", "plan-body"],
    ["a document in a non-html fence", "```xml\n" + PLAN + "```", "plan-body"],
  ])("keeps %s as text", async (_name, text, visible) => {
    const view = render(text);
    try {
      await flush();
      expect(view.el.querySelector("iframe")).toBeNull();
      expect(view.el.textContent).toContain(visible);
    } finally {
      dispose(view);
    }
  });

  it.each([
    ["an open html fence", "```html\n" + PLAN],
    ["a bare document", PLAN],
  ])("never renders %s while streaming", async (_name, text) => {
    const view = render(text, <span data-testid="caret" />);
    try {
      await flush();
      expect(view.el.querySelector("iframe")).toBeNull();
      expect(view.el.querySelector('[data-testid="caret"]')).not.toBeNull();
    } finally {
      dispose(view);
    }
  });

  it("toggles between the document and its source", async () => {
    const view = render(PLAN);
    try {
      await until(() => srcdocOf(view.el) !== "");
      const toSource = buttonIn(view.el, "source");
      expect(toSource).toBeDefined();
      await act(async () => toSource!.click());
      expect(view.el.querySelector("pre")?.textContent).toContain("<h1>Pasted");
      const toDocument = buttonIn(view.el, "document");
      expect(toDocument).toBeDefined();
      await act(async () => toDocument!.click());
      expect(view.el.querySelector("pre")).toBeNull();
      expect(frameIn(view.el)).not.toBeNull();
    } finally {
      dispose(view);
    }
  });

  it("names the diagnostics and shows the source when preparation fails", async () => {
    const source = "<html><body></body></html>";
    const view = render(source);
    try {
      await until(() => view.el.textContent!.includes("could not be displayed"));
      expect(view.el.textContent).toContain("could not be displayed as a document");
      expect(view.el.textContent).toContain("no visible content after preparation");
      // A transcript message is not an artifact: no on-disk footer.
      expect(view.el.textContent).not.toContain("artifact on disk");
      expect(view.el.querySelector("pre[data-selectable]")?.textContent).toContain(source);
      expect(view.el.querySelector("iframe")).toBeNull();
    } finally {
      dispose(view);
    }
  });
});

describe("Markdown Obsidian links", () => {
  function scoped(text: string) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    const renderLink = vi.fn((target: ObsidianNoteTarget, label: ReactNode) => (
      <a role="link" data-vault={target.vaultName} data-file={target.file}>{label}</a>
    ));
    act(() => root.render(
      <ObsidianNoteLinkContext.Provider value={renderLink}>
        <Markdown text={text} />
      </ObsidianNoteLinkContext.Provider>,
    ));
    return { el, root, renderLink };
  }

  it("leaves a valid link plain without a scoped renderer", () => {
    const { el, root } = render(obsidianReplyLink("Notes", "nested/Foo.md", "Foo"));
    expect(el.textContent).toBe("Foo");
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("[title]")).toBeNull();
    act(() => root.unmount());
  });

  it("passes the exact target and recursively rendered label to the scoped renderer", () => {
    const { el, root, renderLink } = scoped(
      "[**Exact** *note* `code`](obsidian://open?file=nested%2FFoo.md&vault=Notes)",
    );
    expect(renderLink).toHaveBeenCalledOnce();
    expect(renderLink.mock.calls[0]![0]).toEqual({ vaultName: "Notes", file: "nested/Foo.md" });
    const link = el.querySelector('a[role="link"]')!;
    expect(link.querySelector("strong")?.textContent).toBe("Exact");
    expect(link.querySelector("em")?.textContent).toBe("note");
    expect(link.querySelector("code")?.textContent).toBe("code");
    expect(link.hasAttribute("href")).toBe(false);
    act(() => root.unmount());
  });

  it("renders the canonical escaped title literally with a parentheses path", () => {
    const title = "[Exact] *note* `code` $cost | slash\\ and (draft)";
    const { el, root, renderLink } = scoped(obsidianReplyLink("Notes", "nested/Foo (draft).md", title));
    expect(el.querySelector("a")?.textContent).toBe(title);
    expect(el.querySelector("strong, em, code, .katex")).toBeNull();
    expect(renderLink.mock.calls[0]![0]).toEqual({ vaultName: "Notes", file: "nested/Foo (draft).md" });
    act(() => root.unmount());
  });

  it.each([
    "obsidian://open?vault=Notes&file=../Foo.md",
    "obsidian://open?vault=Notes&file=.hidden%2FFoo.md",
    "obsidian://open?vault=Notes&file=%2Ftmp%2FFoo.md",
    "obsidian://open?vault=Notes&file=C%3A%2FFoo.md",
    "obsidian://open?vault=Notes&file=Foo%23heading.md",
    "obsidian://open?vault=Notes&file=Foo%5Eblock.md",
    "obsidian://open?vault=Notes&file=Foo.md&file=Other.md",
    "obsidian://open?vault=Notes&file=Foo.md&extra=1",
    "obsidian://open?vault=Notes&file=%FF.md",
    "obsidian://open?vault=Notes&file=Foo%00.md",
    "obsidian://open?vault=Notes&file=Foo.md#heading",
    "obsidian://open/path?vault=Notes&file=Foo.md",
    "obsidian://user@open?vault=Notes&file=Foo.md",
    "obsidian://open:80?vault=Notes&file=Foo.md",
    "obsidian://open?path=%2Ftmp%2FFoo.md",
    "javascript:alert%281%29",
    "file:///tmp/Foo.md",
  ])("leaves refused target %s plain without a tooltip", (href) => {
    const { el, root, renderLink } = scoped(`[Note](${href})`);
    expect(el.textContent).toBe("Note");
    expect(el.querySelector("a, [title]")).toBeNull();
    expect(renderLink).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("keeps web and email links on the existing external-link branch", () => {
    const { el, root, renderLink } = scoped(
      "[Web](https://example.com/note) [Mail](mailto:notes@example.com)",
    );
    expect(renderLink).not.toHaveBeenCalled();
    expect(Array.from(el.querySelectorAll("a")).map((a) => a.title)).toEqual([
      "https://example.com/note", "mailto:notes@example.com",
    ]);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    act(() => el.querySelector("a")!.click());
    expect(open).toHaveBeenCalledWith("https://example.com/note", "_blank", "noopener,noreferrer");
    open.mockRestore();
    act(() => root.unmount());
  });

  it("does not activate links in code or incomplete streaming Markdown", () => {
    const link = obsidianReplyLink("Notes", "nested/Foo.md", "Foo");
    for (const text of [`\`${link}\``, `\`\`\`\n${link}\n\`\`\``, "[Foo](obsidian://open?vault=Notes&file=nested%2FFoo.md"]) {
      const { el, root, renderLink } = scoped(text);
      expect(el.querySelector("a")).toBeNull();
      expect(renderLink).not.toHaveBeenCalled();
      expect(el.textContent).toContain("obsidian://open?");
      act(() => root.unmount());
    }
  });

  it("keeps plain-text linkify HTTP-only even when scoped", () => {
    const href = "obsidian://open?vault=Notes&file=nested%2FFoo.md";
    const el = document.createElement("div");
    const root = createRoot(el);
    const renderLink = vi.fn(() => <a role="link" />);
    act(() => root.render(
      <ObsidianNoteLinkContext.Provider value={renderLink}>{linkify(href)}</ObsidianNoteLinkContext.Provider>,
    ));
    expect(el.textContent).toBe(href);
    expect(el.querySelector("a")).toBeNull();
    expect(renderLink).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
