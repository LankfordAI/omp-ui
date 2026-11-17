// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { AGENT_PREWALK_AUTO_KEY } from "@omp-ui/core/omp-settings-keys";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
Object.assign(window, { ompBackend: {} });
const { useStore } = await import("../../store");
const { AgentPrewalkAutoSection } = await import("./AgentPrewalkAutoSection");

function prewalkEntry(
  value: OmpSettingValue,
  globalValue: OmpSettingValue = value,
  layer: OmpSettingEntry["layer"] = "global",
): OmpSettingEntry {
  return {
    key: AGENT_PREWALK_AUTO_KEY,
    type: "record",
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
  act(() => root!.render(<AgentPrewalkAutoSection entry={entry} pendingKey={pendingKey} commit={commit} />));
  return host;
}

function field(agent: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(
    `input[aria-label="prewalk entry for ${agent}"]`,
  );
  if (found === null) throw new Error(`${agent} field not found`);
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

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ state: backendState({ agentRoster: ["scout", "task"] }) });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("AgentPrewalkAutoSection (issue #1206)", () => {
  it("renders nothing when the snapshot has no entry", () => {
    const host = mount(undefined);
    expect(host.textContent).toBe("");
  });

  it("spreads the whole global record on an agent edit, keeping sibling keys", async () => {
    const commit = vi.fn();
    mount(prewalkEntry({ reviewer: "on" }, { reviewer: "on" }), commit);
    const scout = field("scout");
    await typeInto(scout, "@smol");
    await pressEnter(scout);
    // REPLACE-not-merge (ADR-0031): the write carries the untouched sibling.
    expect(commit).toHaveBeenCalledWith(AGENT_PREWALK_AUTO_KEY, {
      reviewer: "on",
      scout: "@smol",
    });
  });

  it("removes an agent's key on an empty draft and never bakes a project value into the write", async () => {
    const commit = vi.fn();
    // Effective carries a project-only entry; the global record does not have it.
    mount(
      prewalkEntry({ reviewer: "on", scout: "off" }, { reviewer: "on" }, "project"),
      commit,
    );
    await typeInto(field("reviewer"), "");
    await pressEnter(field("reviewer"));
    expect(commit).toHaveBeenCalledWith(AGENT_PREWALK_AUTO_KEY, {});
  });

  it("renders stored keys for agents off the roster and commits against them too", async () => {
    const commit = vi.fn();
    const host = mount(prewalkEntry({ retired: "on" }), commit);
    expect(host.textContent).toContain("retired");
    await typeInto(field("retired"), "off");
    await pressEnter(field("retired"));
    expect(commit).toHaveBeenCalledWith(AGENT_PREWALK_AUTO_KEY, { retired: "off" });
  });

  it("commits nothing when the draft is unchanged", async () => {
    const commit = vi.fn();
    mount(prewalkEntry({ scout: "on" }), commit);
    await typeInto(field("scout"), "on");
    await pressEnter(field("scout"));
    expect(commit).not.toHaveBeenCalled();
  });

  it("disables every field while its write is pending", () => {
    mount(prewalkEntry({ scout: "on" }), vi.fn(), AGENT_PREWALK_AUTO_KEY);
    expect(field("scout").disabled).toBe(true);
  });
});
