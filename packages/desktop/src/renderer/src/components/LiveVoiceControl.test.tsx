// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcTabState } from "../test/fixtures";
import type { LiveSnapshot } from "@omp-ui/core/live-voice";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });
// Static import cannot work here: store.ts captures window.ompBackend at
// module evaluation, so the seed above must land first — this test
// intentionally exercises that module-loading boundary.
const { useStore } = await import("../store");
const { LiveVoiceControl } = await import("./LiveVoiceControl");

const TAB = "tab-live";
const startLiveVoice = vi.fn(async () => {});
const stopLiveVoice = vi.fn(async () => {});
const setLiveMuted = vi.fn(async () => {});
let root: Root | null = null;

/** Seeds the live snapshot the control reads; the gate is the callsite's job. */
const seed = (live: LiveSnapshot | null): void => {
  useStore.setState({
    rpc: { [TAB]: rpcTabState({ live }) },
    startLiveVoice,
    stopLiveVoice,
    setLiveMuted,
  });
};

const render = (layout?: "inline" | "sheet", disabled = false): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<LiveVoiceControl tabId={TAB} layout={layout} disabled={disabled} />));
  return host;
};

const button = (label: string): HTMLButtonElement | null =>
  [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  ) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("LiveVoiceControl (issue #778)", () => {
  it("idle renders the live capsule and a click starts", () => {
    seed(null);
    const host = render();
    expect(host.textContent).toContain("live");
    expect(document.querySelector("button")).not.toBeNull();
    act(() => button("start live voice")!.click());
    expect(startLiveVoice).toHaveBeenCalledWith(TAB);
    expect(stopLiveVoice).not.toHaveBeenCalled();
  });

  it("active renders the phase and a click on it stops", () => {
    seed({ phase: "listening", levels: null, turns: [], ended: false, error: null });
    const host = render();
    expect(host.textContent).toContain("listening");
    act(() => button("stop live voice")!.click());
    expect(stopLiveVoice).toHaveBeenCalledWith(TAB);
    expect(startLiveVoice).not.toHaveBeenCalled();
  });

  it("active renders the mute toggle and it sends the opposite", () => {
    seed({ phase: "listening", levels: null, turns: [], ended: false, error: null });
    render();
    act(() => button("mute live voice")!.click());
    expect(setLiveMuted).toHaveBeenCalledWith(TAB, true);

    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          live: { phase: "muted", levels: null, turns: [], ended: false, error: null },
        }),
      },
    });
    act(() => root!.render(<LiveVoiceControl tabId={TAB} />));
    act(() => button("unmute live voice")!.click());
    expect(setLiveMuted).toHaveBeenCalledWith(TAB, false);
  });

  it("meters render only while levels are known", () => {
    seed({ phase: "speaking", levels: { input: 0.5, output: 0.2 }, turns: [], ended: false, error: null });
    const host = render();
    // One Meter per channel: the overflow-hidden bg-line track.
    const tracks = () => host.querySelectorAll('[class*="overflow-hidden"]');
    expect(tracks().length).toBe(2);
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          live: { phase: "speaking", levels: null, turns: [], ended: false, error: null },
        }),
      },
    });
    act(() => root!.render(<LiveVoiceControl tabId={TAB} />));
    expect(tracks().length).toBe(0);
  });

  it("a session error shows in the idle capsule and starts remain available", () => {
    seed({ phase: "listening", levels: null, turns: [], ended: true, error: "stream dropped" });
    const host = render();
    expect(host.textContent).toContain("live");
    act(() => button("start live voice")!.click());
    expect(startLiveVoice).toHaveBeenCalledWith(TAB);
  });

  it("the sheet row renders a switch labelled by state", () => {
    seed({ phase: "working", levels: null, turns: [], ended: false, error: null });
    const host = render("sheet");
    expect(host.textContent).toContain("working");
    const switchButton = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("role") === "switch" || b.textContent === "",
    );
    expect(switchButton).not.toBeNull();
  });

  it("disables both faces when the callsite marks the session unavailable", () => {
    seed({ phase: "listening", levels: null, turns: [], ended: false, error: null });
    render(undefined, true);
    for (const b of document.querySelectorAll("button"))
      expect(b.disabled, b.getAttribute("aria-label") ?? "").toBe(true);
  });

  it("the component itself never gates: it renders even without a version", () => {
    // Callsites gate on supportsNativeLive; given props the control renders
    // in both states regardless.
    seed(null);
    const host = render();
    expect(host.textContent).toContain("live");
  });
});
