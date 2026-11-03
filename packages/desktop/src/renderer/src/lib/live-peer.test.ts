import { describe, expect, it } from "vitest";
import { createSpeakerGate, type PlayableSpeaker } from "./live-peer";

/** Speaker stub: jsdom has no WebRTC or audio stack; the gate only touches three members. */
function stubSpeaker(playingAtStart = false): PlayableSpeaker & {
  pauses: number;
  plays: number;
  paused: boolean;
} {
  const speaker = {
    paused: !playingAtStart,
    pauses: 0,
    plays: 0,
    pause(): void {
      speaker.pauses += 1;
      speaker.paused = true;
    },
    play(): Promise<void> {
      speaker.plays += 1;
      speaker.paused = false;
      return Promise.resolve();
    },
  };
  return speaker;
}

describe("createSpeakerGate (half-duplex, ADR-0087)", () => {
  it("pauses a playing speaker on open and resumes it exactly once on close", () => {
    const speaker = stubSpeaker(true);
    const gate = createSpeakerGate(speaker);
    gate.setMicOpen(true);
    expect(speaker.paused).toBe(true);
    expect(speaker.pauses).toBe(1);
    gate.setMicOpen(false);
    expect(speaker.plays).toBe(1);
    expect(speaker.paused).toBe(false);
  });

  it("does not resume audio that was never playing", () => {
    const speaker = stubSpeaker(false);
    const gate = createSpeakerGate(speaker);
    gate.setMicOpen(true);
    expect(speaker.pauses).toBe(1);
    gate.setMicOpen(false);
    expect(speaker.plays).toBe(0);
  });

  it("ignores repeated opens: a reply that starts mid-hold is not resumed on close", () => {
    const speaker = stubSpeaker(false);
    const gate = createSpeakerGate(speaker);
    gate.setMicOpen(true);
    // The release tail's re-press path calls setMicEnabled(true) again.
    gate.setMicOpen(true);
    expect(speaker.pauses).toBe(1);
    // A reply begins while the mic is open (server-side append plays into the
    // paused element is moot; the rule is: resume iff playing when the hold began).
    gate.setMicOpen(false);
    expect(speaker.plays).toBe(0);
  });

  it("swallows a rejecting play() from an ended remote track", async () => {
    const speaker = stubSpeaker(true);
    speaker.play = () => Promise.reject(new Error("ended"));
    const gate = createSpeakerGate(speaker);
    gate.setMicOpen(true);
    expect(() => gate.setMicOpen(false)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("is inert when closed without a prior open", () => {
    const speaker = stubSpeaker(true);
    const gate = createSpeakerGate(speaker);
    gate.setMicOpen(false);
    expect(speaker.plays).toBe(0);
    expect(speaker.pauses).toBe(0);
  });
});
