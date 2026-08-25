// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDismissal } from "./use-dismissal";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

interface HarnessProps {
  onClose: () => void;
  onEscape?: () => void;
  restoreFocus?: () => void;
  exemptSelector?: string;
}

/** Trigger + panel wired to useDismissal; the panel is the only ref. */
function Harness({ open, ...p }: HarnessProps & { open: boolean }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissal({ open, refs: panelRef, ...p });
  return (
    <div>
      <div data-testid="trigger">trigger</div>
      <div ref={panelRef} data-testid="panel">
        <span data-testid="panel-item">item</span>
      </div>
      <div data-exempt data-testid="exempt">exempt</div>
    </div>
  );
}

/** Mount with `open`; the returned setter re-renders the same tree (refs kept). */
function mount(open: boolean, p: HarnessProps): (next: boolean) => void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Harness open={open} {...p} />));
  return (next: boolean) => act(() => root!.render(<Harness open={next} {...p} />));
}

const outside = (): void => {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
};

const query = (testid: string): HTMLElement =>
  document.querySelector(`[data-testid="${testid}"]`) as HTMLElement;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("useDismissal", () => {
  it("dismisses on an outside pointerdown and ignores pointerdowns inside a ref", () => {
    const onClose = vi.fn();
    mount(true, { onClose });
    outside();
    expect(onClose).toHaveBeenCalledTimes(1);
    // The trigger is not in `refs`, so a pointerdown on it is outside.
    query("trigger").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    // Inside the panel: never dismisses.
    query("panel-item").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("never dismisses a target matching exemptSelector", () => {
    const onClose = vi.fn();
    mount(true, { onClose, exemptSelector: "[data-exempt]" });
    query("exempt").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    outside();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape runs onEscape (not onClose) and then restoreFocus, cancelling the default", () => {
    const onClose = vi.fn();
    const onEscape = vi.fn();
    const restoreFocus = vi.fn();
    mount(true, { onClose, onEscape, restoreFocus });
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(restoreFocus).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    // Non-Escape keys are ignored.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("registers no keydown listener at all when onEscape is omitted", () => {
    const add = vi.spyOn(window, "addEventListener");
    try {
      mount(true, { onClose: () => {} });
      expect(add.mock.calls.map(([type]) => type)).toEqual(["pointerdown"]);
    } finally {
      add.mockRestore();
    }
  });

  it("toggling open to false removes both listeners; further events are no-ops", () => {
    const onClose = vi.fn();
    const onEscape = vi.fn();
    const setOpen = mount(true, { onClose, onEscape });
    outside();
    expect(onClose).toHaveBeenCalledTimes(1);
    setOpen(false);
    outside();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();
  });
});
