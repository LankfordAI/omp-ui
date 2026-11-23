// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPickerRow } from "@omp-ui/core/host-controls";
import { remoteOwnedState, rpcTabState } from "../test/fixtures";
import type { RpcTabState } from "../store";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.assign(window, { ompBackend: {} });
// Dynamic import: store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { HostModelPicker, HostModelPickerRow } = await import("./HostModelPicker");
const { HostRunControls } = await import("./HostRunControls");

const TAB = "host-controls-tab";
const INSTANCE = "inst-remote";
const LOCAL_TAB = "local-tab";

const withVersion = (ompVersion: string | null): CapabilitySnapshot =>
  ({ ompVersion }) as unknown as CapabilitySnapshot;

const modelRow: ModelPickerRow = {
  provider: "anthropic",
  id: "opus-5",
  name: "Opus 5",
  thinking: ["low", "medium", "high"],
  thinkingLevel: "high",
};
const roleRow: ModelPickerRow = {
  provider: "gate",
  id: "gaterati",
  name: "Gaterati",
  role: "advisor",
  thinkingLevel: "low",
};
const heldRow: ModelPickerRow = {
  provider: "openai",
  id: "gpt-6",
  name: "GPT-6",
  roles: [{ role: "default", label: "Default" }],
  overContext: true,
  current: true,
};

const real = {
  openHostModelPicker: useStore.getState().openHostModelPicker,
  closeHostModelPicker: useStore.getState().closeHostModelPicker,
  queryModelPicker: useStore.getState().queryModelPicker,
  pickModelRow: useStore.getState().pickModelRow,
  continueRun: useStore.getState().continueRun,
  deliverQueue: useStore.getState().deliverQueue,
};

beforeEach(() => {
  useStore.setState({ state: remoteOwnedState(TAB, INSTANCE) });
});

afterEach(() => {
  for (const [key, fn] of Object.entries(real)) {
    (useStore.setState as (patch: object) => void)({
      [key]: fn,
    });
  }
});

let root: Root | null = null;

function mount(node: ReactNode): void {
  if (root !== null) act(() => root!.unmount());
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

function setTab(patch: Partial<RpcTabState> = {}): void {
  useStore.setState({ rpc: { [TAB]: rpcTabState({ capabilities: withVersion("19.1.0"), ...patch }) } });
}

const buttons = (): HTMLButtonElement[] =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")];
const click = (el: Element | undefined): void => {
  expect(el).toBeDefined();
  act(() => (el as HTMLButtonElement).click());
};
const byText = (text: string): HTMLButtonElement[] =>
  buttons().filter((b) => (b.textContent ?? "").includes(text));

describe("HostModelPicker dialog", () => {
  it("renders nothing while no picker is open", () => {
    setTab();
    mount(<HostModelPicker tabId={TAB} />);
    expect(document.body.querySelector("input")).toBeNull();
  });

  it("paints rows in host order with role chips, the recent caption, and the current dot", () => {
    setTab({
      modelPicker: { query: "", rows: [roleRow, modelRow, heldRow], recent: 2, total: 41, loading: false, error: null },
    });
    mount(<HostModelPicker tabId={TAB} />);
    expect(document.body.textContent).toContain("@ Gaterati");
    expect(document.body.textContent).toContain("switches the advisor role");
    expect(document.body.textContent).toContain("recent");
    expect(document.body.textContent).toContain("over context");
    // The count admits the host holds more rows than it sent.
    expect(document.body.textContent).toContain("3/41");
    // Only the `current` row carries the in-use dot.
    expect(document.body.querySelectorAll('[title="this session runs it"]')).toHaveLength(1);
  });

  it("typing re-queries the host instead of filtering locally", () => {
    const queryModelPicker = vi.fn();
    useStore.setState({ queryModelPicker });
    setTab({ modelPicker: { query: "", rows: [modelRow], recent: 0, total: 1, loading: false, error: null } });
    mount(<HostModelPicker tabId={TAB} />);
    const input = document.body.querySelector("input") as HTMLInputElement;
    act(() => {
      // React's controlled-input contract: set the value through the setter.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "anthropic/");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(queryModelPicker).toHaveBeenCalledWith(TAB, "anthropic/");
  });

  it("a row click switches the model with no level; a thinking chip names its step", async () => {
    const pickModelRow = vi.fn(async () => true);
    useStore.setState({ pickModelRow });
    setTab({ modelPicker: { query: "", rows: [modelRow], recent: 0, total: 1, loading: false, error: null } });
    mount(<HostModelPicker tabId={TAB} />);
    click(byText("Opus 5")[0]);
    expect(pickModelRow).toHaveBeenLastCalledWith(TAB, modelRow, undefined);
    click(byText("medium")[0]);
    expect(pickModelRow).toHaveBeenLastCalledWith(TAB, modelRow, "medium");
    // The chip's pick must not also fire the row's own switch.
    expect(pickModelRow).toHaveBeenCalledTimes(2);
  });

  it("shows the host's refusal line and keeps browsing visible", () => {
    setTab({
      modelPicker: { query: "", rows: [], recent: 0, total: 0, loading: false, error: "this omp has no remote host controls — update omp to 19.1.0 or later" },
    });
    mount(<HostModelPicker tabId={TAB} />);
    expect(document.body.textContent).toContain("update omp to 19.1.0");
  });
});

describe("HostModelPickerRow", () => {
  it("never appears on a local tab, however new its omp", () => {
    useStore.setState({ state: null });
    setTab();
    mount(<HostModelPickerRow tabId={LOCAL_TAB} instanceId={null} />);
    expect(document.body.textContent).toBe("");
  });

  it("appears on a joined remote tab at 19.1 and opens the picker", () => {
    const openHostModelPicker = vi.fn();
    useStore.setState({ openHostModelPicker });
    setTab();
    mount(<HostModelPickerRow tabId={TAB} instanceId={INSTANCE} />);
    click(byText("host model picker")[0]);
    expect(openHostModelPicker).toHaveBeenCalledWith(TAB);
  });

  it("stays hidden on an omp older than 19.1 — the send would only be refused", () => {
    setTab({ capabilities: withVersion("19.0.1") });
    mount(<HostModelPickerRow tabId={TAB} instanceId={INSTANCE} />);
    expect(document.body.textContent).toBe("");
  });

  it("stays visible but disabled with the upgrade hint once a verb refused", () => {
    setTab({ capabilities: withVersion("19.0.1"), hostControlsUnsupported: true });
    mount(<HostModelPickerRow tabId={TAB} instanceId={INSTANCE} />);
    const button = byText("host model picker")[0];
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("update omp to 19.1.0");
  });
});

describe("HostRunControls", () => {
  const queued = { ...emptySessionRuntime(), queuedMessageCount: 2 };

  it("offers continue on an idle remote session and fires it", () => {
    const continueRun = vi.fn(async () => true);
    useStore.setState({ continueRun });
    setTab({ status: "ready" });
    mount(<HostRunControls tabId={TAB} disabled={false} />);
    click(byText("continue")[0]);
    expect(continueRun).toHaveBeenCalledWith(TAB);
    expect(byText("deliver queue")).toHaveLength(0);
  });

  it("swaps continue for deliver-queue while a turn streams with input queued", () => {
    const deliverQueue = vi.fn(async () => true);
    useStore.setState({ deliverQueue });
    setTab({ status: "running", session: queued });
    mount(<HostRunControls tabId={TAB} disabled={false} />);
    expect(byText("continue")).toHaveLength(0);
    click(byText("deliver queue")[0]);
    expect(deliverQueue).toHaveBeenCalledWith(TAB);
  });

  it("shows neither on a streaming turn with nothing queued — Stop owns that", () => {
    setTab({ status: "running" });
    mount(<HostRunControls tabId={TAB} disabled={false} />);
    expect(byText("continue")).toHaveLength(0);
    expect(byText("deliver queue")).toHaveLength(0);
  });

  it("keeps continue available while the run waits on background work", () => {
    setTab({ status: "running", awaitingAsyncWork: true });
    mount(<HostRunControls tabId={TAB} disabled={false} />);
    expect(byText("continue")).toHaveLength(1);
  });

  it("sends nothing when the gate is closed, and nothing further once latched", () => {
    const continueRun = vi.fn(async () => false);
    useStore.setState({ continueRun });
    setTab({ status: "ready", capabilities: withVersion("19.0.1") });
    mount(<HostRunControls tabId={TAB} disabled={false} />);
    expect(document.body.textContent).toBe("");

    setTab({ status: "ready", capabilities: withVersion("19.0.1"), hostControlsUnsupported: true });
    mount(<HostRunControls tabId={TAB} disabled={false} />);
    const button = byText("continue")[0];
    expect(button.disabled).toBe(true);
    click(button);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("renders nothing on a local tab", () => {
    useStore.setState({ state: null });
    setTab({ status: "ready" });
    mount(<HostRunControls tabId={LOCAL_TAB} disabled={false} />);
    expect(document.body.textContent).toBe("");
  });
});
