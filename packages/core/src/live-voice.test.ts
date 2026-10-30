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
  isLiveConnectionId,
  isLiveSessionActive,
  LIVE_BASE_INSTRUCTIONS,
  LIVE_OUTPUT_ACTIVE_LEVEL,
  liveDisplayPhase,
  liveOutputSpeaking,
  LIVE_HISTORY_TEXT_MAX_BYTES,
  LIVE_INSTRUCTION_LIMITS,
  LIVE_RECAP_CUTOFF_SUFFIX,
  emptyLiveSnapshot,
  parseLiveAudioRef,
  parseLiveHistoryLine,
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

describe("live levels", () => {
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
    expect(built.contextAppends).toEqual([]);
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
    // #967: the model does not read its instructions back, so the recap
    // also rides the silent commentary channel.
    expect(built.contextAppends).toEqual([
      { text: "Earlier in this conversation, oldest first:\nUser: fix the bug\nAssistant: on it", channel: "commentary" },
    ]);
  });

  it("a pending section names the results and counts what it carried", () => {
    const built = buildLiveInstructions({ recap: [], pending: ["done: tests pass"] });
    expect(built.instructions).toContain("<pending-results>");
    expect(built.instructions).toContain("done: tests pass");
    expect(built.pendingUsed).toBe(1);
    // #967: the model neither speaks from instructions nor reads them back,
    // so each carried result is appended, speakable, in omp's final-message shape.
    expect(built.contextAppends).toEqual([{ text: '"Agent Final Message":\n\ndone: tests pass' }]);
  });

  it("appends exactly the carried prefix, after the recap, split at omp's 500-byte cap on code points", () => {
    const long = "é".repeat(400); // 800 UTF-8 bytes
    const built = buildLiveInstructions({ recap: [turn("user", 0, "ship it")], pending: [long, "second"], base: "B" });
    expect(built.pendingUsed).toBe(2);
    const encoder = new TextEncoder();
    for (const append of built.contextAppends) expect(encoder.encode(append.text).length).toBeLessThanOrEqual(500);
    const [recap, ...answers] = built.contextAppends;
    expect(recap).toEqual({ text: "Earlier in this conversation, oldest first:\nUser: ship it", channel: "commentary" });
    expect(answers.every((a) => a.channel === undefined)).toBe(true);
    expect(answers.slice(0, -1).map((a) => a.text).join("")).toBe(`"Agent Final Message":\n\n${long}`);
    expect(answers.at(-1)!.text).toBe('"Agent Final Message":\n\nsecond');
    const dropped = buildLiveInstructions({
      recap: [], pending: ["x"], base: "B".repeat(LIVE_INSTRUCTION_LIMITS.totalChars),
    });
    expect(dropped.pendingUsed).toBe(0);
    expect(dropped.contextAppends).toEqual([]);
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

  const planText = (appends: readonly { text: string; channel?: string }[]): string => {
    const intro = appends.findIndex((a) => a.text.startsWith("The plan's full text follows in the next"));
    const count = Number(/follows in the next (\d+) message/.exec(appends[intro]!.text)![1]);
    return appends.slice(intro + 1, intro + 1 + count).map((a) => a.text).join("");
  };

  it("carries the complete review artifact as silent appends, never in the instructions (#1001)", () => {
    const review = {
      title: "Storage migration",
      planFilePath: "/plans/storage.md",
      text: `${"Authored section é\n".repeat(400)}if (a < b) return "</plan>";\nTAIL`,
      briefOverview: false,
    };
    const ordinary = buildLiveInstructions({ recap: [turn("user", 0, "draft it")], pending: [] });
    const built = buildLiveInstructions({ recap: [turn("user", 0, "draft it")], pending: [], review });
    expect(built.instructions).toBe(ordinary.instructions);
    expect(built.instructions).not.toContain("TAIL");
    const encoder = new TextEncoder();
    for (const append of built.contextAppends) expect(encoder.encode(append.text).length).toBeLessThanOrEqual(500);
    // Without a requested briefing nothing is speakable: the call keeps the
    // plan for questions and stays quiet.
    expect(built.contextAppends.every((a) => a.channel === "commentary")).toBe(true);
    expect(built.contextAppends[0]!.text).toContain("User: draft it");
    expect(planText(built.contextAppends)).toBe(review.text);
  });

  it("a requested briefing ends with one speakable cue, after any carried result", () => {
    const built = buildLiveInstructions({
      recap: [], pending: ["tests pass"],
      review: { title: "Plan", planFilePath: "/plan.md", text: "Complete", briefOverview: true },
    });
    const speakable = built.contextAppends.filter((a) => a.channel === undefined);
    expect(speakable).toHaveLength(2);
    expect(speakable[0]!.text).toBe('"Agent Final Message":\n\ntests pass');
    expect(built.contextAppends.at(-1)).toBe(speakable[1]);
    expect(speakable[1]!.text).toMatch(/^Brief the user on the plan under review now/);
    expect(planText(built.contextAppends)).toBe("Complete");
    expect(built.pendingUsed).toBe(1);
  });

  it("a large review never trims the recap or the pending prefix", () => {
    const recap = Array.from({ length: 24 }, (_, i) => turn("assistant", i, `${i}: ${"r".repeat(900)}`));
    const pending = Array.from({ length: 6 }, (_, i) => `result-${i}: ${"p".repeat(4_800)}`);
    const ordinary = buildLiveInstructions({ recap, pending });
    const text = `${"Authored section\n".repeat(4_000)}TAIL`;
    const reviewed = buildLiveInstructions({
      recap, pending, review: { title: "Plan", planFilePath: "/plan.html", text, briefOverview: true },
    });
    expect(reviewed.instructions).toBe(ordinary.instructions);
    expect(reviewed.pendingUsed).toBe(ordinary.pendingUsed);
    expect(planText(reviewed.contextAppends)).toBe(text);
  });
});

describe("liveDisplayPhase / liveOutputSpeaking (ADR-0070)", () => {
  const snap = (phase: LiveSnapshot["phase"], output = 0): LiveSnapshot => ({
    ...emptyLiveSnapshot(),
    phase,
    levels: { input: 0, output },
  });
  const idle = { talking: false, working: false };

  it("muted with output at the active level is ready (boundary exclusive)", () => {
    const s = snap("muted", LIVE_OUTPUT_ACTIVE_LEVEL);
    expect(LIVE_OUTPUT_ACTIVE_LEVEL).toBe(0.015);
    expect(liveOutputSpeaking(s)).toBe(false);
    expect(liveDisplayPhase(s, idle)).toBe("ready");
  });

  it("muted with output above the active level is speaking", () => {
    const s = snap("muted", 0.016);
    expect(liveOutputSpeaking(s)).toBe(true);
    expect(liveDisplayPhase(s, idle)).toBe("speaking");
  });

  it("muted while talking is listening even when output is loud", () => {
    expect(liveDisplayPhase(snap("muted", 0.9), { talking: true, working: false })).toBe("listening");
  });

  it("muted, working and quiet is working", () => {
    expect(liveDisplayPhase(snap("muted", 0), { talking: false, working: true })).toBe("working");
  });

  it("a non-muted phase passes through", () => {
    expect(liveDisplayPhase(snap("connecting", 0.9), { talking: true, working: true })).toBe("connecting");
    expect(liveOutputSpeaking(snap("speaking"))).toBe(true);
  });

  it("a null phase is null", () => {
    expect(liveDisplayPhase(snap(null, 0.9), { talking: true, working: true })).toBeNull();
  });
});


describe("live transcript history (#817)", () => {
  it("isLiveConnectionId admits exactly the ref grammar's UUID shape", () => {
    expect(isLiveConnectionId(randomUUID())).toBe(true);
    expect(isLiveConnectionId(randomUUID().toUpperCase())).toBe(true);
    expect(isLiveConnectionId("../../etc/passwd")).toBe(false);
    expect(isLiveConnectionId("")).toBe(false);
    expect(isLiveConnectionId(`${randomUUID()}x`)).toBe(false);
    expect(isLiveConnectionId(null)).toBe(false);
    expect(isLiveConnectionId(7)).toBe(false);
  });

  it("parseLiveHistoryLine accepts the written shape", () => {
    expect(parseLiveHistoryLine('{"role":"assistant","turn":2,"text":"hello"}')).toEqual({
      role: "assistant",
      turn: 2,
      text: "hello",
    });
    // Forward tolerance: an unknown field is ignored, not rejected.
    expect(parseLiveHistoryLine('{"role":"user","turn":0,"text":"x","final":true}')).toEqual({
      role: "user",
      turn: 0,
      text: "x",
    });
  });

  it("parseLiveHistoryLine is null for every malformed shape", () => {
    expect(parseLiveHistoryLine("")).toBeNull();
    expect(parseLiveHistoryLine('{"role":"user","tu')).toBeNull(); // torn line
    expect(parseLiveHistoryLine('"a string"')).toBeNull();
    expect(parseLiveHistoryLine("null")).toBeNull();
    expect(parseLiveHistoryLine("[]")).toBeNull();
    expect(parseLiveHistoryLine('{"role":"intruder","turn":0,"text":"x"}')).toBeNull();
    expect(parseLiveHistoryLine('{"turn":0,"text":"x"}')).toBeNull();
    expect(parseLiveHistoryLine('{"role":"user","turn":"0","text":"x"}')).toBeNull();
    expect(parseLiveHistoryLine('{"role":"user","turn":1.5,"text":"x"}')).toBeNull();
    expect(parseLiveHistoryLine('{"role":"user","turn":-1,"text":"x"}')).toBeNull();
    expect(parseLiveHistoryLine('{"role":"user","turn":0}')).toBeNull();
    expect(
      parseLiveHistoryLine(
        `{"role":"user","turn":0,"text":"${"x".repeat(LIVE_HISTORY_TEXT_MAX_BYTES + 1)}"}`,
      ),
    ).toBeNull();
    // At the cap, a text passes — the cap is a ceiling, not a hair trigger.
    expect(
      parseLiveHistoryLine(
        `{"role":"user","turn":0,"text":"${"x".repeat(LIVE_HISTORY_TEXT_MAX_BYTES)}"}`,
      ),
    ).not.toBeNull();
  });
});
