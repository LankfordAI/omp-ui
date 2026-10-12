// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { CONTEXT_FILES_EXTRA_KEY } from "@omp-ui/core/omp-settings-keys";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
Object.assign(window, { ompBackend: {} });
const { useStore } = await import("../../store");
const { ContextFilesSection } = await import("./ContextFilesSection");

function contextFilesEntry(value: OmpSettingValue): OmpSettingEntry {
  return {
    key: CONTEXT_FILES_EXTRA_KEY,
    type: "array",
    description: "",
    value,
    globalValue: value,
    options: null,
    layer: "global",
  };
}

let root: Root | null = null;

function mount(entry: OmpSettingEntry | undefined, commit = vi.fn()): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ContextFilesSection entry={entry} pendingKey={null} commit={commit} />));
  return host;
}

function addField(): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="add instruction file"]',
  );
  if (found === null) throw new Error("add field not found");
  return found;
}

function removeButton(): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes("remove"),
  );
  if (found === undefined) throw new Error("remove button not found");
  return found;
}

async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(el: HTMLInputElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ state: backendState() });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("ContextFilesSection (issue #837)", () => {
  it("renders nothing when the snapshot has no entry", () => {
    const host = mount(undefined);
    expect(host.textContent).toBe("");
  });

  it("lists each path and commits the empty array when the last one is removed", async () => {
    const commit = vi.fn();
    const host = mount(contextFilesEntry(["AGENTS.local.md"]), commit);
    expect(host.textContent).toContain("AGENTS.local.md");
    await click(removeButton());
    expect(commit).toHaveBeenCalledWith(CONTEXT_FILES_EXTRA_KEY, []);
  });

  it("commits the full merged array when a new path is added", async () => {
    const commit = vi.fn();
    mount(contextFilesEntry(["AGENTS.local.md"]), commit);
    const field = addField();
    await typeInto(field, "docs/STYLE.md");
    await pressEnter(field);
    expect(commit).toHaveBeenCalledWith(CONTEXT_FILES_EXTRA_KEY, [
      "AGENTS.local.md",
      "docs/STYLE.md",
    ]);
  });

  it("commits nothing for a whitespace-only or duplicate draft", async () => {
    const commit = vi.fn();
    mount(contextFilesEntry(["AGENTS.local.md"]), commit);
    const field = addField();
    await typeInto(field, "   ");
    await pressEnter(field);
    await typeInto(field, "AGENTS.local.md");
    await pressEnter(field);
    expect(commit).not.toHaveBeenCalled();
  });

  it("renders only the string members of a malformed array", () => {
    const host = mount(contextFilesEntry(["a", 3 as never]));
    expect(host.textContent).toContain("a");
    expect(host.querySelectorAll("button")).toHaveLength(1);
  });
});
