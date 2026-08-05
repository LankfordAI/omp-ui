// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPACT_SHELL_QUERY, useAppViewport, useCompactShell } from "./responsive";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

function mount(node: ReactNode): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--app-viewport-height");
  vi.restoreAllMocks();
});

describe("responsive viewport hooks", () => {
  it("tracks initial and changed compact media values", () => {
    let matches = true;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      media: query,
      get matches() { return matches; },
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    })));
    const values: boolean[] = [];
    function Probe() { values.push(useCompactShell()); return null; }
    mount(createElement(Probe));
    expect(window.matchMedia).toHaveBeenCalledWith(COMPACT_SHELL_QUERY);
    expect(values.at(-1)).toBe(true);
    act(() => { matches = false; listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent)); });
    expect(values.at(-1)).toBe(false);
  });

  it("supports legacy media listeners and cleans them up", () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener, removeListener })));
    function Probe() { useCompactShell(); return null; }
    mount(createElement(Probe));
    const listener = addListener.mock.calls[0]![0];
    act(() => root!.unmount());
    root = null;
    expect(removeListener).toHaveBeenCalledWith(listener);
  });

  it("writes visual viewport height on resize and removes it on cleanup", () => {
    const viewport = new EventTarget() as VisualViewport;
    Object.defineProperty(viewport, "height", { value: 640, writable: true });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    function Probe() { useAppViewport(); return null; }
    mount(createElement(Probe));
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("640px");
    (viewport as VisualViewport & { height: number }).height = 480;
    act(() => viewport.dispatchEvent(new Event("resize")));
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("480px");
    act(() => root!.unmount());
    root = null;
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("");
  });
});
