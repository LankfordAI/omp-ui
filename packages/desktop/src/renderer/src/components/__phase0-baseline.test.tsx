// THROWAWAY Phase 0 baseline harness (performance plan). NOT committed;
// deleted in Phase 5. Measures the synchronous scripting cost of a transcript
// commit in jsdom: React reconcile + the per-commit rollups
// (summarizeExchanges, anchors, presentArtifacts) over a 4,000-item history
// with large diff cards. jsdom excludes layout/paint; it isolates exactly the
// JavaScript the plan's Phase 1/2 target. Run:
//   npx vitest run src/renderer/src/components/__phase0-baseline.test.tsx
// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
// React 19 moved flushSync off react-dom/client.
import { flushSync } from "react-dom";
import { historyToItems, type RenderItem } from "../lib/transcript";
import { summarizeExchanges } from "../lib/exchange-changes";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
vi.mock("../backend", () => ({
  backend: {
    openPath: vi.fn(async () => {}),
    showPathInFolder: vi.fn(async () => {}),
  },
}));

import { TranscriptView } from "./TranscriptView";

/** A user prompt + an assistant reply + N large-diff tool cards. */
function exchange(userText: string, diffCards: number, rows: number): RenderItem[] {
  const out: RenderItem[] = [
    { kind: "user", id: `u-${userText}`, text: userText },
    {
      kind: "assistant",
      id: `a-${userText}`,
      text: "Working on it.",
      thinking: "",
      narration: "",
      streaming: false,
    },
  ];
  for (let c = 0; c < diffCards; c += 1) {
    out.push({
      kind: "tool",
      id: `t-${userText}-${c}`,
      toolCallId: `tc-${userText}-${c}`,
      name: "edit",
      args: { path: `/repo/src/file${c}.ts` },
      status: "done",
      resultText: "ok",
      path: `/repo/src/file${c}.ts`,
      op: "update",
      diff: Array.from({ length: rows }, (_, i) =>
        i % 2 === 0
          ? { kind: "add" as const, text: `+added line ${i} ${"x".repeat(60)}` }
          : { kind: "del" as const, text: `-removed line ${i} ${"y".repeat(60)}` },
      ),
    });
  }
  return out;
}

describe("phase0 baseline", () => {
  beforeAll(() => {
    // Silence the store's backend subscriptions in this scratch file.
    document.body.innerHTML = "";
  });

  it("per-commit cost at 4,000 items with large diff cards", async () => {
    // ~285 exchanges * 14 items ≈ 4,000; each exchange carries 2 cards of
    // 200 diff rows → 285*2*200 = 114k diff rows in history.
    const items: RenderItem[] = [];
    let ex = 0;
    while (items.length < 4000) {
      items.push(...exchange(`prompt ${ex}`, 2, 200));
      ex += 1;
    }
    log(`items=${items.length} diffRows≈${ex * 2 * 200}`);

    const host = document.createElement("div");
    Object.assign(host.style, { position: "absolute", inset: "0" });
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<TranscriptView items={items} tabId="t0" />);
    });

    const time = (label: string, f: () => void, reps: number): number[] => {
      const marks: number[] = [];
      for (let i = 0; i < reps; i += 1) {
        const t0 = performance.now();
        f();
        marks.push(performance.now() - t0);
      }
      marks.sort((a, b) => a - b);
      const p50 = marks[Math.floor(marks.length / 2)];
      const p95 = marks[Math.floor(marks.length * 0.95)] ?? marks.at(-1)!;
      log(`${label}: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
      return marks;
    };

    // Unchanged-items re-render (one "stream commit" worth of reconcile).
    time("unchanged re-render (flushSync)", () => {
      flushSync(() => root.render(<TranscriptView items={items} tabId="t0" />));
    }, 12);

    // A streaming assistant tail, mutated per tick like a real delta batch.
    const tail: RenderItem = {
      kind: "assistant",
      id: "tail",
      text: "",
      thinking: "",
      narration: "",
      streaming: true,
    };
    const streamingItems = [...items, tail];
    await act(async () => {
      root.render(<TranscriptView items={streamingItems} tabId="t0" />);
    });
    let tick = 0;
    time("tail-text delta re-render", () => {
      const mutated = [...streamingItems];
      mutated[mutated.length - 1] = { ...tail, text: "x".repeat(++tick) };
      flushSync(() => root.render(<TranscriptView items={mutated} tabId="t0" />));
    }, 12);
    host.style.display = "none";
    time("tail-text delta re-render (display:none)", () => {
      const mutated = [...streamingItems];
      mutated[mutated.length - 1] = { ...tail, text: "x".repeat(++tick) };
      flushSync(() => root.render(<TranscriptView items={mutated} tabId="t0" />));
    }, 8);
    host.style.display = "";

    // The rollups alone, isolated from React.
    time("summarizeExchanges only", () => {
      summarizeExchanges(streamingItems);
    }, 12);

    // display:none subtree (hidden tab): commits still reconcile.
    host.style.display = "none";
    time("unchanged re-render (display:none)", () => {
      flushSync(() => root.render(<TranscriptView items={items} tabId="t0" />));
    }, 8);
    host.style.display = "";

    await act(async () => root.unmount());
    expect(items.length).toBeGreaterThan(3900);
  }, 120_000);
});

function log(msg: string): void {
  process.stdout.write(`[phase0] ${msg}\n`);
}
