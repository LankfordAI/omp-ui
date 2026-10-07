import { describe, expect, it } from "vitest";
import { isLowSignalTitleInput, isUntitled } from "./session-title";

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
