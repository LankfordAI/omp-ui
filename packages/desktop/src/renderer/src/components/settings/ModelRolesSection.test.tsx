// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot, OmpSettingEntry } from "@omp-ui/core/types";
import { OMP_MODEL_ROLES_KEY } from "@omp-ui/core/omp-settings-keys";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
Object.assign(window, { ompBackend: {} });
const { useStore } = await import("../../store");
const { ModelRolesSection } = await import("./ModelRolesSection");

const CATALOG: ModelCatalogSnapshot = {
  models: [
    { provider: "litellm", id: "quick", name: "Quick" },
    { provider: "anthropic", id: "sonnet", name: "Sonnet" },
  ],
  discovered: true,
  error: null,
};

const STORED: Record<string, unknown> = {
  tiny: "anthropic/claude-opus-5-5",
  commit: "litellm/quick",
  smol: "anthropic/claude-haiku",
};

function rolesEntry(value: Record<string, unknown> = STORED): OmpSettingEntry {
  return {
    key: OMP_MODEL_ROLES_KEY,
    type: "record",
    description: "",
    value,
    globalValue: value,
    options: null,
    layer: "global",
  };
}

let root: Root | null = null;

function mount(entry: OmpSettingEntry, commit = vi.fn()): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ModelRolesSection entry={entry} pendingKey={null} commit={commit} />));
  return host;
}

function field(role: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(
    `input[aria-label="model role ${role}"]`,
  );
  if (found === null) throw new Error(`field not found: ${role}`);
  return found;
}

function browseButton(role: string): HTMLButtonElement {
  const found = field(role).parentElement?.querySelector<HTMLButtonElement>("button");
  if (found === undefined || found === null) throw new Error(`browse not found: ${role}`);
  return found;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (found === undefined) throw new Error(`button not found: ${text}`);
  return found;
}

async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("ModelRolesSection browse picker (issue #797)", () => {
  it("commits the whole merged record when a catalog model is picked, siblings intact", async () => {
    const readChatModels = vi.fn<() => Promise<ModelCatalogSnapshot>>(async () => CATALOG);
    useStore.setState({ readChatModels });
    const commit = vi.fn();
    mount(rolesEntry(), commit);

    await act(async () => browseButton("tiny").click());
    expect(readChatModels).toHaveBeenCalledTimes(1);
    // The palette opens on Favorites; the provider tab lists the catalog rows.
    act(() => buttonByText("litellm").click());
    act(() => buttonByText("Quick").click());

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(OMP_MODEL_ROLES_KEY, {
      tiny: "litellm/quick",
      commit: "litellm/quick",
      smol: "anthropic/claude-haiku",
    });
  });

  it("an omp-default pick drops only that role's key", async () => {
    const readChatModels = vi.fn<() => Promise<ModelCatalogSnapshot>>(async () => CATALOG);
    useStore.setState({ readChatModels });
    const commit = vi.fn();
    mount(rolesEntry(), commit);

    await act(async () => browseButton("commit").click());
    act(() => buttonByText("omp default").click());

    expect(commit).toHaveBeenCalledWith(OMP_MODEL_ROLES_KEY, {
      tiny: "anthropic/claude-opus-5-5",
      smol: "anthropic/claude-haiku",
    });
  });

  it("a failed probe reports inline and leaves the free-text field editable", async () => {
    const readChatModels = vi
      .fn<() => Promise<ModelCatalogSnapshot>>()
      .mockRejectedValue(new Error("boom"));
    useStore.setState({ readChatModels });
    const commit = vi.fn();
    mount(rolesEntry(), commit);

    await act(async () => browseButton("tiny").click());
    expect(document.body.textContent).toContain("model list failed");

    await typeInto(field("tiny"), "litellm/q:low");
    await act(async () => {
      field("tiny").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(commit).toHaveBeenCalledWith(OMP_MODEL_ROLES_KEY, {
      tiny: "litellm/q:low",
      commit: "litellm/quick",
      smol: "anthropic/claude-haiku",
    });
  });
});
