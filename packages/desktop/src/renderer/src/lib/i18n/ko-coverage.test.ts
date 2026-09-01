import { describe, expect, it } from "vitest";
import { en } from "./en";
import { ko } from "./ko";

const placeholders = (value: string): string[] =>
  [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!))].sort();

describe("Korean draft catalog", () => {
  it("has exactly the same keys as the English source catalog", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
  });

  it("preserves every English placeholder", () => {
    for (const [key, english] of Object.entries(en)) {
      const korean = ko[key as keyof typeof en];
      expect(korean, key).toBeDefined();
      expect(placeholders(korean!), key).toEqual(placeholders(english));
    }
  });
});
