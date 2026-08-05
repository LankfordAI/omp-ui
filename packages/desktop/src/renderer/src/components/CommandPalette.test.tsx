// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.assign(window, { ompBackend: {} });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { CommandPalette, openPalette } = await import("./CommandPalette");

const originalMatchMedia = window.matchMedia;
let root: Root | null = null;

function renderPalette(compact: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: compact, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  useStore.setState({ state: null, tabs: [], activeTabId: null });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<CommandPalette />));
  act(() => openPalette());
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  if (originalMatchMedia === undefined) Reflect.deleteProperty(window, "matchMedia");
  else Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("CommandPalette close controls", () => {
  it("keeps the Escape hint on desktop", () => {
    renderPalette(false);
    expect(document.body.textContent).toContain("Esc");
  });

  it("uses only the visible close control in compact mode", () => {
    renderPalette(true);
    expect(document.body.textContent).not.toContain("Esc");
    expect(document.body.querySelector('button[aria-label="close dialog"]')).not.toBeNull();
  });
});
