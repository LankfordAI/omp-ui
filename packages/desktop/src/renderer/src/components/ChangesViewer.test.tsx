// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The store reaches backend.ts, which reads window.ompBackend at module load;
// this viewer touches main only through store actions a case replaces, so the
// hoisted module mock suffices (same pattern as SessionTreeViewer.test.tsx).
vi.mock("../backend", () => ({
  backend: new Proxy({}, { get: () => vi.fn(async () => undefined) }),
  backendFor: () => new Proxy({}, { get: () => vi.fn(async () => undefined) }),
}));
// Expanded cards run DiffViewer's grammar passes; stub the hook so jsdom
// never loads real grammars (DiffViewer.test.tsx does the same).
vi.mock(import("../lib/highlight"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useHighlightTokens: () => null,
  };
});

import { applyLocale, resolveLocale, t } from "../lib/i18n";
import type { DiffRow } from "../lib/omp-diff";
import { useStore } from "../store";
import { ChangesViewerHost, openChangesViewer, type ChangesViewerCard } from "./ChangesViewer";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// useOverlay's Modal path touches ResizeObserver; jsdom has none.
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  disconnect() {}
};

let root: Root | null = null;

const rows = (...lines: string[]): DiffRow[] =>
  lines.map((line) => {
    const sign = line[0];
    if (sign === "+") return { kind: "add", text: line.slice(1) };
    if (sign === "-") return { kind: "del", text: line.slice(1) };
    return { kind: "ctx", text: line.slice(1) };
  });

const cardA: ChangesViewerCard = {
  key: "item-1",
  path: "src/a.ts",
  op: "update",
  rows: rows("+added", " ctx"),
};
const cardB: ChangesViewerCard = {
  key: "item-2",
  path: "src/b.ts",
  op: "create",
  rows: rows("+one", "+two"),
};

function mount(): void {
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ChangesViewerHost />));
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

/** The expand/collapse-all ghost button, by its (toggling) label. */
function toggleAll(): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) =>
      b.textContent === t("changes.expandAll") ||
      b.textContent === t("changes.collapseAll"),
  );
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label,
  );
}

/** aria-expanded of every card header button, in DOM order. */
function expandedStates(): (string | null)[] {
  return [
    ...document.body.querySelectorAll<HTMLButtonElement>(
      '[role="dialog"] button[aria-expanded]',
    ),
  ].map((b) => b.getAttribute("aria-expanded"));
}

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  applyLocale(resolveLocale("en"));
});

// The dispatcher fires a synchronous window event; act() covers the host's setState.
const open = (detail: { cards: ChangesViewerCard[]; tabId?: string }): void =>
  act(() => openChangesViewer(detail));

describe("ChangesViewer", () => {
  it("opens on a dispatched event with cards and shows the header summary", () => {
    mount();
    expect(dialog()).toBeNull();
    open({ cards: [cardA, cardB] });
    expect(dialog()).not.toBeNull();
    expect(document.body.textContent).toContain(
      t("changes.header", { files: 2, edits: 2 }),
    );
    // Summed counts across both cards: +3 −0.
    expect(dialog()!.textContent).toContain("+3");
  });

  it("ignores empty-cards dispatches from both the dispatcher and the event", () => {
    mount();
    open({ cards: [] });
    expect(dialog()).toBeNull();
    act(() => {
      window.dispatchEvent(
        new CustomEvent("omp-ui:changes-viewer", { detail: { cards: [] } }),
      );
    });
    expect(dialog()).toBeNull();
  });

  it("opens every card on expand all and closes them on collapse all", () => {
    mount();
    open({ cards: [cardA, cardB] });
    // Multiple cards start collapsed.
    expect(expandedStates()).toEqual(["false", "false"]);
    act(() => toggleAll()!.click());
    expect(toggleAll()!.textContent).toBe(t("changes.collapseAll"));
    expect(expandedStates()).toEqual(["true", "true"]);
    act(() => toggleAll()!.click());
    expect(toggleAll()!.textContent).toBe(t("changes.expandAll"));
    expect(expandedStates()).toEqual(["false", "false"]);
  });

  it("opens the single card by default", () => {
    mount();
    open({ cards: [cardA] });
    expect(expandedStates()).toEqual(["true"]);
  });

  it("counts a shared path once and numbers the later card #2", () => {
    mount();
    open({ cards: [cardA, { ...cardA, key: "item-9" }] });
    // Unique paths count once even though there are two edits.
    expect(document.body.textContent).toContain(
      t("changes.header", { files: 1, edits: 2 }),
    );
    expect(document.body.textContent).toContain("a.ts#2");
  });

  it("footer button focuses the rail Diffs pane and closes the overlay", () => {
    const focusRailPane = vi.fn();
    useStore.setState({ focusRailPane });
    mount();
    open({ cards: [cardA, cardB], tabId: "tab-changes" });
    const working = buttonByText(t("changes.workingTree"))!;
    act(() => working.click());
    expect(focusRailPane).toHaveBeenCalledWith("tab-changes", "diffs");
    expect(dialog()).toBeNull();
  });

  it("renders no footer button without a tabId", () => {
    mount();
    open({ cards: [cardA] });
    expect(buttonByText(t("changes.workingTree"))).toBeUndefined();
  });
});
