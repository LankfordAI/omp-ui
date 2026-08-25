import { describe, expect, it } from "vitest";
import { compactNum, exactNum, formatCost, shortBase, tokenCount } from "./format";

describe("shortBase", () => {
  it("shortens a 40-hex commit to 8 chars and leaves refs verbatim", () => {
    expect(shortBase("a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0")).toBe("a1b2c3d4");
    expect(shortBase("main")).toBe("main");
    // Uppercase hex is not git's normalized output — treated as a ref name.
    expect(shortBase("A1B2C3D4E5F6A7B8C9D0A1B2C3D4E5F6A7B8C9D0")).toBe(
      "A1B2C3D4E5F6A7B8C9D0A1B2C3D4E5F6A7B8C9D0",
    );
    // 39 or 41 hex chars is not a full SHA either.
    expect(shortBase("a".repeat(39))).toBe("a".repeat(39));
  });
});

describe("compactNum", () => {
  it("compacts counts at the K/M/B steps with one decimal", () => {
    expect(compactNum(999)).toBe("999");
    expect(compactNum(1500)).toBe("1.5K");
    expect(compactNum(2000)).toBe("2K");
    expect(compactNum(1500000)).toBe("1.5M");
    expect(compactNum(2000000000)).toBe("2B");
  });
});

describe("exactNum", () => {
  it("groups exact digits for tooltips", () => {
    expect(exactNum(1234567)).toBe("1,234,567");
  });
});

describe("formatCost", () => {
  it("shows cost at four decimals", () => {
    expect(formatCost(1.5)).toBe("$1.5000");
  });
});

describe("tokenCount", () => {
  it("stays raw below 10,000 and switches to lowercase k at or above", () => {
    expect(tokenCount(9999)).toBe("9999");
    expect(tokenCount(10000)).toBe("10.0k");
    expect(tokenCount(12345)).toBe("12.3k");
  });
});
