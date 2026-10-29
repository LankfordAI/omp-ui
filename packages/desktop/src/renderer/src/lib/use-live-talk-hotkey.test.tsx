// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcTabState } from "../test/fixtures";
import type { LiveSnapshot } from "@omp-ui/core/live-voice";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });
// store.ts captures window.ompBackend at module evaluation; seed first.
const { useStore } = await import("../store");
const { useLiveTalkHotkey } = await import("./use-live-talk-hotkey");

const TAB = "tab-live";
const setLiveTalking = vi.fn(async () => {});
let root: Root | null = null;

const OPEN: LiveSnapshot = { phase: "muted", levels: null, turns: [], ended: false, error: null, connectionId: null };

const seed = (live: LiveSnapshot | null = OPEN): void => {
  useStore.setState({
    activeTabId: TAB,
    rpc: { [TAB]: rpcTabState({ live }) },
    liveVoice: { [TAB]: { armed: true, parked: false, pending: false, talking: false } },
    setLiveTalking,
  });
};

function Probe({ viewed }: { viewed: boolean }) {
  useLiveTalkHotkey(TAB, viewed);
  return null;
}

const mount = (viewed = true): void => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe viewed={viewed} />));
};

const press = (type: "keydown" | "keyup", init: KeyboardEventInit = {}, target: EventTarget = window): void => {
  act(() => { target.dispatchEvent(new KeyboardEvent(type, { key: "r", bubbles: true, ...init })); });
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("useLiveTalkHotkey (ADR-0070)", () => {
  it("R down talks and keyup releases", () => {
    seed();
    mount();
    press("keydown");
    expect(setLiveTalking).toHaveBeenLastCalledWith(TAB, true);
    press("keyup");
    expect(setLiveTalking).toHaveBeenLastCalledWith(TAB, false);
    expect(setLiveTalking).toHaveBeenCalledTimes(2);
  });

  it("ignores an auto-repeat keydown", () => {
    seed();
    mount();
    press("keydown", { repeat: true });
    expect(setLiveTalking).not.toHaveBeenCalled();
    press("keydown");
    press("keydown", { repeat: true });
    expect(setLiveTalking).toHaveBeenCalledTimes(1);
  });

  it("ignores R typed in a textarea", () => {
    seed();
    mount();
    const area = document.createElement("textarea");
    document.body.append(area);
    press("keydown", {}, area);
    expect(setLiveTalking).not.toHaveBeenCalled();
  });

  it("window blur while held releases", () => {
    seed();
    mount();
    press("keydown");
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(setLiveTalking).toHaveBeenLastCalledWith(TAB, false);
    expect(setLiveTalking).toHaveBeenCalledTimes(2);
  });

  it("unmount while held releases", () => {
    seed();
    mount();
    press("keydown");
    act(() => root!.unmount());
    root = null;
    expect(setLiveTalking).toHaveBeenLastCalledWith(TAB, false);
    expect(setLiveTalking).toHaveBeenCalledTimes(2);
  });

  it("does nothing while the tab is unviewed", () => {
    seed();
    mount(false);
    press("keydown");
    press("keyup");
    expect(setLiveTalking).not.toHaveBeenCalled();
  });

  it("does nothing once the snapshot has ended", () => {
    seed({ ...OPEN, ended: true });
    mount();
    press("keydown");
    press("keyup");
    expect(setLiveTalking).not.toHaveBeenCalled();
  });
});
