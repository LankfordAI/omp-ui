import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  applyLiveEnd,
  applyLiveLevels,
  applyLivePhase,
  applyLiveTranscript,
  appendLiveRecap,
  buildLiveInstructions,
  formatLiveAudioRef,
  isLiveSessionActive,
  LIVE_BASE_INSTRUCTIONS,
  LIVE_INSTRUCTION_LIMITS,
  LIVE_RECAP_CUTOFF_SUFFIX,
  emptyLiveSnapshot,
  parseLiveAudioRef,
  parseLiveLevelsFrame,
  parseLivePhaseFrame,
  parseLiveTranscriptFrame,
  type LivePhase,
  type LiveSnapshot,
  type LiveTurn,
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

describe("isLiveSessionActive", () => {
  it.each(["connecting", "listening", "working", "speaking", "muted"])(
    "a booted %s session is active",
    (phase) => {
      expect(isLiveSessionActive(applyLivePhase(fresh(), phase as LivePhase))).toBe(true);
    },
  );

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["the pre-frame snapshot", fresh()],
  ])("treats %s as no session", (_label, snap) => {
    expect(isLiveSessionActive(snap)).toBe(false);
  });

  it("an error verdict is not active", () => {
    expect(isLiveSessionActive(applyLivePhase(fresh(), "error"))).toBe(false);
  });

  it("an ended session is not active", () => {
    expect(isLiveSessionActive(applyLiveEnd(applyLivePhase(fresh(), "listening"), null))).toBe(
      false,
    );
  });
});

const SESSION = "01890a2b-3c4d-7e5f-8a1b-2c3d4e5f6a7b";
const CONNECTION = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("voice recording references (#809)", () => {
  it("formats the v1 scheme", () => {
    expect(
      formatLiveAudioRef({ sessionId: SESSION, connectionId: CONNECTION, role: "assistant", turn: 3 }),
    ).toBe(`v1/${SESSION}/${CONNECTION}/assistant/3`);
  });

  it("round-trips a well-formed reference", () => {
    const ref = { sessionId: SESSION, connectionId: CONNECTION, role: "user" as const, turn: 0 };
    expect(parseLiveAudioRef(formatLiveAudioRef(ref))).toEqual(ref);
  });

  it("rejects malformed segments", () => {
    expect(parseLiveAudioRef("")).toBeNull();
    expect(parseLiveAudioRef(`v1/${SESSION}/${CONNECTION}/assistant`)).toBeNull();
    expect(parseLiveAudioRef(`v1/${SESSION}/${CONNECTION}/assistant/3/extra`)).toBeNull();
    expect(parseLiveAudioRef(`v2/${SESSION}/${CONNECTION}/assistant/3`)).toBeNull();
    expect(parseLiveAudioRef(`v1/not-a-uuid/${CONNECTION}/assistant/3`)).toBeNull();
    expect(parseLiveAudioRef(`v1/${SESSION}/../../etc/assistant/3`)).toBeNull();
    expect(parseLiveAudioRef(`v1/${SESSION}/${CONNECTION}/system/3`)).toBeNull();
    expect(parseLiveAudioRef(`v1/${SESSION}/${CONNECTION}/assistant/-1`)).toBeNull();
    expect(parseLiveAudioRef(`v1/${SESSION}/${CONNECTION}/assistant/1.5`)).toBeNull();
    expect(parseLiveAudioRef(`v1/${SESSION}/${CONNECTION}/assistant/3%00`)).toBeNull();
  });

  it("a turn number reused across connections yields distinct refs", () => {
    const a = formatLiveAudioRef({ sessionId: SESSION, connectionId: CONNECTION, role: "assistant", turn: 2 });
    const b = formatLiveAudioRef({ sessionId: SESSION, connectionId: randomUUID(), role: "assistant", turn: 2 });
    expect(a).not.toBe(b);
    const [pa, pb] = [parseLiveAudioRef(a), parseLiveAudioRef(b)] as const;
    expect(pa?.turn).toBe(pb?.turn);
    expect(pa?.connectionId).not.toBe(pb?.connectionId);
  });

  it("applyLivePhase leaves the connectionId alone", () => {
    const snap = { ...emptyLiveSnapshot(), connectionId: CONNECTION };
    expect(applyLivePhase(snap, "connecting").connectionId).toBe(CONNECTION);
    expect(applyLiveEnd(snap, null).connectionId).toBe(CONNECTION);
  });
});

const turn = (role: LiveTurn["role"], n: number, text: string, final = true): LiveTurn => ({
  role,
  turn: n,
  text,
  final,
});

describe("appendLiveRecap (#811)", () => {
  it("appends finals in order", () => {
    expect(appendLiveRecap([], [turn("user", 0, "hi"), turn("assistant", 0, "hello")])).toEqual([
      turn("user", 0, "hi"),
      turn("assistant", 0, "hello"),
    ]);
  });

  it("marks a partial-only key as cut off", () => {
    const [only] = appendLiveRecap([], [turn("assistant", 1, "half a sent", false)]);
    expect(only).toEqual({
      role: "assistant",
      turn: 1,
      text: `half a sent${LIVE_RECAP_CUTOFF_SUFFIX}`,
      final: false,
    });
  });

  it("a final supersedes the partials of the same key", () => {
    const turns = [
      turn("assistant", 1, "hel", false),
      turn("assistant", 1, "hello", false),
      turn("assistant", 1, "hello!", true),
    ];
    expect(appendLiveRecap([], turns)).toEqual([turn("assistant", 1, "hello!")]);
  });

  it("keeps the recap prefix and appends after it", () => {
    const recap = [turn("user", 0, "before")];
    expect(appendLiveRecap(recap, [turn("assistant", 0, "after")])).toEqual([
      ...recap,
      turn("assistant", 0, "after"),
    ]);
  });

  it("an empty connection adds nothing", () => {
    const recap = [turn("user", 0, "x")];
    expect(appendLiveRecap(recap, [])).toEqual(recap);
  });
});

describe("buildLiveInstructions (#811)", () => {
  it("empty inputs are the base verbatim", () => {
    const built = buildLiveInstructions({ recap: [], pending: [] });
    expect(built.instructions).toBe(LIVE_BASE_INSTRUCTIONS);
    expect(built.pendingUsed).toBe(0);
  });

  it("renders the recap oldest first and keeps pending out when empty", () => {
    const built = buildLiveInstructions({
      recap: [turn("user", 0, "fix the bug"), turn("assistant", 0, "on it")],
      pending: [],
    });
    expect(built.instructions.startsWith(LIVE_BASE_INSTRUCTIONS)).toBe(true);
    expect(built.instructions).toContain(
      "User: fix the bug\nAssistant: on it",
    );
    expect(built.instructions).not.toContain("<pending-results>");
  });

  it("a pending section names the results and counts what it carried", () => {
    const built = buildLiveInstructions({ recap: [], pending: ["done: tests pass"] });
    expect(built.instructions).toContain("<pending-results>");
    expect(built.instructions).toContain("done: tests pass");
    expect(built.pendingUsed).toBe(1);
  });

  it("keeps the newest recapTurns entries", () => {
    const recap = Array.from({ length: 30 }, (_, i) => turn("user", i, `u${i}`));
    const built = buildLiveInstructions({ recap, pending: [], base: "B" });
    expect(built.instructions).toContain("User: u29");
    expect(built.instructions).not.toContain("User: u9\n");
    expect(built.instructions).toContain("User: u10");
  });

  it("trims the oldest recap lines down to recapChars", () => {
    const fat = "x".repeat(1000);
    const recap = Array.from({ length: 10 }, (_, i) => turn("user", i, fat));
    const built = buildLiveInstructions({ recap, pending: [], base: "B" });
    const lines = built.instructions
      .slice(built.instructions.indexOf("<voice-recap>") + "<voice-recap>".length)
      .split("\n")
      .filter((line) => line.startsWith("User: "));
    // 6 lines would run 6 041 joined chars past the 6 000 cap; 5 fit.
    expect(lines.join("\n").length).toBeLessThanOrEqual(
      LIVE_INSTRUCTION_LIMITS.recapChars,
    );
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toBe(`User: ${fat}`);
  });

  it("truncates an oversized pending entry with the in-session note", () => {
    const big = "y".repeat(LIVE_INSTRUCTION_LIMITS.pendingEntryChars + 500);
    const built = buildLiveInstructions({ recap: [], pending: [big], base: "B" });
    expect(built.instructions).toContain(
      "y".repeat(LIVE_INSTRUCTION_LIMITS.pendingEntryChars) +
        "\n[truncated — full answer in the session transcript]",
    );
    expect(built.pendingUsed).toBe(1);
  });

  it("trims recap before dropping pending entries when the total is over", () => {
    // A recap inside its own caps plus pending that alone fits: the total
    // cap sacrifices the recap whole, and no pending entry is dropped.
    const line = "z".repeat(5_900);
    const recap = [turn("user", 0, line)];
    const entry = "w".repeat(3_345);
    const pending = [entry, entry, entry];
    const built = buildLiveInstructions({ recap, pending, base: "B" });
    expect(built.instructions.length).toBeLessThanOrEqual(
      LIVE_INSTRUCTION_LIMITS.totalChars,
    );
    expect(built.instructions).not.toContain("<voice-recap>");
    expect(built.pendingUsed).toBe(3);
  });

  it("drops newest pending entries down to the total cap", () => {
    const padding = "q".repeat(LIVE_INSTRUCTION_LIMITS.pendingEntryChars - 4);
    const pending = Array.from({ length: 6 }, (_, i) => `e${i} ${padding}`);
    const built = buildLiveInstructions({ recap: [], pending, base: "B" });
    expect(built.instructions.length).toBeLessThanOrEqual(
      LIVE_INSTRUCTION_LIMITS.totalChars,
    );
    // A prefix survives whole: the oldest entries ride, the newest drop.
    expect(built.pendingUsed).toBeGreaterThan(0);
    expect(built.pendingUsed).toBeLessThan(pending.length);
    expect(built.instructions).toContain(pending[0]!);
    expect(built.instructions).not.toContain(`e${pending.length - 1} `);
  });
});
