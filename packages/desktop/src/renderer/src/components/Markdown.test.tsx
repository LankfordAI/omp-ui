// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "./Markdown";

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
