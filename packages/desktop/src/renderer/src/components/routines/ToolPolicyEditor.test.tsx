// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RoutineCatalogSnapshot, RoutineToolPolicy } from "@omp-ui/core/routine";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });
// Dynamic import: the i18n catalog and components load after the backend stub.
const { ToolPolicyEditor } = await import("./ToolPolicyEditor");

const CATALOG: RoutineCatalogSnapshot = {
  tools: [
    { key: "read", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Read files" },
    { key: "bash", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Run a shell" },
    { key: "mcp__demo_ping", source: "mcp", group: "mcp:demo", groupLabel: "demo", description: "" },
  ],
  staleServers: [],
  enumerationError: null,
  capturedAt: "2026-11-22T00:00:00.000Z",
};

function policy(patch: Partial<RoutineToolPolicy> = {}): RoutineToolPolicy {
  return {
    allow: ["read"],
    deny: ["bash"],
    lastReviewedAt: "2026-11-01T00:00:00.000Z",
    reviewedCatalog: ["read", "bash", "mcp__demo_ping"],
    ...patch,
  };
}

let root: Root | null = null;
let onChange: Mock<(next: RoutineToolPolicy) => void>;

function renderEditor(overrides: Partial<Parameters<typeof ToolPolicyEditor>[0]> = {}): void {
  if (!root) throw new Error("root not mounted");
  const props: Parameters<typeof ToolPolicyEditor>[0] = {
    policy: policy(),
    catalog: CATALOG,
    catalogError: null,
    reviewed: false,
    disabled: false,
    onChange,
    ...overrides,
  };
  act(() => root!.render(<ToolPolicyEditor {...props} />));
}

function visibleRows(): string[] {
  return [...document.querySelectorAll("[data-tool-row]")].map((el) => el.getAttribute("data-tool-row")!);
}

function chip(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("[data-decision-filter] button")].find(
    (b) => b.textContent?.startsWith(label),
  );
  if (!button) throw new Error(`chip "${label}" not found`);
  return button;
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeFilter(value: string): void {
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  act(() => {
    // React's value tracker ignores a direct .value assignment; go through the
    // native setter so the controlled input sees an onChange.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  onChange = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("ToolPolicyEditor decision filter", () => {
  it("shows every row by default with global chip counts", () => {
    renderEditor();
    expect(visibleRows().sort()).toEqual(["bash", "mcp__demo_ping", "read"]);
    expect(chip("All").textContent).toBe("All3");
    expect(chip("Allowed").textContent).toBe("Allowed1");
    expect(chip("Denied").textContent).toBe("Denied1");
    expect(chip("Ask").textContent).toBe("Ask1");
  });

  it("Allowed chip narrows to checked tools only", () => {
    renderEditor();
    click(chip("Allowed"));
    expect(visibleRows()).toEqual(["read"]);
  });

  it("Denied chip narrows to hard-denied tools", () => {
    renderEditor();
    click(chip("Denied"));
    expect(visibleRows()).toEqual(["bash"]);
  });

  it("Ask chip composes with the text filter", () => {
    renderEditor();
    click(chip("Ask"));
    expect(visibleRows()).toEqual(["mcp__demo_ping"]);
    typeFilter("ping");
    expect(visibleRows()).toEqual(["mcp__demo_ping"]);
  });

  it("an empty narrowed view prints the no-matches line", () => {
    renderEditor();
    click(chip("Denied"));
    typeFilter("read");
    expect(visibleRows()).toEqual([]);
    expect(document.querySelector("[data-policy-empty]")).not.toBeNull();
  });

  it("chip clicks never mutate the policy", () => {
    renderEditor();
    click(chip("Allowed"));
    click(chip("Denied"));
    click(chip("Ask"));
    click(chip("All"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("counts include policy keys the catalog dropped", () => {
    renderEditor({
      policy: policy({ allow: ["read", "gone_tool"], reviewedCatalog: [] }),
    });
    expect(chip("Allowed").textContent).toBe("Allowed2");
    click(chip("Allowed"));
    expect(visibleRows().sort()).toEqual(["gone_tool", "read"]);
  });
});
