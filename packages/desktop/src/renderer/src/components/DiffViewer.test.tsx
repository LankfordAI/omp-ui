// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { DiffRow } from "../lib/omp-diff";
import { DiffViewer } from "./DiffViewer";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

function render(rows: DiffRow[], path = "src/foo/bar.ts"): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<DiffViewer rows={rows} path={path} />));
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

  it("keeps the 24-row head and tail disclosure once expanded", () => {
    const rows: DiffRow[] = Array.from({ length: 50 }, (_, i) => ({
      kind: "ctx",
      lineNum: i + 1,
      text: `line-${String(i).padStart(2, "0")}`,
    }));
    render(rows);

    act(() => headerButton().click());
    expect(renderedRows().length).toBe(24);
    expect(document.body.textContent).toContain("line-23");
    expect(document.body.textContent).not.toContain("line-24");
    expect(document.body.textContent).toContain("show 26 more lines");
  });
});
