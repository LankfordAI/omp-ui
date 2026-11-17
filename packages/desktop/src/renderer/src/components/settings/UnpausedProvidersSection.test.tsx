// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { PAUSED_PROVIDER_SPECS, UNPAUSED_PROVIDERS_KEY } from "@omp-ui/core/omp-settings-keys";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
Object.assign(window, { ompBackend: {} });
const { useStore } = await import("../../store");
const { UnpausedProvidersSection } = await import("./UnpausedProvidersSection");

function unpausedEntry(
  value: OmpSettingValue,
  globalValue: OmpSettingValue = value,
  layer: OmpSettingEntry["layer"] = "global",
): OmpSettingEntry {
  return {
    key: UNPAUSED_PROVIDERS_KEY,
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
  act(() => root!.render(<UnpausedProvidersSection entry={entry} pendingKey={pendingKey} commit={commit} />));
  return host;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`${label} button not found`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

const PAUSED = PAUSED_PROVIDER_SPECS[0]!;

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

describe("UnpausedProvidersSection (issue #1206)", () => {
  it("renders nothing when the snapshot has no entry", () => {
    const host = mount(undefined);
    expect(host.textContent).toBe("");
  });

  it("states each pause reason and requires a second acceptance click", async () => {
    const commit = vi.fn();
    const host = mount(unpausedEntry([]), commit);
    expect(host.textContent).toContain(PAUSED.risk);
    await click(button("enable…"));
    // The first click arms the acceptance; nothing is written yet.
    expect(commit).not.toHaveBeenCalled();
    await click(button("accept the risk and enable"));
    expect(commit).toHaveBeenCalledWith(UNPAUSED_PROVIDERS_KEY, [PAUSED.id]);
  });

  it("pauses an unpaused provider again with the id removed from the Global list", async () => {
    const commit = vi.fn();
    mount(unpausedEntry([PAUSED.id]), commit);
    await click(button("pause again"));
    expect(commit).toHaveBeenCalledWith(UNPAUSED_PROVIDERS_KEY, []);
  });

  it("edits from the Global list and shows the project override notice", async () => {
    const commit = vi.fn();
    const host = mount(unpausedEntry(["other"], [], "project"), commit);
    expect(host.textContent).toContain("omp disregards");
    expect(host.textContent).toContain("other");
    await click(button("enable…"));
    await click(button("accept the risk and enable"));
    // The write merges against globalValue ([]), never the disregarded project list.
    expect(commit).toHaveBeenCalledWith(UNPAUSED_PROVIDERS_KEY, [PAUSED.id]);
  });

  it("renders a stored id outside the curated roster, remove-only", async () => {
    const commit = vi.fn();
    const host = mount(unpausedEntry(["future-paused"]), commit);
    expect(host.textContent).toContain("future-paused");
    // The unknown id's own row carries only the pause control.
    const row = [...host.querySelectorAll("div")].find((d) =>
      [...d.children].some((c) => c.textContent === "future-paused"),
    );
    expect(row).toBeDefined();
    expect(
      [...row!.querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent),
    ).toEqual(["pause again"]);
    await click(button("pause again"));
    expect(commit).toHaveBeenCalledWith(UNPAUSED_PROVIDERS_KEY, []);
  });

  it("disables every control while its write is pending", () => {
    mount(unpausedEntry([PAUSED.id]), vi.fn(), UNPAUSED_PROVIDERS_KEY);
    expect(button("pause again").disabled).toBe(true);
  });
});
