// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// DiffViewer reads the layout preference from the store; the store reaches
// backend.ts, which reads window.ompBackend at module load. No case here
// touches main, so the hoisted module mock suffices (ChangesViewer.test.tsx).
vi.mock("../backend", () => ({
  backend: new Proxy({}, { get: () => vi.fn(async () => undefined) }),
  backendFor: () => new Proxy({}, { get: () => vi.fn(async () => undefined) }),
}));

import { applyLocale, resolveLocale } from "../lib/i18n";
import type { DiffRow } from "../lib/omp-diff";
import { useStore } from "../store";
import { DiffViewer, type DiffViewerProps } from "./DiffViewer";
import { TONE_CHIP } from "./ui/tone";

const highlightCalls = vi.hoisted(() => [] as Array<{ code: string; enabled: boolean }>);
vi.mock(import("../lib/highlight"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useHighlightTokens: (code: string, _lang?: string, enabled = false) => {
      highlightCalls.push({ code, enabled });
      return enabled ? code.split("\n").map((line) => [{ content: line, offset: 0, color: "#aabbcc" }]) : null;
    },
  };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// The narrow-split fallback measures the scroller with a ResizeObserver.
// jsdom has neither layout nor the observer; the stub records instances so a
// test can fake `clientWidth` on the observed element and fire the callback
// the way a browser resize would.
const observers: { fire: () => void }[] = [];
let measuredWidth = 0;
class ResizeObserverStub {
  private target: Element | null = null;
  constructor(private readonly cb: ResizeObserverCallback) {
    observers.push({ fire: () => this.cb([], this as unknown as ResizeObserver) });
  }
  observe(target: Element): void {
    this.target = target;
    if (measuredWidth > 0) {
      Object.defineProperty(target, "clientWidth", { configurable: true, value: measuredWidth });
    }
  }
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

function fireResizes(): void {
  for (const observer of observers) observer.fire();
}

let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
  highlightCalls.length = 0;
  observers.length = 0;
  measuredWidth = 0;
  useStore.setState({ diffViewLayout: "unified" });
  applyLocale(resolveLocale("en"));
});

function render(rows: DiffRow[], path = "src/foo/bar.ts", extra: Partial<DiffViewerProps> = {}): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<DiffViewer rows={rows} path={path} {...extra} />));
}

/** The rendered diff lines; each Row is a `.border-l-2` div. */
const renderedRows = (): NodeListOf<Element> => document.body.querySelectorAll(".border-l-2");

const headerButton = (): HTMLButtonElement => {
  const button = document.body.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(button).not.toBeNull();
  return button!;
};

/** A header layout toggle by its aria-label (locale-resolved). */
const layoutButton = (label: string): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

/** Two-row hunk plus a second hunk starting nine lines later (§C fixture). */
const GAP_ROWS: DiffRow[] = [
  { kind: "meta", text: "@@ -1,3 +1,3 @@" },
  { kind: "ctx", lineNum: 1, text: "a" },
  { kind: "del", lineNum: 2, text: "x" },
  { kind: "add", lineNum: 2, text: "y" },
  { kind: "meta", text: "@@ -10,3 +10,3 @@" },
  { kind: "ctx", lineNum: 10, text: "b" },
];

describe("DiffViewer", () => {
  it("renders only the header card by default (issue #34)", () => {
    render([
      { kind: "add", lineNum: 1, text: "one" },
      { kind: "add", lineNum: 2, text: "two" },
      { kind: "del", lineNum: 3, text: "old" },
    ]);

    expect(document.body.textContent).toContain("bar.ts");
    expect(document.body.textContent).toContain("+2");
    expect(document.body.textContent).toContain("−1");
    expect(headerButton().getAttribute("aria-expanded")).toBe("false");
    expect(renderedRows().length).toBe(0);
    expect(document.body.textContent).not.toContain("one");
  });

  it("starts open with defaultOpen and still toggles closed", () => {
    render(
      [
        { kind: "add", lineNum: 1, text: "one" },
        { kind: "del", lineNum: 2, text: "old" },
      ],
      "a.ts",
      { defaultOpen: true },
    );

    expect(headerButton().getAttribute("aria-expanded")).toBe("true");
    expect(renderedRows().length).toBe(2);

    act(() => headerButton().click());
    expect(headerButton().getAttribute("aria-expanded")).toBe("false");
    expect(renderedRows().length).toBe(0);
  });

  it("expands on header click and collapses again", () => {
    render([
      { kind: "add", lineNum: 1, text: "one" },
      { kind: "del", lineNum: 2, text: "old" },
    ]);

    act(() => headerButton().click());
    expect(headerButton().getAttribute("aria-expanded")).toBe("true");
    expect(renderedRows().length).toBe(2);
    expect(document.body.textContent).toContain("one");

    act(() => headerButton().click());
    expect(headerButton().getAttribute("aria-expanded")).toBe("false");
    expect(renderedRows().length).toBe(0);
  });

  it("spans the add/del wash across the full scrollable band (issue #92)", () => {
    // jsdom cannot measure layout, so this pins the structure: every scroller
    // must wrap its rows in a `min-w-full w-max` band div, which sizes each
    // row to max(scrollport, widest row).
    const rows: DiffRow[] = Array.from({ length: 50 }, (_, i) => ({
      kind: "ctx",
      lineNum: i + 1,
      text: `line-${String(i).padStart(2, "0")}`,
    }));
    render(rows);

    act(() => headerButton().click());
    const bands = document.body.querySelectorAll(".overflow-x-auto > .min-w-full.w-max[data-selectable]");
    expect(bands.length).toBe(1);
    expect(bands[0]!.querySelectorAll(".border-l-2").length).toBe(50);
  });

  it("tokenizes only when expanded, old and new sides separately", () => {
    render([
      { kind: "ctx", lineNum: 1, text: "keep" },
      { kind: "del", lineNum: 2, text: "gone" },
      { kind: "add", lineNum: 2, text: "came" },
    ]);
    expect(highlightCalls.some((c) => c.enabled)).toBe(false);
    act(() => headerButton().click());
    const enabled = highlightCalls.filter((c) => c.enabled).slice(-2);
    expect(enabled.map((c) => c.code)).toEqual(["keep\ngone", "keep\ncame"]);
    const delRow = renderedRows()[1]!;
    const colored = [...delRow.querySelectorAll<HTMLElement>("span[style]")];
    expect(colored.map((el) => el.textContent).join("")).toBe("gone");
    expect(colored.every((el) => el.style.color === "rgb(170, 187, 204)")).toBe(true);
  });

  it("emphasizes the changed word in a paired line", () => {
    render([
      { kind: "del", lineNum: 1, text: "const a = 1;" },
      { kind: "add", lineNum: 1, text: "const a = 2;" },
    ]);
    act(() => headerButton().click());
    const emph = renderedRows()[1]!.querySelectorAll(".bg-signal-dim\\/20");
    expect(Array.from(emph, (e) => e.textContent)).toEqual(["2"]);
  });

  it("labels a rename-only file without an expand toggle", () => {
    render([], "new.ts", { renamedFrom: "old.ts", patch: "diff --git a/old.ts b/new.ts\n" });
    expect(document.body.textContent).toContain("renamed");
    expect(document.body.textContent).toContain("from old.ts");
    expect(document.body.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("shows delete in rose and localizes the op chip", () => {
    render([{ kind: "del", lineNum: 1, text: "x" }], "a.ts", { op: "delete" });
    const chip = Array.from(document.body.querySelectorAll("span")).findLast((s) => s.textContent === "delete");
    expect(chip?.className).toContain(TONE_CHIP.rose.split(" ")[0]);
    act(() => applyLocale(resolveLocale("ko")));
    act(() => root!.render(<DiffViewer rows={[{ kind: "del", lineNum: 1, text: "x" }]} path="a.ts" op="delete" />));
    expect(document.body.textContent).toContain("삭제");
  });

  it("follows a controlled open prop and reports toggles", () => {
    const rows: DiffRow[] = [{ kind: "add", lineNum: 1, text: "one" }];
    const onOpenChange = vi.fn();
    render(rows, "a.ts", { open: false, onOpenChange });
    act(() => headerButton().click());
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(renderedRows().length).toBe(0);
    act(() => root!.render(<DiffViewer rows={rows} path="a.ts" open onOpenChange={onOpenChange} />));
    expect(renderedRows().length).toBe(1);
  });

  it("replaces a gapped hunk header with an unmodified-lines rule carrying the raw header as title", () => {
    render(GAP_ROWS, "a.ts", { defaultOpen: true });

    // lastOld = lastNew = 2 → gap = 10 - 2 - 1 = 7 on both sides.
    const rule = document.body.querySelector<HTMLElement>('[title="@@ -10,3 +10,3 @@"]');
    expect(rule).not.toBeNull();
    expect(rule!.textContent).toBe("7 unmodified lines");
    // The collapsed header's raw text no longer renders; the leading hunk
    // (no prior numbered row) stays a raw meta row.
    expect(document.body.textContent).toContain("@@ -1,3 +1,3 @@");
    expect(document.body.textContent).not.toContain("@@ -10,3 +10,3 @@");
  });

  it("keeps adjacent-hunk headers raw (no gap to hide)", () => {
    render(
      [
        { kind: "ctx", lineNum: 1, text: "a" },
        { kind: "meta", text: "@@ -2,3 +2,3 @@" },
        { kind: "del", lineNum: 2, text: "x" },
      ],
      "a.ts",
      { defaultOpen: true },
    );
    expect(document.body.querySelector("[title='@@ -2,3 +2,3 @@']")).toBeNull();
    expect(document.body.textContent).toContain("@@ -2,3 +2,3 @@");
  });

  it("uses the new side alone for created files", () => {
    render(
      [
        { kind: "add", lineNum: 1, text: "a" },
        { kind: "meta", text: "@@ -0,0 +50,3 @@" },
        { kind: "add", lineNum: 50, text: "b" },
      ],
      "a.ts",
      { defaultOpen: true },
    );
    // lastNew = 1 → gap = 50 - 1 - 1 = 48; the absent old side is skipped.
    expect(document.body.querySelector('[title="@@ -0,0 +50,3 @@"]')?.textContent).toBe(
      "48 unmodified lines",
    );
  });

  it("offers a split/unified toggle once open and writes the store preference", () => {
    render(GAP_ROWS, "a.ts", { defaultOpen: true });
    expect(layoutButton("unified view")?.getAttribute("aria-pressed")).toBe("true");
    expect(layoutButton("split view")?.getAttribute("aria-pressed")).toBe("false");

    act(() => layoutButton("split view")!.click());
    expect(useStore.getState().diffViewLayout).toBe("split");
    expect(layoutButton("split view")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("pairs a del run with the following add run in split layout", () => {
    useStore.setState({ diffViewLayout: "split" });
    render(
      [
        { kind: "del", lineNum: 1, text: "gone" },
        { kind: "add", lineNum: 1, text: "came" },
      ],
      "a.ts",
      { defaultOpen: true },
    );

    const cells = document.body.querySelectorAll(".border-l-2");
    expect(cells.length).toBe(2);
    expect(cells[0]!.className).toContain("bg-rose-wash");
    expect(cells[0]!.textContent).toContain("gone");
    expect(cells[1]!.className).toContain("bg-signal-wash");
    expect(cells[1]!.textContent).toContain("came");
  });

  it("pads a leftover del with a same-wash filler cell in split layout", () => {
    useStore.setState({ diffViewLayout: "split" });
    render(
      [
        { kind: "del", lineNum: 1, text: "a" },
        { kind: "del", lineNum: 2, text: "b" },
        { kind: "add", lineNum: 1, text: "c" },
      ],
      "a.ts",
      { defaultOpen: true },
    );

    // Line 1: del `a` | add `c`. Line 2: del `b` | empty rose-wash filler.
    const roseCells = document.body.querySelectorAll(".bg-rose-wash");
    expect(roseCells.length).toBe(3);
    expect(Array.from(roseCells, (el) => el.querySelector(".whitespace-pre")?.textContent)).toEqual([
      "a",
      "b",
      "",
    ]);
  });

  it("renders unified under a narrow scroller despite the split preference", () => {
    useStore.setState({ diffViewLayout: "split" });
    measuredWidth = 400;
    render(
      [
        { kind: "del", lineNum: 1, text: "gone" },
        { kind: "add", lineNum: 1, text: "came" },
      ],
      "a.ts",
      { defaultOpen: true },
    );

    // jsdom fires no initial observe callback; deliver the resize a narrow
    // viewport would. Before it lands the card still renders split (no
    // `w-max` band); after, the unified band is back.
    expect(document.body.querySelector(".overflow-x-auto > .min-w-full.w-max[data-selectable]")).toBeNull();
    act(() => fireResizes());
    const band = document.body.querySelector(".overflow-x-auto > .min-w-full.w-max[data-selectable]");
    expect(band).not.toBeNull();
    expect(band!.querySelectorAll(".border-l-2").length).toBe(2);
    expect(band!.children[0]!.textContent).toContain("gone");
  });
});
