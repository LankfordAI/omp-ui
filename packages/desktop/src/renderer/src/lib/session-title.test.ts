import { describe, expect, it } from "vitest";
import { generateTitleFromPrompt, isLowSignalTitleInput, isUntitled } from "./session-title";

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

describe("generateTitleFromPrompt", () => {
  it("returns the prompt unchanged when no prefix matches and under 60 chars", () => {
    expect(generateTitleFromPrompt("Create a React component that fetches weather data")).toBe(
      "Create a React component that fetches weather data",
    );
  });

  it("strips a leading conversational prefix", () => {
    expect(generateTitleFromPrompt("Can you help me debug why my API is returning 500 errors")).toBe(
      "Help me debug why my API is returning 500 errors",
    );
  });

  it("strips 'I want to'", () => {
    expect(
      generateTitleFromPrompt("I want to refactor the auth module to use OAuth2 instead of JWT"),
    ).toBe("Refactor the auth module to use OAuth2 instead of JWT");
  });

  it("capitalizes short prompts", () => {
    expect(generateTitleFromPrompt("hi")).toBe("Hi");
  });

  it("truncates at the first sentence boundary past 14 chars", () => {
    expect(
      generateTitleFromPrompt(
        "Fix the login bug. Also update the password reset flow and add unit tests for both.",
      ),
    ).toBe("Fix the login bug.");
  });

  it("truncates long prompts on a word boundary, prefix-preserving", () => {
    const src =
      "Build a feature that does X and Y and Z and includes documentation and tests for all modules";
    const result = generateTitleFromPrompt(src);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).not.toMatch(/\s$/);
    expect(src.startsWith(result)).toBe(true);
  });

  it("hard-truncates a single unbroken word", () => {
    expect(generateTitleFromPrompt("a".repeat(120))).toHaveLength(60);
  });

  it("removes trailing conjunctions left by truncation", () => {
    const src = "Build a feature that does X and Y and Z and includes documentation and tests";
    const result = generateTitleFromPrompt(src);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).not.toMatch(/\s$/);
    expect(src.startsWith(result)).toBe(true);
  });

  it("keeps a period inside a filename from ending the title early", () => {
    expect(generateTitleFromPrompt("Refactor the auth logic in store.ts and update the tests")).toBe(
      "Refactor the auth logic in store.ts and update the tests",
    );
  });

  it("strips surrounding quotes", () => {
    expect(generateTitleFromPrompt('"my quoted prompt"')).toBe("My quoted prompt");
  });

  it("falls back to a placeholder for empty-ish input", () => {
    expect(generateTitleFromPrompt("   ")).toBe("New Session");
  });

  it("skips a too-short leading sentence and truncates to the bound", () => {
    const src =
      "Fix it now. Then refactor the whole auth module and add tests for all the edge cases";
    const result = generateTitleFromPrompt(src);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).not.toMatch(/\s$/);
  });

  it("cuts at the sentence boundary when one exists inside the bound", () => {
    expect(
      generateTitleFromPrompt(
        "Update the authentication module to support OAuth2 and SSO. Also add unit tests for the new flow",
      ),
    ).toBe("Update the authentication module to support OAuth2 and SSO.");
  });

  it("collapses multi-line prompts to one line", () => {
    expect(generateTitleFromPrompt("Fix the parser\n\n   and the lexer")).toBe(
      "Fix the parser and the lexer",
    );
  });
});
