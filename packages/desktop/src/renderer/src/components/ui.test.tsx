// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal, Sheet } from "./ui";

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
