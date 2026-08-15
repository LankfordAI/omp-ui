// @vitest-environment jsdom
import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../lib/rpc-types";
import { backendState } from "../test/fixtures";
import { Button, ChoiceCapsule, ConfirmDialog, Modal, PerimeterGlow, PerimeterSweep, Sheet, UpdateCard, conicRing } from "./ui";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.assign(window, { ompBackend: {} });
let roCallback: ResizeObserverCallback | null = null;
(globalThis as Record<string, unknown>).ResizeObserver = class {
  constructor(cb: ResizeObserverCallback) { roCallback = cb; }
  observe() {}
  disconnect() {}
};
// store.ts captures window.ompBackend at evaluation; ModelSelector imports it, so both load after the stub.
const { useStore } = await import("../store");
const { ModelPalette } = await import("./ModelSelector");
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

  it("defers a portalled menu Escape while still closing outside the menu", async () => {
    const close = vi.fn();
    const menuEscape = vi.fn();
    await render(
      <Sheet open placement="left" label="sessions" onClose={close}>
        <button data-modal-initial-focus>sheet action</button>
        {createPortal(
          <div
            role="menu"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              menuEscape();
            }}
          >
            <button role="menuitem">portalled action</button>
          </div>,
          document.body,
        )}
      </Sheet>,
    );

    const menuItem = document.body.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    menuItem.focus();
    expect(document.activeElement).toBe(menuItem);
    const menuEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => menuItem.dispatchEvent(menuEvent));
    expect(menuEscape).toHaveBeenCalledOnce();
    expect(menuEvent.defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();

    const sheetAction = document.body.querySelector<HTMLButtonElement>("[data-modal-initial-focus]")!;
    sheetAction.focus();
    const sheetEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => sheetAction.dispatchEvent(sheetEvent));
    expect(sheetEvent.defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledOnce();
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

describe("ConfirmDialog", () => {
  it("owns the only alertdialog role and keeps its generated title relationship stable", async () => {
    const close = vi.fn();
    await render(
      <ConfirmDialog
        kicker="Irreversible action"
        title="Delete session?"
        tone="rose"
        onClose={close}
        actions={<Button onClick={close}>Cancel</Button>}
      >
        This cannot be undone.
      </ConfirmDialog>,
    );
    const alertDialogs = document.body.querySelectorAll<HTMLElement>('[role="alertdialog"]');
    expect(alertDialogs).toHaveLength(1);
    const labelledBy = alertDialogs[0].getAttribute("aria-labelledby");
    expect(labelledBy).not.toBeNull();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Delete session?");
    expect(alertDialogs[0].querySelectorAll(":scope > header")).toHaveLength(1);
    expect(alertDialogs[0].querySelectorAll(":scope > div")).toHaveLength(1);
    expect(alertDialogs[0].querySelectorAll(":scope > footer")).toHaveLength(1);

    act(() =>
      root!.render(
        <ConfirmDialog
          kicker="Irreversible action"
          title="Delete this session?"
          tone="rose"
          onClose={close}
          actions={<Button onClick={close}>Cancel</Button>}
        >
          This cannot be undone.
        </ConfirmDialog>,
      ),
    );
    const rerendered = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(rerendered.getAttribute("aria-labelledby")).toBe(labelledBy);
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Delete this session?");
  });
});

const CHOICE_OPTIONS = [
  { value: "alpha", label: "alpha" },
  { value: "beta", label: "beta", disabled: true },
  { value: "gamma", label: "gamma" },
  { value: "delta", label: "delta" },
] as const;

type Choice = (typeof CHOICE_OPTIONS)[number]["value"];

function ChoiceHarness({ initial = "alpha" }: { initial?: Choice }) {
  const [value, setValue] = useState<Choice>(initial);
  return (
    <ChoiceCapsule
      label="Greek choice"
      value={value}
      options={CHOICE_OPTIONS}
      onChange={setValue}
    />
  );
}

function pressChoice(button: HTMLButtonElement, key: string): void {
  act(() =>
    button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
  );
}

describe("ChoiceCapsule", () => {
  it("keeps one pressed Tab stop and selects a clicked choice", async () => {
    await render(<ChoiceHarness />);
    const group = document.body.querySelector<HTMLElement>('[role="group"][aria-label="Greek choice"]')!;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>("button")];

    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(buttons[1]!.disabled).toBe(true);

    act(() => buttons[2]!.click());
    expect(group.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(buttons[2]!.getAttribute("aria-pressed")).toBe("true");
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, -1, 0, -1]);
  });

  it("skips disabled choices and wraps while focusing and selecting", async () => {
    await render(<ChoiceHarness />);
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('[aria-label="Greek choice"] button')];
    buttons[0]!.focus();

    pressChoice(buttons[0]!, "ArrowRight");
    expect(document.activeElement).toBe(buttons[2]);
    expect(buttons[2]!.getAttribute("aria-pressed")).toBe("true");

    pressChoice(buttons[2]!, "ArrowLeft");
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");

    pressChoice(buttons[0]!, "ArrowLeft");
    expect(document.activeElement).toBe(buttons[3]);
    expect(buttons[3]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("moves to the first and last enabled choices with Home and End", async () => {
    await render(<ChoiceHarness initial="gamma" />);
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('[aria-label="Greek choice"] button')];
    buttons[2]!.focus();

    pressChoice(buttons[2]!, "End");
    expect(document.activeElement).toBe(buttons[3]);
    expect(buttons[3]!.getAttribute("aria-pressed")).toBe("true");

    pressChoice(buttons[3]!, "Home");
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ModelPalette favorite", () => {
  it("exposes a sibling native button that accepts keyboard-generated activation", async () => {
    const model: ModelInfo = { id: "sonnet", name: "Sonnet", provider: "anthropic" };
    const modelKey = `${model.provider}/${model.id}`;
    const toggleFavorite = vi.fn(async () => {});
    const pick = vi.fn();
    useStore.setState({
      state: backendState({ modelFavorites: [modelKey] }),
      toggleFavorite,
    });

    await render(
      <ModelPalette
        variant="main"
        models={[model]}
        current={model}
        onPick={pick}
        onClose={vi.fn()}
      />,
    );
    const favorite = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="remove from favorites"]',
    )!;
    const row = favorite.parentElement!;
    expect(row.querySelectorAll(":scope > button")).toHaveLength(2);
    expect(favorite.tabIndex).toBe(0);

    favorite.focus();
    expect(document.activeElement).toBe(favorite);
    act(() =>
      favorite.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }),
      ),
    );
    expect(toggleFavorite).toHaveBeenCalledWith(modelKey);
    expect(pick).not.toHaveBeenCalled();
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

describe("PerimeterSweep", () => {
  afterEach(() => vi.restoreAllMocks());

  it("traces the host border from the live size and computed radius", async () => {
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 200, height: 90 } as DOMRect);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ borderTopLeftRadius: "12px" } as CSSStyleDeclaration);
    await render(
      <div style={{ position: "relative", width: 200, height: 90, borderTopLeftRadius: "12px" }}>
        <PerimeterSweep tone="copper" />
      </div>,
    );
    const path = document.querySelector("svg path")!;
    expect(path.getAttribute("d")).toBe(
      "M 12 0.75 H 188 A 11.25 11.25 0 0 1 199.25 12 V 78 A 11.25 11.25 0 0 1 188 89.25 H 12 A 11.25 11.25 0 0 1 0.75 78 V 12 A 11.25 11.25 0 0 1 12 0.75 Z",
    );
    expect(path.getAttribute("pathLength")).toBe("1");
    expect(path.getAttribute("stroke-dasharray")).toBe("0.2 0.8");
  });

  it("follows resizes", async () => {
    const rectSpy = vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 200, height: 90 } as DOMRect);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ borderTopLeftRadius: "12px" } as CSSStyleDeclaration);
    await render(
      <div style={{ position: "relative", width: 200, height: 90, borderTopLeftRadius: "12px" }}>
        <PerimeterSweep tone="copper" />
      </div>,
    );
    rectSpy.mockReturnValue({ width: 300, height: 120 } as DOMRect);
    act(() => { roCallback!([] as ResizeObserverEntry[], {} as ResizeObserver); });
    const path = document.querySelector("svg path")!;
    expect(path.getAttribute("d")).toBe(
      "M 12 0.75 H 288 A 11.25 11.25 0 0 1 299.25 12 V 108 A 11.25 11.25 0 0 1 288 119.25 H 12 A 11.25 11.25 0 0 1 0.75 108 V 12 A 11.25 11.25 0 0 1 12 0.75 Z",
    );
  });

  it("paints nothing for a zero-size host", async () => {
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 0, height: 0 } as DOMRect);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ borderTopLeftRadius: "12px" } as CSSStyleDeclaration);
    await render(
      <div style={{ position: "relative", width: 200, height: 90, borderTopLeftRadius: "12px" }}>
        <PerimeterSweep tone="copper" />
      </div>,
    );
    const path = document.querySelector("svg path")!;
    expect(path.getAttribute("d")).toBe(null);
  });
});

describe("PerimeterGlow", () => {
  it("closes the conic ring back to the first stop", () => {
    expect(conicRing(["red", "blue"], 90)).toBe(
      "conic-gradient(from 90deg, red, blue, red)",
    );
  });

  it("renders an inert ring rotated by the wrapped phase", async () => {
    await render(<PerimeterGlow colors={["red", "blue"]} phase={-0.25} />);
    const el = document.querySelector<HTMLElement>("[data-perimeter-glow]")!;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.classList.contains("perimeter-glow")).toBe(true);
    expect(el.classList.contains("pointer-events-none")).toBe(true);
    expect(el.style.getPropertyValue("--perimeter-glow")).toBe(
      "conic-gradient(from 270deg, red, blue, red)",
    );
  });
});
