// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerActions, type ComposerActionsLayout } from "./ComposerActions";
import type { PromptRoute } from "../lib/rpc-types";

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
  it("idle: one solid send button, click fires the prompt route", () => {
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

  it("running: exactly four controls, each firing its route", () => {
    mount({ layout: "desktop", running: true });
    const [interrupt, queue, steer, abort] = buttons();
    expect(interrupt!.textContent).toBe("interrupt & send");
    expect(queue!.textContent).toBe("queue");
    expect(steer!.textContent).toBe("steer");
    expect(abort!.title).toBe("abort the agent (esc)");

    click(interrupt!);
    expect(onSubmit).toHaveBeenCalledWith("interrupt");
    click(queue!);
    expect(onSubmit).toHaveBeenCalledWith("follow_up");
    click(steer!);
    expect(onSubmit).toHaveBeenCalledWith("steer");
    click(abort!);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledTimes(3);
  });

  it("running: a slash draft renames steer to run", () => {
    mount({ layout: "desktop", running: true, isSlash: true });
    expect(buttons()[2]!.textContent).toBe("run");
  });

  it("running: canSend false disables the send routes but not abort", () => {
    mount({ layout: "desktop", running: true, canSend: false });
    const [interrupt, queue, steer, abort] = buttons();
    expect(interrupt!.disabled).toBe(true);
    expect(queue!.disabled).toBe(true);
    expect(steer!.disabled).toBe(true);
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
