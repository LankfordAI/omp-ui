// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLocale, resolveLocale } from "../lib/i18n";
import type { DiffRow } from "../lib/omp-diff";
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

let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
  highlightCalls.length = 0;
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
});
