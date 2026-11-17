import { describe, expect, it } from "vitest";
import { TurnTracker } from "./turns";

const TAB = "tab-1";

describe("TurnTracker run-spanning latch (issue #1192)", () => {
  it("a non-terminal end keeps the run latched and pauses only on a live run", () => {
    const transitions: Array<[string, boolean]> = [];
    const turns = new TurnTracker((tabId, running) => transitions.push([tabId, running]));
    expect(turns.isRunning(TAB)).toBe(false);

    // A pause with no open run is nothing to pause.
    turns.pause(TAB, true);
    expect(turns.isAwaitingAsyncWork(TAB)).toBe(false);
    expect(transitions).toEqual([]);

    turns.start(TAB);
    expect(transitions).toEqual([[TAB, true]]);
    // The run spans the pause: still running, and only one edge fired.
    turns.pause(TAB, false);
    expect(turns.isRunning(TAB)).toBe(true);
    expect(turns.isAwaitingAsyncWork(TAB)).toBe(false);
    expect(transitions).toEqual([[TAB, true]]);

    // The terminal end releases the latch and drops any wait level.
    turns.end(TAB);
    expect(turns.isRunning(TAB)).toBe(false);
    expect(transitions).toEqual([
      [TAB, true],
      [TAB, false],
    ]);
  });

  it("publishes one edge per waiting-level change and clears the level on start, end, and clear", () => {
    const transitions: Array<[string, boolean]> = [];
    const turns = new TurnTracker((tabId, running) => transitions.push([tabId, running]));
    turns.start(TAB);
    const edges = transitions.length;

    // Set the level once: one publish, and repeat pauses are silent.
    turns.pause(TAB, true);
    expect(turns.isAwaitingAsyncWork(TAB)).toBe(true);
    expect(transitions.slice(edges)).toEqual([[TAB, true]]);
    turns.pause(TAB, true);
    expect(transitions.length).toBe(edges + 1);

    // A queued-input pause (awaiting=false) clears the level: one more edge.
    turns.pause(TAB, false);
    expect(turns.isAwaitingAsyncWork(TAB)).toBe(false);
    expect(transitions.length).toBe(edges + 2);

    // A start clears the wait level (the wake resumes real work) while the
    // latch stays set; a later pause can re-arm the level.
    turns.pause(TAB, true);
    turns.start(TAB);
    expect(turns.isAwaitingAsyncWork(TAB)).toBe(false);
    expect(turns.isRunning(TAB)).toBe(true);

    turns.end(TAB);
    expect(transitions.at(-1)).toEqual([TAB, false]);

    // clear() drops both sets without a transition (the exit broadcast owns it).
    turns.start(TAB);
    turns.pause(TAB, true);
    turns.clear(TAB);
    expect(turns.isRunning(TAB)).toBe(false);
    expect(turns.isAwaitingAsyncWork(TAB)).toBe(false);
  });
});
