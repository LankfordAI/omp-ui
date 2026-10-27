// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerActions, type ComposerActionsLayout } from "./ComposerActions";
import type { PromptRoute } from "../lib/rpc-types";
import { formatHotkey } from "../lib/hotkeys";

interface Props {
  layout?: ComposerActionsLayout;
  running?: boolean;
  isSlash?: boolean;
  canSend?: boolean;
}
let root: Root | null = null;
let onSubmit: (route: PromptRoute | "interrupt") => void;
let onAbort: () => void;

function mount(p: Props = {}): void {
  onSubmit = vi.fn();
  onAbort = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ComposerActions
        layout={p.layout ?? "desktop"}
        running={p.running ?? false}
        isSlash={p.isSlash ?? false}
        canSend={p.canSend ?? true}
        onSubmit={onSubmit}
        onAbort={onAbort}
      />,
    ),
  );
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

const buttons = (): HTMLButtonElement[] =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")];
const click = (button: HTMLButtonElement): void => act(() => button.click());

describe("ComposerActions desktop", () => {
  it("idle: one round send button, click fires the prompt route", () => {
    mount({ layout: "desktop" });
    const all = buttons();
    expect(all).toHaveLength(1);
    expect(all[0]!.textContent).toBe("send");
    click(all[0]!);
    expect(onSubmit).toHaveBeenCalledWith("prompt");
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("idle: a slash draft reads run with the command title", () => {
    mount({ layout: "desktop", isSlash: true });
    const button = buttons()[0]!;
    expect(button.textContent).toBe("run");
    expect(button.title).toBe("run this command (enter)");
  });

  it("idle: the send button is disabled without a draft", () => {
    mount({ layout: "desktop", canSend: false });
    expect(buttons()[0]!.disabled).toBe(true);
  });

  it("running: steer, a route chevron, and stop", () => {
    mount({ layout: "desktop", running: true });
    const [steer, chevron, abort] = buttons();
    expect(buttons()).toHaveLength(3);
    expect(steer!.textContent).toBe("steer");
    expect(chevron!.getAttribute("aria-haspopup")).toBe("menu");
    expect(chevron!.getAttribute("aria-expanded")).toBe("false");
    expect(abort!.title).toBe("stop the turn — queued messages return to the draft (esc)");

    click(steer!);
    expect(onSubmit).toHaveBeenCalledWith("steer");
    click(abort!);
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("running: the chevron menu holds queue and interrupt & send with their shortcuts", () => {
    mount({ layout: "desktop", running: true });
    const chevron = buttons()[1]!;
    for (const [index, route, label, hotkey] of [
      [0, "follow_up", "queue", "mod+enter"],
      [1, "interrupt", "interrupt & send", "mod+shift+enter"],
    ] as const) {
      click(chevron);
      expect(chevron.getAttribute("aria-expanded")).toBe("true");
      const rows = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual(["queue", "interrupt & send"]);
      const row = rows[index]!;
      expect(row.firstElementChild?.textContent).toBe(label);
      expect(row.lastElementChild?.textContent).toBe(formatHotkey(hotkey));
      click(row);
      expect(onSubmit).toHaveBeenLastCalledWith(route);
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
    }
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("running: Escape closes the route menu, refocuses the chevron, and never aborts", () => {
    mount({ layout: "desktop", running: true });
    const chevron = buttons()[1]!;
    click(chevron);
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(chevron);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("running: a slash draft renames steer to run", () => {
    mount({ layout: "desktop", running: true, isSlash: true });
    expect(buttons()[0]!.textContent).toBe("run");
  });

  it("running: canSend false disables steer and its menu but not abort", () => {
    mount({ layout: "desktop", running: true, canSend: false });
    const [steer, chevron, abort] = buttons();
    expect(steer!.disabled).toBe(true);
    expect(chevron!.disabled).toBe(true);
    expect(abort!.disabled).toBe(false);
  });
});

describe("ComposerActions compact", () => {
  it("idle: capitalized send with the arrow glyph, click fires the prompt route", () => {
    mount({ layout: "compact" });
    const [send] = buttons();
    expect(send!.textContent).toBe("Send");
    expect(send!.querySelector("svg")).not.toBeNull();
    click(send!);
    expect(onSubmit).toHaveBeenCalledWith("prompt");
  });

  it("idle: a slash draft reads Run", () => {
    mount({ layout: "compact", isSlash: true });
    expect(buttons()[0]!.textContent).toBe("Run");
  });

  it("running: steer and abort", () => {
    mount({ layout: "compact", running: true });
    const [steer, abort] = buttons();
    expect(steer!.textContent).toBe("Steer");
    expect(abort!.textContent).toBe("Abort");
    click(steer!);
    expect(onSubmit).toHaveBeenCalledWith("steer");
    click(abort!);
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("running: a slash draft reads Run", () => {
    mount({ layout: "compact", running: true, isSlash: true });
    expect(buttons()[0]!.textContent).toBe("Run");
  });
});

describe("ComposerActions sheet", () => {
  it("renders nothing while idle", () => {
    mount({ layout: "sheet" });
    expect(document.body.querySelector("section")).toBeNull();
    expect(buttons()).toHaveLength(0);
  });

  it("running: Queue and Interrupt-and-send fire their routes", () => {
    mount({ layout: "sheet", running: true });
    const [queue, interrupt] = buttons();
    expect(queue!.textContent).toBe("Queue");
    expect(interrupt!.textContent).toBe("Interrupt-and-send");
    click(queue!);
    expect(onSubmit).toHaveBeenCalledWith("follow_up");
    click(interrupt!);
    expect(onSubmit).toHaveBeenCalledWith("interrupt");
  });

  it("running: canSend false disables both routes", () => {
    mount({ layout: "sheet", running: true, canSend: false });
    expect(buttons().every((button) => button.disabled)).toBe(true);
  });
});

describe("ComposerActions label parity", () => {
  it("a slash draft never shows send or steer on any surface", () => {
    for (const layout of ["desktop", "compact", "sheet"] as const) {
      if (root) act(() => root!.unmount());
      root = null;
      document.body.replaceChildren();
      mount({ layout, running: true, isSlash: true });
      const visible = buttons().map((button) => button.textContent ?? "");
      for (const word of ["send", "steer", "Send", "Steer"]) {
        expect(visible, `${layout}: ${word}`).not.toContain(word);
      }
    }
  });
});
