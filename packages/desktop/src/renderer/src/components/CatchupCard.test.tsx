// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CatchupDigest } from "../lib/catchup";
import { rpcTabState, tabInfo } from "../test/fixtures";
import { useStore } from "../store";
import { CatchupCard } from "./CatchupCard";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../backend", () => ({
  backend: {
    openPath: vi.fn(async () => {}),
    showPathInFolder: vi.fn(async () => {}),
  },
}));

const TAB = "tab-card";

const digest: CatchupDigest = {
  since: 0,
  awayMs: (2 * 60 + 14) * 60_000,
  turns: [
    { prompt: "ship the thing", outcome: "completed" },
    { prompt: "fix the bug", outcome: "error" },
  ],
  turnsOmitted: 2,
  files: [
    { path: "/a.txt", op: "write" },
    { path: "/b.ts", op: "read" },
  ],
  filesOmitted: 1,
  cost: 1.25,
  tokens: { input: 100, output: 50, cacheRead: 10 },
  advisor: { cost: 0.5, tokens: 1200 },
  lifecycle: ["auto-compaction started", "retry succeeded"],
  lifecycleOmitted: 0,
  pendingPlan: { title: "Ship the plan" },
};

function seed(entry?: { since: number; nonce: number; settled: boolean; digest: CatchupDigest | null }) {
  useStore.setState({
    tabs: [tabInfo({ tabId: TAB })],
    rpc: { [TAB]: rpcTabState({ planDeferred: true }) },
    catchup: entry === undefined ? {} : { [TAB]: entry },
  });
}

function render(): { el: HTMLDivElement; root: Root } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<CatchupCard tabId={TAB} />);
  });
  return { el, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  seed();
});

describe("CatchupCard", () => {
  it("renders nothing without an entry, while pending, or on a null digest", () => {
    seed();
    let { el, root } = render();
    expect(el.innerHTML).toBe("");
    act(() => root.unmount());

    seed({ since: 0, nonce: 1, settled: false, digest: null });
    ({ el, root } = render());
    expect(el.innerHTML).toBe("");
    act(() => root.unmount());

    seed({ since: 0, nonce: 1, settled: true, digest: null });
    ({ el, root } = render());
    expect(el.innerHTML).toBe("");
    act(() => root.unmount());
  });

  it("renders every populated section of a digest", () => {
    seed({ since: 0, nonce: 1, settled: true, digest });
    const { el, root } = render();
    const text = el.textContent ?? "";
    expect(text).toContain("While you were away — 2h 14m");
    expect(text).toContain("2 earlier turns");
    expect(text).toContain("ship the thing");
    expect(text).toContain("fix the bug");
    expect(text).toContain("Plan awaiting review: ");
    expect(text).toContain("Ship the plan");
    expect(text).toContain("W /a.txt");
    expect(text).toContain("R /b.ts");
    expect(text).toContain("+1 more");
    expect(text).toContain("$1.2500");
    expect(text).toContain("160 tok since you left");
    expect(text).toContain("adv $0.5000 · 1.2K tok (session)");
    expect(text).toContain("auto-compaction started · retry succeeded");
    act(() => root.unmount());
  });

  it("omits the sections the digest left empty", () => {
    seed({
      since: 0,
      nonce: 1,
      settled: true,
      digest: {
        ...digest,
        awayMs: 16 * 60_000,
        turns: [{ prompt: "only turn", outcome: "running" }],
        turnsOmitted: 0,
        files: [],
        filesOmitted: 0,
        cost: 0,
        tokens: { input: 0, output: 0, cacheRead: 0 },
        advisor: null,
        lifecycle: [],
        lifecycleOmitted: 0,
        pendingPlan: null,
      },
    });
    const { el, root } = render();
    const text = el.textContent ?? "";
    expect(text).toContain("While you were away — 16m");
    expect(text).toContain("only turn");
    expect(text).not.toContain("since you left");
    expect(text).not.toContain("Plan awaiting review");
    expect(text).not.toContain("more");
    act(() => root.unmount());
  });
  it("dismisses the card in one action", () => {
    seed({ since: 0, nonce: 1, settled: true, digest });
    const { el, root } = render();
    const buttons = [...el.querySelectorAll("button")];
    const dismiss = buttons.find((b) => b.textContent === "✕");
    expect(dismiss).toBeDefined();
    act(() => dismiss!.click());
    expect(useStore.getState().catchup[TAB]).toBeUndefined();
    expect(el.innerHTML).toBe("");
    act(() => root.unmount());
  });

  it("Review plan clears the deferral so the review dock reopens", () => {
    seed({ since: 0, nonce: 1, settled: true, digest });
    const { el, root } = render();
    const buttons = [...el.querySelectorAll("button")];
    const review = buttons.find((b) => b.textContent === "Review plan");
    expect(review).toBeDefined();
    act(() => review!.click());
    expect(useStore.getState().rpc[TAB]?.planDeferred).toBe(false);
    act(() => root.unmount());
  });
});
