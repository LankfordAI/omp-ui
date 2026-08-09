// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Modal, Sheet, UpdateCard } from "./ui";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function render(node: React.ReactNode): Promise<void> {
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  // requestAnimationFrame is callback-only, so its completion requires the executor form.
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("Sheet", () => {
  it("focuses initially, contains Tab, dismisses, and restores the trigger", async () => {
    const close = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    await render(<Sheet open placement="left" label="sessions" onClose={close}><button data-modal-initial-focus>first</button><button>last</button></Sheet>);
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    expect(document.activeElement?.textContent).toBe("first");
    buttons.at(-1)!.focus();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons[0]);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(close).toHaveBeenCalledTimes(1);
    act(() => root!.unmount());
    root = null;
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses from the scrim and explicit close", async () => {
    const close = vi.fn();
    await render(<Sheet open placement="right" label="inspector" onClose={close}>body</Sheet>);
    const overlay = document.body.querySelector<HTMLElement>("[data-overlay-root]")!;
    act(() => overlay.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(close).toHaveBeenCalledTimes(1);
    act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="close inspector"]')!.click());
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("Modal", () => {
  it("keeps a non-dismissible modal open on Escape and scrim pointer-down", async () => {
    await render(<Modal><button>only</button></Modal>);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    const overlay = document.body.querySelector<HTMLElement>("[data-overlay-root]")!;
    act(() => overlay.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("only lets the topmost overlay handle Escape", async () => {
    const bottom = vi.fn();
    const top = vi.fn();
    await render(<><Modal onClose={bottom}><button>bottom</button></Modal><Modal onClose={top}><button>top</button></Modal></>);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(top).toHaveBeenCalledOnce();
    expect(bottom).not.toHaveBeenCalled();
  });
});

describe("Button selected state", () => {
  it("emits aria-pressed and the check glyph when selected", async () => {
    await render(<Button selected tone="iris">medium</Button>);
    const button = document.body.querySelector("button")!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("emits aria-pressed=false and no glyph when unselected", async () => {
    await render(<Button selected={false} tone="iris">low</Button>);
    const button = document.body.querySelector("button")!;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.querySelector("svg")).toBeNull();
  });

  it("omits aria-pressed entirely for plain action buttons", async () => {
    await render(<Button tone="copper">Steer</Button>);
    expect(document.body.querySelector("button")!.hasAttribute("aria-pressed")).toBe(false);
  });
});

describe("UpdateCard", () => {
  it("renders an accessible dismiss action and reserves body space", async () => {
    const dismiss = vi.fn();
    await render(
      <UpdateCard dismissLabel="dismiss update" onDismiss={dismiss}>
        <span>available</span>
      </UpdateCard>,
    );
    const button = document.body.querySelector<HTMLButtonElement>('button[aria-label="dismiss update"]')!;
    act(() => button.click());
    expect(dismiss).toHaveBeenCalledOnce();
    expect(document.body.querySelector(".pr-6")?.textContent).toBe("available");
  });

  it("auto-dismisses after the configured interval", () => {
    vi.useFakeTimers();
    try {
      const dismiss = vi.fn();
      const host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      act(() => root!.render(
        <UpdateCard dismissLabel="dismiss" onDismiss={dismiss} autoDismissMs={5000}>
          up to date
        </UpdateCard>,
      ));
      act(() => vi.advanceTimersByTime(4999));
      expect(dismiss).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(dismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer on unmount and leaves untimed cards sticky", () => {
    vi.useFakeTimers();
    try {
      const timedDismiss = vi.fn();
      const timedHost = document.createElement("div");
      document.body.append(timedHost);
      root = createRoot(timedHost);
      act(() => root!.render(
        <UpdateCard dismissLabel="dismiss" onDismiss={timedDismiss} autoDismissMs={5000}>
          transient
        </UpdateCard>,
      ));
      act(() => root!.unmount());
      root = null;
      act(() => vi.advanceTimersByTime(5000));
      expect(timedDismiss).not.toHaveBeenCalled();

      document.body.replaceChildren();
      const stickyDismiss = vi.fn();
      const stickyHost = document.createElement("div");
      document.body.append(stickyHost);
      root = createRoot(stickyHost);
      act(() => root!.render(
        <UpdateCard dismissLabel="dismiss" onDismiss={stickyDismiss}>
          error
        </UpdateCard>,
      ));
      act(() => vi.advanceTimersByTime(10_000));
      expect(stickyDismiss).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
