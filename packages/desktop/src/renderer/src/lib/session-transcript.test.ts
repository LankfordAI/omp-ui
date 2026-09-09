import { describe, expect, it } from "vitest";
import { buildTitleTranscript } from "./session-transcript";
import type { RenderItem } from "./transcript";

let n = 0;
const user = (text: string): RenderItem => ({ kind: "user", id: `u${++n}`, text });
const assistant = (text: string): RenderItem => ({
  kind: "assistant",
  id: `a${++n}`,
  text,
  thinking: "",
  streaming: false,
});
const tool = (resultText: string): RenderItem => ({
  kind: "tool",
  id: `t${++n}`,
  toolCallId: `tc${n}`,
  name: "bash",
  args: {},
  status: "done",
  resultText,
});

describe("buildTitleTranscript", () => {
  it("digests user and assistant turns in order, dropping process", () => {
    const items: RenderItem[] = [
      user("fix the parser"),
      tool("SECRET TOOL OUTPUT"),
      { kind: "notice", id: "n1", text: "exported" },
      { kind: "marker", id: "m1", label: "context compacted" },
      assistant("done: grammar simplified"),
    ];
    const { text } = buildTitleTranscript(items);
    expect(text).toBe("USER: fix the parser\n\nASSISTANT: done: grammar simplified");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("exported");
    expect(text).not.toContain("compacted");
  });

  it("counts turns without a second parse, ignoring blank turns", () => {
    const { userTurns, assistantTurns } = buildTitleTranscript([
      user("one task"),
      { kind: "user", id: "u-blank", text: "  " },
      assistant(""),
      assistant("an answer"),
    ]);
    expect(userTurns).toBe(1);
    expect(assistantTurns).toBe(1);
  });

  it("keeps everything under the budget", () => {
    const { text } = buildTitleTranscript([user("a"), assistant("b"), user("c")]);
    expect(text).toBe("USER: a\n\nASSISTANT: b\n\nUSER: c");
  });

  it("walks newest-first and pins the first user turn when it cuts", () => {
    const items: RenderItem[] = [user("fix the parser")];
    for (let i = 0; i < 60; i++) {
      items.push(assistant(`turn ${i} ${"y".repeat(200)}`));
      items.push(user(`follow-up ${i} ${"z".repeat(200)}`));
    }
    items.push(assistant("NEWEST TURN"));
    const { text } = buildTitleTranscript(items);
    expect(text.length).toBeLessThanOrEqual(8_000);
    // The original subject survives the cut, exactly once, ahead of the marker.
    expect(text.startsWith("USER: fix the parser\n\n[Earlier content truncated]\n\n")).toBe(true);
    expect(text.match(/fix the parser/g)).toHaveLength(1);
    expect(text.endsWith("NEWEST TURN")).toBe(true);
  });

  it("tail-marks an oversized pinned first user turn", () => {
    const items: RenderItem[] = [user("a".repeat(5_000))];
    for (let i = 0; i < 40; i++) items.push(assistant(`turn ${i} ${"y".repeat(200)}`));
    items.push(assistant("NEWEST TURN"));
    const { text } = buildTitleTranscript(items);
    expect(
      text.startsWith(`USER: ${"a".repeat(2_000)}\n[First user message truncated]\n\n`),
    ).toBe(true);
    expect(text).toContain("[Earlier content truncated]");
    expect(text.endsWith("NEWEST TURN")).toBe(true);
  });

  it("marks the cut even when no user turn can be pinned", () => {
    const items: RenderItem[] = [];
    for (let i = 0; i < 60; i++) items.push(assistant(`turn ${i} ${"y".repeat(200)}`));
    items.push(assistant("NEWEST TURN"));
    const { text } = buildTitleTranscript(items);
    expect(text.startsWith("[Earlier content truncated]\n\n")).toBe(true);
    expect(text.endsWith("NEWEST TURN")).toBe(true);
  });
});
