// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcTabState } from "../test/fixtures";
import type { LiveSnapshot, LiveTurn } from "@omp-ui/core/live-voice";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });
// Static import cannot work here: store.ts captures window.ompBackend at
// module evaluation, so the seed above must land first — this test
// intentionally exercises that module-loading boundary.
const { useStore } = await import("../store");
const { LiveVoiceStrip } = await import("./LiveVoiceStrip");

const TAB = "tab-strip";
let root: Root | null = null;

const snapshot = (turns: LiveTurn[], patch: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  phase: "listening",
  levels: null,
  turns,
  ended: false,
  error: null,
  connectionId: null,
  ...patch,
});

const seed = (live: LiveSnapshot | null): void => {
  useStore.setState({ rpc: { [TAB]: rpcTabState({ live }) } });
};

const render = (): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<LiveVoiceStrip tabId={TAB} />));
  return host;
};

const rerender = (): void => {
  act(() => root!.render(<LiveVoiceStrip tabId={TAB} />));
};

// jsdom does no layout: scrollHeight/clientHeight are defined per test and
// scrollTop is settable, which is enough to drive the follow machine
// (TranscriptView.test.tsx's idiom).
function scrollBox(el: HTMLElement): HTMLDivElement {
  const box = el.querySelector<HTMLDivElement>(".overflow-y-auto");
  if (!box) throw new Error("scroll box not found");
  return box;
}

function setGeometry(box: HTMLDivElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(box, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(box, "clientHeight", { configurable: true, value: clientHeight });
}

function scrollTo(box: HTMLDivElement, top: number): void {
  box.scrollTop = top;
  act(() => {
    box.dispatchEvent(new Event("scroll"));
  });
}

const turn = (role: "user" | "assistant", n: number, text: string, final = true): LiveTurn => ({
  role,
  turn: n,
  text,
  final,
});

beforeEach(() => {
  // Desktop posture: matchMedia says not-compact, so the strip takes the
  // glass chrome like the composer card (ADR-0026).
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("LiveVoiceStrip (issue #800)", () => {
  it("renders every seeded turn row — the cap is CSS, not a render slice", () => {
    const turns = Array.from({ length: 40 }, (_, i) =>
      turn(i % 2 === 0 ? "user" : "assistant", i, `turn ${i}`),
    );
    seed(snapshot(turns));
    const el = render();
    for (const t of turns) expect(el.textContent).toContain(t.text);
  });

  it("bounds the scroll box and carries the glass background, never a raised panel", () => {
    seed(snapshot([turn("user", 0, "hello")]));
    const el = render();
    const box = scrollBox(el);
    expect(box.className).toContain("overflow-y-auto");
    expect(box.className).toContain("overscroll-contain");
    // ADR-0026: same reading-plane-at-glass-alpha treatment the composer
    // card carries — the strip never invents its own translucency.
    const container = box.parentElement!;
    expect(container.className).toContain("glass-surface");
    expect(container.className).not.toContain("plane-lit");
    expect(container.className).not.toContain("bg-raised");
  });

  it("uses bg-raised in the compact shell, matching the compact composer card", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    seed(snapshot([turn("user", 0, "hello")]));
    const el = render();
    const container = scrollBox(el).parentElement!;
    expect(container.className).toContain("bg-raised");
    expect(container.className).not.toContain("glass-surface");
  });

  it("pins scrollTop to the bottom on a turn update while following", () => {
    seed(snapshot([turn("user", 0, "first")]));
    const el = render();
    const box = scrollBox(el);
    setGeometry(box, 400, 100);
    seed(snapshot([turn("user", 0, "first"), turn("assistant", 0, "reply")]));
    rerender();
    expect(box.scrollTop).toBe(400);
  });

  it("follows a streaming update to the in-flight turn", () => {
    seed(snapshot([turn("user", 0, "question", true), turn("assistant", 0, "par", false)]));
    const el = render();
    const box = scrollBox(el);
    setGeometry(box, 300, 100);
    seed(snapshot([turn("user", 0, "question", true), turn("assistant", 0, "partial repl", false)]));
    rerender();
    expect(box.scrollTop).toBe(300);
  });

  it("leaves the view alone after the user scrolls away, and re-pins on re-entry", () => {
    seed(snapshot([turn("user", 0, "old")]));
    const el = render();
    const box = scrollBox(el);
    setGeometry(box, 400, 100);
    // Scroll far from the tail: 400 - 100 - 100 = 200px of distance > slack.
    scrollTo(box, 100);
    seed(snapshot([turn("user", 0, "old"), turn("assistant", 0, "new")]));
    rerender();
    expect(box.scrollTop).toBe(100);

    // Back within FOLLOW_SLACK (24px) of the tail: the next update re-pins.
    scrollTo(box, 290);
    seed(snapshot([turn("user", 0, "old"), turn("assistant", 0, "newest")]));
    rerender();
    expect(box.scrollTop).toBe(400);
  });

  it("keeps the error row outside the scroll box with its dismiss affordance", () => {
    const clearLiveError = vi.fn();
    seed(snapshot([turn("user", 0, "hello")], { error: "mic gone" }));
    useStore.setState({ clearLiveError });
    const el = render();
    const box = scrollBox(el);
    expect(box.textContent).not.toContain("mic gone");
    const errorRow = el.querySelector(".text-copper");
    if (!errorRow) throw new Error("error row not found");
    expect(box.contains(errorRow)).toBe(false);
    const button = errorRow.querySelector("button");
    if (!button) throw new Error("dismiss button not found");
    act(() => button.click());
    expect(clearLiveError).toHaveBeenCalledWith(TAB);
  });

  it("collapses entirely on a clean end and when there is no snapshot", () => {
    seed(snapshot([turn("user", 0, "hello")], { ended: true, error: null }));
    const el = render();
    expect(el.textContent).toBe("");

    seed(null);
    rerender();
    expect(el.textContent).toBe("");
  });
});

// #809: a final assistant row whose load answers `unavailable` carries a
// disabled speaker glyph naming the constraint — the honest state, never a
// silent hole. In omp ≤ 18.8.6 every reference is unavailable (ADR-0049).
describe("LiveVoiceStrip recording affordance (issue #809)", () => {
  it("marks a final assistant row unavailable after the probe resolves", async () => {
    const loadLiveRecording = vi.fn(async () => ({ status: "unavailable" as const }));
    useStore.setState({ loadLiveRecording });
    seed(snapshot([turn("assistant", 1, "here you go")], { connectionId: "c-1" }));
    const el = render();
    await act(async () => {
      await Promise.resolve();
    });
    const glyph = el.querySelector('[role="img"]');
    expect(glyph?.getAttribute("title")).toContain("output audio");
    expect(glyph?.getAttribute("aria-disabled")).toBe("true");
    // One probe per (connection, turn) — re-render must not re-dispatch.
    rerender();
    expect(loadLiveRecording).toHaveBeenCalledTimes(1);
  });

  it("probes nothing for streaming or user rows", async () => {
    const loadLiveRecording = vi.fn(async () => ({ status: "unavailable" as const }));
    useStore.setState({ loadLiveRecording });
    seed(
      snapshot(
        [turn("user", 0, "hi"), turn("assistant", 1, "…", false)],
        { connectionId: "c-1" },
      ),
    );
    render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadLiveRecording).not.toHaveBeenCalled();
    expect(document.querySelector('[role="img"]')).toBeNull();
  });

  it("renders no glyph when a recording exists", async () => {
    useStore.setState({ loadLiveRecording: vi.fn(async () => ({ status: "ready" as const, wavBase64: "AA" })) });
    seed(snapshot([turn("assistant", 0, "done")], { connectionId: "c-1" }));
    const el = render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector('[role="img"]')).toBeNull();
  });
});

// #810: a ready recording turns the row's affordance into a real control;
// an incomplete take keeps the disabled-glyph shape with its own reason;
// while live output speaks every Play renders disabled with the reason —
// never a silent dead click, never an enabled control without audio.
describe("LiveVoiceStrip replay controls (issue #810)", () => {
  it("shows an enabled Play on a ready row and dispatches the turn target", async () => {
    const playLiveRecording = vi.fn(async (): Promise<void> => {});
    useStore.setState({
      loadLiveRecording: vi.fn(async () => ({ status: "ready" as const, wavBase64: "AA" })),
      playLiveRecording,
    });
    seed(snapshot([turn("assistant", 1, "here you go")], { connectionId: "c-1" }));
    const el = render();
    await act(async () => {
      await Promise.resolve();
    });
    const play = el.querySelector<HTMLButtonElement>('button[aria-label="play recording"]');
    expect(play).not.toBeNull();
    expect(play?.disabled).toBe(false);
    act(() => play!.click());
    expect(playLiveRecording).toHaveBeenCalledWith(TAB, {
      kind: "turn",
      turn: { role: "assistant", turn: 1, text: "here you go", final: true },
    });
  });

  it("a playing clip's row shows Pause wired to the pause verb", async () => {
    const pauseLiveReplay = vi.fn();
    useStore.setState({
      loadLiveRecording: vi.fn(async () => ({ status: "ready" as const, wavBase64: "AA" })),
      pauseLiveReplay,
      liveReplay: {
        key: `${TAB}:c-1:1`,
        tabId: TAB,
        ref: "v1/s/c/assistant/1",
        status: "playing",
        notice: null,
      },
    });
    seed(snapshot([turn("assistant", 1, "here you go")], { connectionId: "c-1" }));
    const el = render();
    await act(async () => {
      await Promise.resolve();
    });
    const pause = el.querySelector<HTMLButtonElement>('button[aria-label="pause recording"]');
    expect(pause).not.toBeNull();
    act(() => pause!.click());
    expect(pauseLiveReplay).toHaveBeenCalled();
  });

  it("an incomplete take renders the disabled glyph with its own reason", async () => {
    useStore.setState({
      loadLiveRecording: vi.fn(async () => ({ status: "incomplete" as const })),
    });
    seed(snapshot([turn("assistant", 2, "partial")], { connectionId: "c-1" }));
    const el = render();
    await act(async () => {
      await Promise.resolve();
    });
    const glyph = el.querySelector('[role="img"]');
    expect(glyph?.getAttribute("title")).toContain("incomplete");
    expect(glyph?.getAttribute("aria-disabled")).toBe("true");
    expect(el.querySelector("button")).toBeNull();
  });

  it("phase speaking renders Play disabled with the busy reason", async () => {
    useStore.setState({
      loadLiveRecording: vi.fn(async () => ({ status: "ready" as const, wavBase64: "AA" })),
      liveReplay: null,
    });
    seed(snapshot([turn("assistant", 3, "done")], { connectionId: "c-1", phase: "speaking" }));
    const el = render();
    await act(async () => {
      await Promise.resolve();
    });
    const busy = el.querySelector<HTMLButtonElement>(
      'button[aria-label="live voice is speaking — replay waits"]',
    );
    expect(busy).not.toBeNull();
    expect(busy?.disabled).toBe(true);
  });

  it("a guard-paused row shows Resume, not a fresh play", async () => {
    const resumeLiveReplay = vi.fn();
    useStore.setState({
      loadLiveRecording: vi.fn(async () => ({ status: "ready" as const, wavBase64: "AA" })),
      resumeLiveReplay,
      liveReplay: {
        key: `${TAB}:c-1:1`,
        tabId: TAB,
        ref: "v1/s/c/assistant/1",
        status: "paused",
        notice: "live-speaking",
      },
    });
    seed(snapshot([turn("assistant", 1, "here you go")], { connectionId: "c-1" }));
    const el = render();
    await act(async () => {
      await Promise.resolve();
    });
    const play = el.querySelector<HTMLButtonElement>('button[aria-label="play recording"]');
    expect(play).not.toBeNull();
    expect(play?.disabled).toBe(false);
    act(() => play!.click());
    expect(resumeLiveReplay).toHaveBeenCalled();
  });
});
