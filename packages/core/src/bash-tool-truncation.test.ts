import { describe, expect, it } from "vitest";
import { parseBashToolTruncation } from "./bash-tool-truncation";

const middle = { direction: "middle", truncatedBy: "middle" };
const columns = { maxColumn: 4096 };
const invalidCounts = [null, "12", true, -1, 1.5, NaN, Infinity, -Infinity, {}, []];

describe("parseBashToolTruncation (tool-result details.meta, upstream TruncationMeta and LimitsMeta)", () => {
  it("parses both keys with the upstream field names and drops unrelated facts", () => {
    expect(parseBashToolTruncation({
      exitCode: 0,
      artifactId: "outer-artifact",
      meta: {
        artifactId: "meta-artifact",
        minimized: { filter: "git", inputBytes: 20, outputBytes: 10 },
        truncation: {
          ...middle,
          elidedBytes: 312000,
          elidedLines: 4120,
          headRange: { start: 1, end: 10, extra: true },
          tailRange: { start: 4131, end: 4140 },
          totalLines: 4140,
          totalBytes: 320000,
          outputLines: 21,
          outputBytes: 8000,
          artifactId: "truncation-artifact",
          artifactElidedBytes: 123,
          unknown: true,
        },
        limits: {
          matchLimit: { reached: 20, suggestion: 50 },
          columnTruncated: {
            ...columns,
            unit: "bytes",
            lines: { first: 2, last: 4139, extra: true },
            rawByteCap: 1000000,
            artifactId: "column-artifact",
            artifactElidedBytes: 456,
            selectorBase: "artifact://column-artifact",
            columnDroppedBytes: 1234,
            columnTruncatedLines: 2,
            extra: true,
          },
        },
      },
    })).toEqual({
      truncation: {
        ...middle,
        elidedBytes: 312000,
        elidedLines: 4120,
        headRange: { start: 1, end: 10 },
        tailRange: { start: 4131, end: 4140 },
      },
      columnTruncated: {
        ...columns,
        unit: "bytes",
        lines: { first: 2, last: 4139 },
        rawByteCap: 1000000,
      },
    });
  });

  it("accepts each key alone without optional facts or upstream totals", () => {
    expect(parseBashToolTruncation({ meta: { truncation: middle } })).toEqual({ truncation: middle });
    expect(parseBashToolTruncation({ meta: { limits: { columnTruncated: columns } } })).toEqual({
      columnTruncated: columns,
    });
  });

  it("accepts upstream direction and truncatedBy enums without relabeling them", () => {
    for (const direction of ["head", "tail", "middle"]) {
      for (const truncatedBy of ["bytes", "lines", "middle"]) {
        const truncation = { direction, truncatedBy };
        expect(parseBashToolTruncation({ meta: { truncation } })).toEqual({ truncation });
      }
    }
  });

  it("accepts explicit bytes and chars units but leaves an absent unit absent", () => {
    for (const unit of ["bytes", "chars"]) {
      expect(parseBashToolTruncation({ meta: { limits: { columnTruncated: { ...columns, unit } } } }))
        .toEqual({ columnTruncated: { ...columns, unit } });
    }
    expect(parseBashToolTruncation({ meta: { limits: { columnTruncated: columns } } }))
      .toEqual({ columnTruncated: columns });
  });

  it("returns undefined for absent, non-record, or array wrappers", () => {
    for (const value of [undefined, null, "meta", 42, false, [], {}]) {
      expect(parseBashToolTruncation(value)).toBeUndefined();
      expect(parseBashToolTruncation({ meta: value })).toBeUndefined();
      expect(parseBashToolTruncation({ meta: { limits: value } })).toBeUndefined();
      expect(parseBashToolTruncation({ meta: { truncation: value } })).toBeUndefined();
      expect(parseBashToolTruncation({ meta: { limits: { columnTruncated: value } } })).toBeUndefined();
    }
    expect(parseBashToolTruncation(Object.assign([], { meta: { truncation: middle } }))).toBeUndefined();
    expect(parseBashToolTruncation({ meta: Object.assign([], { truncation: middle }) })).toBeUndefined();
    expect(parseBashToolTruncation({ meta: { truncation: Object.assign([], middle) } })).toBeUndefined();
    expect(parseBashToolTruncation({
      meta: { limits: Object.assign([], { columnTruncated: columns }) },
    })).toBeUndefined();
    expect(parseBashToolTruncation({
      meta: { limits: { columnTruncated: Object.assign([], columns) } },
    })).toBeUndefined();
  });

  it("requires known direction and truncatedBy fields", () => {
    for (const invalid of [undefined, null, "", "head_tail", "unknown", 1, true, {}, []]) {
      expect(parseBashToolTruncation({
        meta: { truncation: { ...middle, direction: invalid, elidedBytes: 500 } },
      })).toBeUndefined();
      expect(parseBashToolTruncation({
        meta: { truncation: { ...middle, truncatedBy: invalid, elidedLines: 50 } },
      })).toBeUndefined();
    }
  });

  it("requires a positive integer maxColumn and never accepts RPC columnMax in its place", () => {
    for (const maxColumn of [undefined, 0, ...invalidCounts]) {
      expect(parseBashToolTruncation({
        meta: { limits: { columnTruncated: { maxColumn, unit: "bytes", lines: { first: 1, last: 2 } } } },
      })).toBeUndefined();
    }
    expect(parseBashToolTruncation({
      meta: { limits: { columnTruncated: { columnMax: 4096 } } },
    })).toBeUndefined();
    expect(parseBashToolTruncation({
      meta: { limits: { columnTruncated: { maxColumn: 1, columnMax: 9999 } } },
    })).toEqual({ columnTruncated: { maxColumn: 1 } });
  });

  it("parses the two keys independently when either one is malformed", () => {
    for (const truncation of [undefined, null, [], {}, { ...middle, direction: "head_tail" }]) {
      expect(parseBashToolTruncation({ meta: { truncation, limits: { columnTruncated: columns } } }))
        .toEqual({ columnTruncated: columns });
    }
    for (const columnTruncated of [undefined, null, [], {}, { maxColumn: 0 }]) {
      expect(parseBashToolTruncation({ meta: { truncation: middle, limits: { columnTruncated } } }))
        .toEqual({ truncation: middle });
    }
    for (const limits of [undefined, null, "limits", [], {}]) {
      expect(parseBashToolTruncation({ meta: { truncation: middle, limits } }))
        .toEqual({ truncation: middle });
    }
  });

  it("keeps zero elision counts without inventing omitted counts or ranges", () => {
    expect(parseBashToolTruncation({
      meta: { truncation: { ...middle, elidedBytes: 0, elidedLines: 0 } },
    })).toEqual({ truncation: { ...middle, elidedBytes: 0, elidedLines: 0 } });
    expect(parseBashToolTruncation({
      meta: { truncation: { ...middle, elidedBytes: 12 } },
    })).toEqual({ truncation: { ...middle, elidedBytes: 12 } });
    expect(parseBashToolTruncation({
      meta: { truncation: { ...middle, elidedLines: 3 } },
    })).toEqual({ truncation: { ...middle, elidedLines: 3 } });
  });

  it("omits each malformed elision count independently", () => {
    for (const invalid of invalidCounts) {
      expect(parseBashToolTruncation({
        meta: { truncation: { ...middle, elidedBytes: invalid, elidedLines: 3 } },
      })).toEqual({ truncation: { ...middle, elidedLines: 3 } });
      expect(parseBashToolTruncation({
        meta: { truncation: { ...middle, elidedBytes: 12, elidedLines: invalid } },
      })).toEqual({ truncation: { ...middle, elidedBytes: 12 } });
    }
  });

  it("preserves one-line source ranges without deriving counts", () => {
    expect(parseBashToolTruncation({
      meta: {
        truncation: { ...middle, headRange: { start: 1, end: 1 }, tailRange: { start: 20, end: 20 } },
        limits: { columnTruncated: { ...columns, lines: { first: 4, last: 4 } } },
      },
    })).toEqual({
      truncation: { ...middle, headRange: { start: 1, end: 1 }, tailRange: { start: 20, end: 20 } },
      columnTruncated: { ...columns, lines: { first: 4, last: 4 } },
    });
  });

  it("drops invalid shown ranges independently and rejects column-style range names", () => {
    const valid = { start: 10, end: 12 };
    const invalidRanges: unknown[] = [
      undefined, null, [], "1-2", {}, { first: 1, last: 2 },
      { start: 1 }, { end: 2 }, { start: 0, end: 2 }, { start: 2, end: 1 },
      Object.assign([], { start: 1, end: 2 }),
    ];
    for (const value of invalidCounts) {
      invalidRanges.push({ start: value, end: 2 }, { start: 1, end: value });
    }
    for (const invalid of invalidRanges) {
      expect(parseBashToolTruncation({
        meta: { truncation: { ...middle, headRange: invalid, tailRange: valid } },
      })).toEqual({ truncation: { ...middle, tailRange: valid } });
      expect(parseBashToolTruncation({
        meta: { truncation: { ...middle, headRange: valid, tailRange: invalid } },
      })).toEqual({ truncation: { ...middle, headRange: valid } });
    }
  });

  it("drops invalid cut ranges without discarding the column cap", () => {
    const invalidRanges: unknown[] = [
      undefined, null, [], "1-2", {}, { start: 1, end: 2 },
      { first: 1 }, { last: 2 }, { first: 0, last: 2 }, { first: 2, last: 1 },
      Object.assign([], { first: 1, last: 2 }),
    ];
    for (const value of invalidCounts) {
      invalidRanges.push({ first: value, last: 2 }, { first: 1, last: value });
    }
    for (const lines of invalidRanges) {
      expect(parseBashToolTruncation({ meta: { limits: { columnTruncated: { ...columns, lines } } } }))
        .toEqual({ columnTruncated: columns });
    }
  });

  it("omits malformed optional column facts independently", () => {
    for (const unit of [null, "", "utf8", "characters", 12, true, {}, []]) {
      expect(parseBashToolTruncation({
        meta: { limits: { columnTruncated: { ...columns, unit, rawByteCap: 1024 } } },
      })).toEqual({ columnTruncated: { ...columns, rawByteCap: 1024 } });
    }
    for (const rawByteCap of [0, ...invalidCounts]) {
      expect(parseBashToolTruncation({
        meta: { limits: { columnTruncated: { ...columns, unit: "chars", rawByteCap } } },
      })).toEqual({ columnTruncated: { ...columns, unit: "chars" } });
    }
  });

  it("does not search RPC fields, different wrappers, or recovery text for facts", () => {
    for (const details of [
      { truncation: middle, columnMax: 4096, elidedBytes: 20 },
      { details: { meta: { truncation: middle } } },
      { meta: { columnTruncated: columns } },
      { meta: { limits: columns } },
      { meta: { limits: { truncation: middle } } },
      { meta: { minimized: { filter: "git", inputBytes: 20, outputBytes: 10 } } },
      { meta: { truncation: { artifactId: "a", artifactElidedBytes: 500 } } },
      { meta: { limits: { columnTruncated: { artifactId: "a", selectorBase: "artifact://a" } } } },
      { output: "[Some lines truncated to 4096 bytes; read artifact://a:raw:4-8]" },
    ]) {
      expect(parseBashToolTruncation(details)).toBeUndefined();
    }
  });

  it("leaves frozen source details and recovery notices untouched and copies ranges", () => {
    const headRange = Object.freeze({ start: 1, end: 2 });
    const tailRange = Object.freeze({ start: 20, end: 21 });
    const lines = Object.freeze({ first: 4, last: 8 });
    const truncation = Object.freeze({ ...middle, headRange, tailRange });
    const columnTruncated = Object.freeze({ ...columns, lines });
    const details = Object.freeze({
      output: "[Some lines truncated to 4096 bytes; read artifact://a:raw:4-8]",
      meta: Object.freeze({ truncation, limits: Object.freeze({ columnTruncated }) }),
    });
    const before = JSON.stringify(details);
    const parsed = parseBashToolTruncation(details);
    expect(parsed).toEqual({ truncation, columnTruncated });
    expect(JSON.stringify(details)).toBe(before);
    expect(parsed?.truncation).not.toBe(truncation);
    expect(parsed?.truncation?.headRange).not.toBe(headRange);
    expect(parsed?.truncation?.tailRange).not.toBe(tailRange);
    expect(parsed?.columnTruncated).not.toBe(columnTruncated);
    expect(parsed?.columnTruncated?.lines).not.toBe(lines);
  });
});
