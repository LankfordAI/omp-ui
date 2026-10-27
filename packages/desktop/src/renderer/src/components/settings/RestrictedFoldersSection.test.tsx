// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { RESTRICTED_FOLDERS_KEY } from "@omp-ui/core/omp-settings-keys";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
Object.assign(window, { ompBackend: {} });
const { useStore } = await import("../../store");
const { RestrictedFoldersSection } = await import("./RestrictedFoldersSection");

function restrictedEntry(
  value: OmpSettingValue,
  globalValue: OmpSettingValue = value,
  layer: OmpSettingEntry["layer"] = "global",
): OmpSettingEntry {
  return {
    key: RESTRICTED_FOLDERS_KEY,
    type: "array",
    description: "",
    value,
    globalValue,
    options: null,
    layer,
  };
}

let root: Root | null = null;

function mount(
  entry: OmpSettingEntry | undefined,
  commit = vi.fn(),
  pendingKey: string | null = null,
): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<RestrictedFoldersSection entry={entry} pendingKey={pendingKey} commit={commit} />));
  return host;
}

function addField(): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="add restricted folder"]',
  );
  if (found === null) throw new Error("add field not found");
  return found;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`${label} button not found`);
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

describe("RestrictedFoldersSection (issue #951)", () => {
  it("renders nothing when the snapshot has no entry", () => {
    const host = mount(undefined);
    expect(host.textContent).toBe("");
  });

  it("edits from the Global list and shows the project override notice", async () => {
    const commit = vi.fn();
    const host = mount(restrictedEntry(["/proj/a"], ["/g/a"], "project"), commit);
    expect(host.textContent).toContain("/g/a");
    expect(host.textContent).toContain("overrides the Global list");
    expect(host.textContent).toContain("/proj/a");
    const field = addField();
    await typeInto(field, "~/secrets");
    await pressEnter(field);
    expect(commit).toHaveBeenCalledWith(RESTRICTED_FOLDERS_KEY, ["/g/a", "~/secrets"]);
  });

  it("commits the empty array when the last folder is removed", async () => {
    const commit = vi.fn();
    mount(restrictedEntry(["/g/a"]), commit);
    await click(button("remove"));
    expect(commit).toHaveBeenCalledWith(RESTRICTED_FOLDERS_KEY, []);
  });

  it("commits nothing for a whitespace-only or duplicate draft", async () => {
    const commit = vi.fn();
    mount(restrictedEntry(["/g/a"]), commit);
    const field = addField();
    await typeInto(field, "   ");
    await pressEnter(field);
    await typeInto(field, "/g/a");
    await pressEnter(field);
    expect(commit).not.toHaveBeenCalled();
  });

  it("disables remove, the add field, and Browse while its write is pending", () => {
    mount(restrictedEntry(["/g/a", "/g/b"]), vi.fn(), RESTRICTED_FOLDERS_KEY);
    const removes = [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter(
      (candidate) => candidate.textContent?.includes("remove"),
    );
    expect(removes).toHaveLength(2);
    for (const remove of removes) expect(remove.disabled).toBe(true);
    expect(addField().disabled).toBe(true);
    expect(button("Browse").disabled).toBe(true);
  });
});
