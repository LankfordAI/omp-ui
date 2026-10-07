import { describe, expect, it } from "vitest";
import {
  applyLiveEnd,
  applyLiveLevels,
  applyLivePhase,
  applyLiveTranscript,
  emptyLiveSnapshot,
  parseLiveLevelsFrame,
  parseLivePhaseFrame,
  parseLiveTranscriptFrame,
  type LiveSnapshot,
} from "./live-voice";

const fresh = (): LiveSnapshot => emptyLiveSnapshot();

describe("live phase frames", () => {
  it("accepts every enum member", () => {
    for (const phase of [
      "connecting",
      "listening",
      "working",
      "speaking",
      "muted",
      "error",
    ])
      expect(parseLivePhaseFrame({ type: "live_phase", phase })).toBe(phase);
  });

  it("rejects unknown phases, missing phases and junk", () => {
    expect(parseLivePhaseFrame({ type: "live_phase", phase: "thinking" })).toBeNull();
    expect(parseLivePhaseFrame({ type: "live_phase" })).toBeNull();
    expect(parseLivePhaseFrame({ type: "live_phase", phase: 3 })).toBeNull();
    expect(parseLivePhaseFrame("nope")).toBeNull();
    expect(parseLivePhaseFrame(null)).toBeNull();
  });

  it("sets the phase on the snapshot", () => {
    expect(applyLivePhase(fresh(), "listening")).toMatchObject({
      phase: "listening",
      ended: false,
      error: null,
      turns: [],
      levels: null,
    });
  });

  it("a connecting phase after a live_end starts a new session", () => {
    const ended = applyLiveEnd(applyLivePhase(fresh(), "listening"), "stream dropped");
    const next = applyLivePhase(ended, "connecting");
    expect(next).toMatchObject({ phase: "connecting", ended: false, error: null });
  });
});

describe("live levels frames", () => {
  it("parses both levels when present and finite", () => {
    expect(parseLiveLevelsFrame({ type: "live_levels", input: 0.4, output: 0 })).toEqual({
      input: 0.4,
      output: 0,
    });
  });

  it("drops frames with missing or non-finite levels", () => {
    expect(parseLiveLevelsFrame({ type: "live_levels", input: 0.5 })).toBeNull();
    expect(
      parseLiveLevelsFrame({ type: "live_levels", input: 0.5, output: Number.NaN }),
    ).toBeNull();
    expect(parseLiveLevelsFrame({ type: "live_levels", input: "0", output: 0 })).toBeNull();
    expect(parseLiveLevelsFrame(null)).toBeNull();
  });

  it("clamps levels into [0, 1]", () => {
    const next = applyLiveLevels(fresh(), 1.5, -0.2);
    expect(next.levels).toEqual({ input: 1, output: 0 });
  });
});

describe("live transcript frames", () => {
  it("parses a well-formed turn, defaulting final to false", () => {
    expect(
      parseLiveTranscriptFrame({ type: "live_transcript", role: "user", turn: 0, text: "hi" }),
    ).toEqual({ role: "user", turn: 0, text: "hi", final: false });
    expect(
      parseLiveTranscriptFrame({
        type: "live_transcript",
        role: "assistant",
        turn: 1,
        text: "hello",
        final: true,
      }),
    ).toEqual({ role: "assistant", turn: 1, text: "hello", final: true });
  });

  it("drops malformed turns", () => {
    expect(
      parseLiveTranscriptFrame({ type: "live_transcript", role: "system", turn: 0, text: "x" }),
    ).toBeNull();
    expect(
      parseLiveTranscriptFrame({ type: "live_transcript", role: "user", turn: 0.5, text: "x" }),
    ).toBeNull();
    expect(
      parseLiveTranscriptFrame({ type: "live_transcript", role: "user", turn: 0 }),
    ).toBeNull();
    expect(parseLiveTranscriptFrame(undefined)).toBeNull();
  });

  it("appends distinct turns and replaces a re-sent (role, turn)", () => {
    let snap = applyLiveTranscript(fresh(), { role: "user", turn: 0, text: "hi", final: false });
    snap = applyLiveTranscript(snap, {
      role: "assistant",
      turn: 0,
      text: "he",
      final: false,
    });
    snap = applyLiveTranscript(snap, {
      role: "assistant",
      turn: 0,
      text: "hello there",
      final: true,
    });
    expect(snap.turns).toEqual([
      { role: "user", turn: 0, text: "hi", final: false },
      { role: "assistant", turn: 0, text: "hello there", final: true },
    ]);
    // The same turn for a different role does not collide.
    snap = applyLiveTranscript(snap, { role: "user", turn: 0, text: "hi there", final: true });
    expect(snap.turns).toHaveLength(2);
    expect(snap.turns[0]).toEqual({ role: "user", turn: 0, text: "hi there", final: true });
  });
});

describe("live_end", () => {
  it("marks the end and keeps phase and turns", () => {
    let snap = applyLivePhase(fresh(), "speaking");
    snap = applyLiveTranscript(snap, { role: "assistant", turn: 0, text: "done", final: true });
    snap = applyLiveEnd(snap, null);
    expect(snap).toMatchObject({
      phase: "speaking",
      ended: true,
      error: null,
      turns: [{ text: "done" }],
    });
  });

  it("records the frame's error text", () => {
    expect(applyLiveEnd(fresh(), "boom")).toMatchObject({ ended: true, error: "boom" });
  });

  it("an empty error string keeps the snapshot clean", () => {
    expect(applyLiveEnd(fresh(), "")).toMatchObject({ ended: true, error: null });
  });
});

describe("immutability", () => {
  it("every applier returns a new object and never mutates its input", () => {
    const snap = fresh();
    const phased = applyLivePhase(snap, "listening");
    const leveled = applyLiveLevels(phased, 0.5, 0.5);
    const turned = applyLiveTranscript(leveled, {
      role: "user",
      turn: 0,
      text: "hi",
      final: false,
    });
    const ended = applyLiveEnd(turned, null);
    expect(snap).toEqual(emptyLiveSnapshot());
    expect(phased.levels).toBeNull();
    expect(leveled.turns).toEqual([]);
    expect(turned.ended).toBe(false);
    expect(ended).not.toBe(turned);
    // applyLiveEnd keeps the turns array by reference — immutability means
    // never mutating the input, not re-copying untouched state.
    expect(ended.turns).toEqual(turned.turns);
  });
});
