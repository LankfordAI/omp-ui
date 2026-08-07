// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { linkify, Markdown } from "./Markdown";

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
