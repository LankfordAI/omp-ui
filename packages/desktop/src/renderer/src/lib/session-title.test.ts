import { describe, expect, it } from "vitest";
import { isLowSignalTitleInput, isUntitled, titleContextWords } from "./session-title";

describe("isLowSignalTitleInput", () => {
  it("defers on bare greetings and acks", () => {
    for (const msg of ["hi", "hi!", "hey there", "yo", "thanks!", "ok", "sup", "test"]) {
      expect(isLowSignalTitleInput(msg), msg).toBe(true);
    }
  });

  it("defers on punctuation-only and number-only input", () => {
    for (const msg of ["???", "...", "42", "1 2 3", "   "]) {
      expect(isLowSignalTitleInput(msg), msg).toBe(true);
    }
  });

  it("accepts any message carrying a concrete task", () => {
    for (const msg of [
      "hi, fix the login bug",
      "Refactor the auth module",
      "why is the sidebar empty?",
      "ok now add pagination",
    ]) {
      expect(isLowSignalTitleInput(msg), msg).toBe(false);
    }
  });

  it("ignores fenced code when judging signal", () => {
    expect(isLowSignalTitleInput("hi\n```ts\nconst renameSession = 1;\n```")).toBe(true);
    expect(isLowSignalTitleInput("port this\n```ts\nconst x = 1;\n```")).toBe(false);
  });

  it("ignores paired XML blocks when judging signal", () => {
    expect(isLowSignalTitleInput("hey <details>refactor the parser</details>")).toBe(true);
  });
});

describe("titleContextWords", () => {
  const words = (n: number, at = 0): string =>
    Array.from({ length: n }, (_, i) => `w${i + at}`).join(" ");

  it("counts thinking and reply text; tool calls contribute nothing", () => {
    expect(titleContextWords({ content: [{ type: "text", text: words(5) }] })).toBe(5);
    expect(titleContextWords({ content: [{ type: "thinking", thinking: words(3) }] })).toBe(3);
    expect(
      titleContextWords({
        content: [
          { type: "thinking", thinking: words(2) },
          { type: "text", text: words(4, 2) },
          { type: "toolCall", id: "t1", name: "read", arguments: {} },
        ],
      }),
    ).toBe(6);
    expect(titleContextWords({ content: "two words" })).toBe(2);
  });

  it("an aborted or errored tail is worth zero, and empty content nothing", () => {
    const big = [{ type: "text", text: words(50) }];
    expect(titleContextWords({ content: big, stopReason: "aborted" })).toBe(0);
    expect(titleContextWords({ content: big, stopReason: "error" })).toBe(0);
    expect(titleContextWords({ content: [] })).toBe(0);
    expect(titleContextWords({})).toBe(0);
  });
});

describe("isUntitled", () => {
  it("treats absent, blank, and the placeholder as unnamed", () => {
    expect(isUntitled(null)).toBe(true);
    expect(isUntitled(undefined)).toBe(true);
    expect(isUntitled("   ")).toBe(true);
    expect(isUntitled("New session")).toBe(true);
    expect(isUntitled("new session")).toBe(true);
  });

  it("treats any real title as named", () => {
    expect(isUntitled("New session plan")).toBe(false);
    expect(isUntitled("Fix the login bug")).toBe(false);
  });
});
