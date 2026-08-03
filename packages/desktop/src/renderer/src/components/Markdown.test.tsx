// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "./Markdown";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function render(text: string): { el: HTMLDivElement; root: Root } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<Markdown text={text} />);
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
});
