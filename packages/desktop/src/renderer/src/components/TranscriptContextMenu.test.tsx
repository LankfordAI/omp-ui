// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptContextMenu } from "./TranscriptContextMenu";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

type MenuProps = Parameters<typeof TranscriptContextMenu>[0];

// The component portals into document.body, so queries below target body, not
// the host container.
function renderMenu(overrides: Partial<MenuProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <TranscriptContextMenu
        x={40}
        y={50}
        markdown={null}
        onCopy={() => {}}
        onCopyMarkdown={null}
        onClose={() => {}}
        {...overrides}
      />,
    ),
  );
}

function menuEl(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[role="menu"]');
  if (!el) throw new Error("menu not rendered");
  return el;
}

function menuItems(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("TranscriptContextMenu", () => {
  it("always renders Copy and shows Copy as Markdown only with markdown", () => {
    renderMenu();
    expect(menuItems().map((el) => el.textContent)).toEqual(["Copy"]);

    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();

    renderMenu({ markdown: "**raw** source", onCopyMarkdown: () => {} });
    expect(menuItems().map((el) => el.textContent)).toEqual(["Copy", "Copy as Markdown"]);
  });

  it("positions the menu at the right-click point", () => {
    renderMenu({ x: 123, y: 45 });
    expect(menuEl().style.left).toBe("123px");
    expect(menuEl().style.top).toBe("45px");
  });

  it("focuses the first menuitem on open", () => {
    renderMenu({ markdown: "raw", onCopyMarkdown: () => {} });
    expect(document.activeElement).toBe(menuItems()[0]);
  });

  it("calls onCopy then onClose when Copy is clicked", () => {
    const onCopy = vi.fn();
    const onClose = vi.fn();
    renderMenu({ onCopy, onClose });
    act(() => menuItems()[0]!.click());
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onCopyMarkdown then onClose when Copy as Markdown is clicked", () => {
    const onCopy = vi.fn();
    const onCopyMarkdown = vi.fn();
    const onClose = vi.fn();
    renderMenu({ markdown: "raw", onCopy, onCopyMarkdown, onClose });
    act(() => menuItems()[1]!.click());
    expect(onCopyMarkdown).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape", () => {
    const onClose = vi.fn();
    renderMenu({ onClose });
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on outside pointerdown but not on pointerdown inside the menu", () => {
    const onClose = vi.fn();
    renderMenu({ onClose });
    act(() => menuEl().dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
