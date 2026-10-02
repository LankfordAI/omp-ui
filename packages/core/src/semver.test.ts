import { describe, expect, it } from "vitest";
import { compareVersions, parseSemver } from "./semver";

describe("parseSemver", () => {
  it("parses X.Y.Z with or without a v prefix", () => {
    expect(parseSemver("17.1.8")).toEqual({ major: 17, minor: 1, patch: 8 });
    expect(parseSemver("v17.2.4")).toEqual({ major: 17, minor: 2, patch: 4 });
  });

  it("rejects non-semver input", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("abc")).toBeNull();
    expect(parseSemver("17")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("17.1.8", "17.2.4")).toBeLessThan(0);
    expect(compareVersions("17.2.4", "17.1.8")).toBeGreaterThan(0);
    expect(compareVersions("17.2.4", "17.2.4")).toBe(0);
    expect(compareVersions("18.0.0", "17.99.0")).toBeGreaterThan(0);
    expect(compareVersions("17.2.0", "17.2.5")).toBeLessThan(0);
  });

  it("treats unparseable input as lowest", () => {
    expect(compareVersions("", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "garbage")).toBeGreaterThan(0);
  });
});
