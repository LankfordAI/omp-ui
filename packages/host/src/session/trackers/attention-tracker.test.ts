import { CH, type Attention } from "@omp-ui/core";
import { describe, expect, it } from "vitest";
import { AttentionTracker } from "./attention-tracker";

const TAB = "tab-att";

function setup(opts: { pty?: boolean } = {}) {
  const sent: Array<[string, Attention | null]> = [];
  let clock = 1_000;
  const tracker = new AttentionTracker({
    send: (channel, ...args) => {
      expect(channel).toBe(CH.onAttentionChanged);
      sent.push([args[0] as string, args[1] as Attention | null]);
    },
    now: () => clock,
    isPty: () => opts.pty === true,
  });
  return { tracker, sent, tick: (ms: number) => { clock += ms; } };
}

describe("AttentionTracker", () => {
  it("a finished turn sets turn-complete and a new turn clears it", () => {
    const { tracker, sent } = setup();
    tracker.turnEnded(TAB);
    expect(tracker.level(TAB)).toEqual({ kind: "turn-complete", planTitle: null, atMs: 1_000 });
    tracker.turnStarted(TAB);
    expect(tracker.level(TAB)).toBeNull();
    expect(sent).toEqual([
      [TAB, { kind: "turn-complete", planTitle: null, atMs: 1_000 }],
      [TAB, null],
    ]);
  });

  it("a pending plan gate outranks a finished turn until it settles", () => {
    const { tracker, sent } = setup();
    tracker.planProposed(TAB, "add auth");
    tracker.turnEnded(TAB);
    expect(tracker.level(TAB)).toMatchObject({ kind: "plan-pending", planTitle: "add auth" });
    expect(sent).toHaveLength(1);

    tracker.planSettled(TAB);
    expect(tracker.level(TAB)).toBeNull();
    // Settling a gate that is not pending changes nothing.
    tracker.turnEnded(TAB);
    tracker.planSettled(TAB);
    expect(tracker.level(TAB)).toMatchObject({ kind: "turn-complete" });
  });

  it("stallPaused(false) clears only a stall-paused level", () => {
    const { tracker } = setup();
    tracker.stallPaused(TAB, true);
    expect(tracker.level(TAB)).toMatchObject({ kind: "stall-paused" });
    tracker.stallPaused(TAB, false);
    expect(tracker.level(TAB)).toBeNull();

    tracker.turnEnded(TAB);
    tracker.stallPaused(TAB, false);
    expect(tracker.level(TAB)).toMatchObject({ kind: "turn-complete" });
  });

  it("atMs is strictly monotonic per tab even when the clock stands still or runs backwards", () => {
    const { tracker, tick } = setup();
    tracker.turnEnded(TAB);
    const first = tracker.level(TAB)!.atMs;
    tracker.planProposed(TAB, "a");
    const second = tracker.level(TAB)!.atMs;
    expect(second).toBe(first + 1);
    tick(-500);
    tracker.planProposed(TAB, "b");
    expect(tracker.level(TAB)!.atMs).toBe(second + 1);
    tick(10_000);
    tracker.planProposed(TAB, "c");
    expect(tracker.level(TAB)!.atMs).toBe(10_500);
  });

  it("emits nothing for a no-op transition", () => {
    const { tracker, sent } = setup();
    tracker.turnStarted(TAB);
    tracker.sessionExit(TAB);
    tracker.planSettled(TAB);
    tracker.stallPaused(TAB, false);
    expect(sent).toEqual([]);

    tracker.planProposed(TAB, "same");
    tracker.planProposed(TAB, "same");
    tracker.turnEnded("other");
    tracker.turnEnded("other");
    expect(sent).toHaveLength(2);
    // A different title on the same kind is a real change.
    tracker.planProposed(TAB, "revised");
    expect(sent).toHaveLength(3);
  });

  it("sessionExit, onExit, and dispose clear and announce once", () => {
    const { tracker, sent } = setup();
    tracker.turnEnded(TAB);
    tracker.onExit(TAB);
    tracker.dispose(TAB);
    tracker.sessionExit(TAB);
    expect(sent).toEqual([
      [TAB, expect.objectContaining({ kind: "turn-complete" })],
      [TAB, null],
    ]);
  });

  it("a PTY tab never carries attention", () => {
    const { tracker, sent } = setup({ pty: true });
    tracker.turnEnded(TAB);
    tracker.planProposed(TAB, "x");
    tracker.stallPaused(TAB, true);
    expect(tracker.level(TAB)).toBeNull();
    expect(sent).toEqual([]);
  });
});
