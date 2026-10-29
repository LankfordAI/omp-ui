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
const setLiveTalking = vi.fn(async () => {});
let root: Root | null = null;

/** Seeds the live snapshot the control reads; the gate is the callsite's job. */
const seed = (live: LiveSnapshot | null): void => {
  useStore.setState({
    rpc: { [TAB]: rpcTabState({ live }) },
    liveVoice: {},
    startLiveVoice,
    stopLiveVoice,
    setLiveTalking,
  });
};

const render = (layout?: "inline" | "sheet", disabled = false, startDisabled = false): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<LiveVoiceControl tabId={TAB} layout={layout} disabled={disabled} startDisabled={startDisabled} />));
  return host;
};

const button = (label: string): HTMLButtonElement | null =>
  [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  ) ?? null;

const LISTENING: LiveSnapshot = { phase: "listening", levels: null, turns: [], ended: false, error: null, connectionId: null };

/** jsdom has no PointerEvent; React's pointer handlers read button/pointerId off a MouseEvent. */
const pointer = (el: Element, type: "pointerdown" | "pointerup"): void => {
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 })); });
};

const key = (el: Element, type: "keydown" | "keyup", k: string): void => {
  act(() => { el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: k })); });
};

beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.setPointerCapture = vi.fn();
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
    seed({ phase: "listening", levels: null, turns: [], ended: false, error: null, connectionId: null });
    const host = render();
    expect(host.textContent).toContain("listening");
    act(() => button("stop live voice")!.click());
    expect(stopLiveVoice).toHaveBeenCalledWith(TAB);
    expect(startLiveVoice).not.toHaveBeenCalled();
  });

  it("pointer down on the talk button talks and pointer up releases", () => {
    seed(LISTENING);
    render();
    const talk = button("hold to talk")!;
    pointer(talk, "pointerdown");
    expect(setLiveTalking).toHaveBeenLastCalledWith(TAB, true);
    pointer(talk, "pointerup");
    expect(setLiveTalking).toHaveBeenLastCalledWith(TAB, false);
  });

  it("Space keydown talks and keyup releases", () => {
    seed(LISTENING);
    render();
    const talk = button("hold to talk")!;
    key(talk, "keydown", " ");
    expect(setLiveTalking).toHaveBeenLastCalledWith(TAB, true);
    key(talk, "keyup", " ");
    expect(setLiveTalking).toHaveBeenLastCalledWith(TAB, false);
    expect(setLiveTalking).toHaveBeenCalledTimes(2);
  });

  it("aria-pressed follows the talking badge", () => {
    seed(LISTENING);
    render();
    expect(button("hold to talk")!.getAttribute("aria-pressed")).toBe("false");
    act(() => useStore.setState({ liveVoice: { [TAB]: { armed: true, parked: false, pending: false, talking: true } } }));
    expect(button("hold to talk")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("a muted, quiet, idle call renders hold R to talk", () => {
    seed({ phase: "muted", levels: { input: 0, output: 0 }, turns: [], ended: false, error: null, connectionId: null });
    const host = render();
    expect(host.textContent).toContain("hold R to talk");
  });

  it("keeps accessible stop and talk controls available across level updates", () => {
    seed({ phase: "speaking", levels: { input: 0.5, output: 0.2 }, turns: [], ended: false, error: null, connectionId: null });
    render();
    expect(button("stop live voice")?.disabled).toBe(false);
    expect(button("hold to talk")?.disabled).toBe(false);
    act(() => useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          live: { phase: "speaking", levels: null, turns: [], ended: false, error: null, connectionId: null },
        }),
      },
    }));
    expect(button("stop live voice")?.disabled).toBe(false);
    expect(button("hold to talk")?.disabled).toBe(false);
  });

  it("a session error shows in the idle capsule and starts remain available", () => {
    seed({ phase: "listening", levels: null, turns: [], ended: true, error: "stream dropped", connectionId: null });
    const host = render();
    expect(host.textContent).toContain("live");
    act(() => button("start live voice")!.click());
    expect(startLiveVoice).toHaveBeenCalledWith(TAB);
  });

  it("the sheet row renders a switch labelled by state", () => {
    seed({ phase: "working", levels: null, turns: [], ended: false, error: null, connectionId: null });
    const host = render("sheet");
    expect(host.textContent).toContain("working");
    const switchButton = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("role") === "switch" || b.textContent === "",
    );
    expect(switchButton).not.toBeNull();
  });

  it("disables both faces when the callsite marks the session unavailable", () => {
    seed({ phase: "listening", levels: null, turns: [], ended: false, error: null, connectionId: null });
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

  it.each(["inline", "sheet"] as const)("blocks only a new start in %s layout", (layout) => {
    seed(null);
    render(layout, false, true);
    const start = button("start live voice")!;
    expect(start.disabled).toBe(true);
    act(() => start.click());
    expect(startLiveVoice).not.toHaveBeenCalled();
  });

  it("allows talk and stop while preparation disables new starts", () => {
    seed(LISTENING);
    render(undefined, false, true);
    const talk = button("hold to talk")!;
    expect(talk.disabled).toBe(false);
    pointer(talk, "pointerdown");
    expect(setLiveTalking).toHaveBeenLastCalledWith(TAB, true);
    pointer(talk, "pointerup");
    expect(setLiveTalking).toHaveBeenLastCalledWith(TAB, false);
    act(() => button("stop live voice")!.click());
    expect(stopLiveVoice).toHaveBeenCalledWith(TAB);
    expect(startLiveVoice).not.toHaveBeenCalled();
  });

  it.each(["inline", "sheet"] as const)("keeps parked cancellation available in %s layout", (layout) => {
    seed(null);
    useStore.setState({ liveVoice: { [TAB]: { armed: true, parked: true, pending: false, talking: false } } });
    render(layout, false, true);
    const cancel = layout === "sheet" ? button("start live voice")! : button("stop live voice")!;
    expect(cancel.disabled).toBe(false);
    act(() => cancel.click());
    expect(stopLiveVoice).toHaveBeenCalledWith(TAB);
    expect(startLiveVoice).not.toHaveBeenCalled();
  });
});
