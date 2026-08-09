// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlashPalette, type SlashPaletteHandle } from "./SlashPalette";
import { usePaletteNav } from "./palette";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const scrollIntoView = vi.fn();
HTMLElement.prototype.scrollIntoView = scrollIntoView;

let root: Root | null = null;

interface HarnessProps {
  items: readonly string[];
  resetKey: string;
  initialIndex?: number;
  acceptTab?: boolean;
  onPick(item: string): void;
  onClose(): void;
  onEnter?(event: React.KeyboardEvent): boolean;
}

function Harness(props: HarnessProps) {
  const { active, setActive, activeRef, handleKey } = usePaletteNav(props);
  return (
    <div>
      <input aria-label="palette input" onKeyDown={handleKey} />
      <output aria-label="active index">{active}</output>
      {props.items.map((item, index) => (
        <button
          key={item}
          ref={index === active ? activeRef : null}
          data-active={index === active ? "true" : "false"}
          onMouseEnter={() => setActive(index)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

function mount(node: React.ReactNode): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  return event;
}

function activeIndex(): number {
  return Number(document.body.querySelector('output[aria-label="active index"]')!.textContent);
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  scrollIntoView.mockClear();
});

describe("usePaletteNav", () => {
  it("wraps Arrow and Ctrl-N/P navigation and commits Enter", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    mount(<Harness items={["one", "two"]} resetKey="a" onPick={onPick} onClose={onClose} />);
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="palette input"]')!;

    expect(press(input, "ArrowUp").defaultPrevented).toBe(true);
    expect(activeIndex()).toBe(1);
    press(input, "n", { ctrlKey: true });
    expect(activeIndex()).toBe(0);
    press(input, "p", { ctrlKey: true });
    expect(activeIndex()).toBe(1);
    expect(press(input, "Enter").defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenCalledWith("two");

    expect(press(input, "Escape").defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clamps a shrinking list, resets with resetKey, and scrolls the active row", () => {
    const props = { onPick: vi.fn(), onClose: vi.fn() };
    mount(<Harness items={["one", "two", "three"]} resetKey="a" {...props} />);
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="palette input"]')!;

    scrollIntoView.mockClear();
    press(input, "ArrowDown");
    press(input, "ArrowDown");
    expect(activeIndex()).toBe(2);
    expect(scrollIntoView).toHaveBeenCalled();

    act(() => root!.render(<Harness items={["one"]} resetKey="a" {...props} />));
    expect(activeIndex()).toBe(0);
    act(() => root!.render(<Harness items={["one", "two"]} resetKey="a" {...props} />));
    press(input, "ArrowDown");
    expect(activeIndex()).toBe(1);
    act(() => root!.render(<Harness items={["one", "two"]} resetKey="b" {...props} />));
    expect(activeIndex()).toBe(0);
  });

  it("does not navigate or pick an empty list", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    mount(<Harness items={[]} resetKey="empty" onPick={onPick} onClose={onClose} />);
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="palette input"]')!;

    expect(press(input, "ArrowDown").defaultPrevented).toBe(false);
    expect(press(input, "ArrowUp").defaultPrevented).toBe(false);
    expect(press(input, "Enter").defaultPrevented).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("supports an unselected state, consuming Enter, and opt-in Tab picks", () => {
    const onPick = vi.fn();
    const onEnter = vi.fn(() => true);
    const props = { items: ["one", "two"], resetKey: "a", initialIndex: -1, onPick, onClose: vi.fn(), onEnter };
    mount(<Harness {...props} />);
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="palette input"]')!;

    expect(activeIndex()).toBe(-1);
    expect(press(input, "Enter").defaultPrevented).toBe(true);
    expect(onEnter).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
    press(input, "ArrowUp");
    expect(activeIndex()).toBe(1);
    expect(press(input, "Tab").defaultPrevented).toBe(false);

    act(() => root!.render(<Harness {...props} acceptTab />));
    expect(press(input, "Tab").defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenCalledWith("two");
  });
});

describe("SlashPalette", () => {
  it("keeps focus controlled while navigating grouped parent and subcommand rows", () => {
    const onPick = vi.fn();
    const palette = createRef<SlashPaletteHandle>();
    mount(
      <div>
        <textarea aria-label="composer" onKeyDown={(event) => palette.current?.handleKey(event)} />
        <SlashPalette
          ref={palette}
          query=""
          commands={[
            {
              name: "session",
              description: "session actions",
              source: "builtin",
              subcommands: [
                { name: "list", description: "list sessions" },
                { name: "open", description: "open a session", usage: "<id>" },
              ],
            },
            { name: "review", description: "review changes", source: "extension" },
          ]}
          onPick={onPick}
          onClose={vi.fn()}
        />
      </div>,
    );
    const composer = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="composer"]')!;
    const rows = [...document.body.querySelectorAll<HTMLButtonElement>("button")];
    act(() => composer.focus());

    expect(document.body.textContent).toContain("builtin");
    expect(document.body.textContent).toContain("extensions");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "/session: session actions",
      "/session list: list sessions",
      "/session open: open a session",
      "/review: review changes",
    ]);
    press(composer, "ArrowDown");
    expect(document.activeElement).toBe(composer);
    expect(rows[1]!.className).toContain("bg-hover");
    press(composer, "Enter");
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ name: "session" }),
      expect.objectContaining({ name: "list" }),
    );
  });
});
