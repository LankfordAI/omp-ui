import { describe, expect, it } from "vitest";
import { parseBashMinimized } from "./bash-minimized";

describe("parseBashMinimized (omp 18.16 details.meta.minimized, upstream MinimizedMeta)", () => {
  it("parses the full shape and tolerates artifactId plus extra keys", () => {
    expect(
      parseBashMinimized({
        meta: { minimized: { filter: "git", inputBytes: 123289, outputBytes: 3276, artifactId: "a1b2" } },
      }),
    ).toEqual({ filter: "git", inputBytes: 123289, outputBytes: 3276 });
    expect(
      parseBashMinimized({
        meta: { minimized: { filter: "grep", inputBytes: 0, outputBytes: 0, extra: true }, other: 1 },
        unrelated: "meta key",
        exitCode: 0,
      }),
    ).toEqual({ filter: "grep", inputBytes: 0, outputBytes: 0 });
  });

  it("returns undefined when details, meta, or minimized is absent or not an object", () => {
    expect(parseBashMinimized(null)).toBeUndefined();
    expect(parseBashMinimized(undefined)).toBeUndefined();
    expect(parseBashMinimized("meta")).toBeUndefined();
    expect(parseBashMinimized(42)).toBeUndefined();
    expect(parseBashMinimized({})).toBeUndefined();
    expect(parseBashMinimized({ meta: null })).toBeUndefined();
    expect(parseBashMinimized({ meta: "minimized" })).toBeUndefined();
    expect(parseBashMinimized({ meta: {} })).toBeUndefined();
    expect(parseBashMinimized({ meta: { minimized: null } })).toBeUndefined();
    expect(parseBashMinimized({ meta: { minimized: "git 1KB" } })).toBeUndefined();
    expect(parseBashMinimized({ meta: { minimized: [] } })).toBeUndefined();
  });

  it("rejects an empty or non-string filter", () => {
    const base = { inputBytes: 10, outputBytes: 5 };
    expect(parseBashMinimized({ meta: { minimized: { ...base, filter: "" } } })).toBeUndefined();
    expect(parseBashMinimized({ meta: { minimized: { ...base, filter: 7 } } })).toBeUndefined();
    expect(parseBashMinimized({ meta: { minimized: base } })).toBeUndefined();
  });

  it("rejects byte counts that are missing or not non-negative finite integers", () => {
    const base = { filter: "git" };
    expect(parseBashMinimized({ meta: { minimized: { ...base, outputBytes: 5 } } })).toBeUndefined();
    expect(parseBashMinimized({ meta: { minimized: { ...base, inputBytes: 10 } } })).toBeUndefined();
    expect(
      parseBashMinimized({ meta: { minimized: { ...base, inputBytes: NaN, outputBytes: 5 } } }),
    ).toBeUndefined();
    expect(
      parseBashMinimized({ meta: { minimized: { ...base, inputBytes: -1, outputBytes: 5 } } }),
    ).toBeUndefined();
    expect(
      parseBashMinimized({ meta: { minimized: { ...base, inputBytes: 10, outputBytes: Infinity } } }),
    ).toBeUndefined();
    expect(
      parseBashMinimized({ meta: { minimized: { ...base, inputBytes: "10", outputBytes: 5 } } }),
    ).toBeUndefined();
  });
});
