import { describe, expect, it } from "vitest";
import { parseBashTruncation } from "./bash-truncation";

const provenance = {
  elidedBytes: 123456,
  elidedLines: 321,
  columnDroppedBytes: 4096,
  columnTruncatedLines: 3,
  columnTruncatedRange: { first: 2, last: 11 },
  columnMax: 1024,
};

describe("parseBashTruncation (omp 18.17 BashResult and recorded OutputMeta)", () => {
  it("preserves all six wire fields without artifact references or unrelated output", () => {
    expect(parseBashTruncation({
      ...provenance,
      output: "preview",
      truncated: true,
      artifactId: "secret-spill",
      artifactElidedBytes: 999999,
      extra: true,
    })).toEqual(provenance);
  });

  it.each([
    "elidedBytes", "elidedLines", "columnDroppedBytes", "columnTruncatedLines", "columnMax",
  ])("preserves an independently supplied %s", (key) => {
    expect(parseBashTruncation({ [key]: 7 })).toEqual({ [key]: 7 });
    for (const invalid of [undefined, null, "7", false, -1, 1.5, NaN, Infinity, -Infinity]) {
      expect(parseBashTruncation({ [key]: invalid })).toBeUndefined();
    }
  });

  it("ignores malformed fields independently without losing valid provenance", () => {
    expect(parseBashTruncation({
      elidedBytes: 2048,
      elidedLines: "12",
      columnTruncatedLines: -1,
      columnTruncatedRange: { first: 8, last: 2 },
      columnMax: Infinity,
    })).toEqual({ elidedBytes: 2048 });
  });

  it("reads artifact line ranges as ordered positive first/last integers", () => {
    expect(parseBashTruncation({ columnTruncatedRange: { first: 4, last: 4, artifactId: "hidden" } }))
      .toEqual({ columnTruncatedRange: { first: 4, last: 4 } });
    for (const invalid of [
      null, [], "4-8", [4, 8], {}, { start: 4, end: 8 },
      { first: 0, last: 8 }, { first: 8, last: 4 }, { first: 1.5, last: 8 },
      { first: 1, last: Infinity }, { first: "1", last: 8 }, { first: 1 },
    ]) {
      expect(parseBashTruncation({ columnTruncatedRange: invalid })).toBeUndefined();
    }
  });

  it("does not decorate absent, foreign, old-runtime, or zero-only results", () => {
    for (const input of [
      undefined, null, [], "result", 42, {},
      { output: "old output", truncated: true, totalBytes: 100000, outputBytes: 65536 },
      { elidedBytes: 0, elidedLines: 0, columnDroppedBytes: 0, columnTruncatedLines: 0, columnMax: 0 },
      { meta: { truncation: { elidedBytes: 0, elidedLines: 0 } } },
      { meta: { limits: { columnTruncated: { maxColumn: 0, unit: "bytes" } } } },
      { details: { meta: { truncation: { elidedBytes: 5 } } } },
    ]) {
      expect(parseBashTruncation(input)).toBeUndefined();
    }
    expect(parseBashTruncation({ elidedBytes: 4, elidedLines: 0 })).toEqual({ elidedBytes: 4, elidedLines: 0 });
  });

  it("maps the metadata bash-runner actually persists without inventing missing column counts", () => {
    expect(parseBashTruncation({
      role: "bashExecution",
      meta: {
        truncation: { direction: "middle", elidedBytes: 123456, elidedLines: 321, artifactId: "hidden" },
        limits: { columnTruncated: { maxColumn: 1024, unit: "bytes", lines: { first: 2, last: 11 }, artifactId: "hidden" } },
      },
    })).toEqual({
      elidedBytes: 123456,
      elidedLines: 321,
      columnTruncatedRange: { first: 2, last: 11 },
      columnMax: 1024,
    });
  });

  it("ignores malformed metadata and never labels character limits as UTF-8 byte limits", () => {
    for (const meta of [null, [], "meta", { truncation: [] }, { limits: "columns" },
      { limits: { columnTruncated: { maxColumn: 1024, unit: "chars", lines: { first: 2, last: 11 } } } },
      { limits: { columnTruncated: { maxColumn: 1024 } } },
    ]) {
      expect(parseBashTruncation({ meta })).toBeUndefined();
    }
  });
});
