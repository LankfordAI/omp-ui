// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FindBar, type FindBarProps } from "./FindBar";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function render(props: Partial<FindBarProps> = {}) {
  const onQueryChange = vi.fn();
  const onPrev = vi.fn();
  const onNext = vi.fn();
  const onClose = vi.fn();
  const bar: FindBarProps = {
    query: "",
    matchIndex: null,
    matchCount: 0,
    onQueryChange,
    onPrev,
    onNext,
    onClose,
    ...props,
  };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<FindBar {...bar} />);
  });
  return { el, root, onQueryChange, onPrev, onNext, onClose };
}

function findInput(el: HTMLDivElement): HTMLInputElement {
  const input = el.querySelector<HTMLInputElement>(".find-bar-input");
  if (!input) throw new Error("find-bar-input not found");
  return input;
}

// React tracks the input's value through its own setter; assigning
// `input.value` directly is invisible to it, so the setter must be called
// before the synthetic "input" event or the change is swallowed.
const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

function type(input: HTMLInputElement, text: string) {
  act(() => {
    valueSetter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(input: HTMLInputElement, keyName: string, init: KeyboardEventInit = {}) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, ...init }));
  });
}

describe("FindBar", () => {
  it("renders the active match position in the readout", () => {
    const { el, root } = render({ query: "needle", matchIndex: 1, matchCount: 5 });
    expect(el.textContent).toContain("2 / 5");
    act(() => root.unmount());
  });

  it("renders no matches when the query has nothing to highlight", () => {
    const { el, root } = render({ query: "abc", matchIndex: null, matchCount: 0 });
    expect(el.textContent).toContain("no matches");
    expect(el.textContent).not.toContain("/");
    act(() => root.unmount());
  });

  it("renders no readout for an empty query", () => {
    const { el, root } = render({ query: "" });
    expect(el.textContent).not.toContain("no matches");
    expect(el.textContent).not.toContain("/");
    act(() => root.unmount());
  });

  it("fires onQueryChange with the typed value", () => {
    const { el, root, onQueryChange } = render({ query: "" });
    const input = findInput(el);
    type(input, "abc");
    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenCalledWith("abc");
    act(() => root.unmount());
  });

  it("Enter advances to the next match", () => {
    const { el, root, onNext, onPrev } = render({ query: "abc", matchIndex: 0, matchCount: 3 });
    press(findInput(el), "Enter");
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("Shift+Enter steps back to the previous match", () => {
    const { el, root, onNext, onPrev } = render({ query: "abc", matchIndex: 2, matchCount: 3 });
    press(findInput(el), "Enter", { shiftKey: true });
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("Escape closes the bar", () => {
    const { el, root, onClose, onNext } = render({ query: "abc", matchIndex: 0, matchCount: 3 });
    press(findInput(el), "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
