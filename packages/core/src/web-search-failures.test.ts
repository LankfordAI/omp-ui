import { describe, expect, it } from "vitest";
import { parseWebSearchFailures } from "./web-search-failures";

const failure = { provider: "exa", label: "Exa", reason: "No sources", status: 204 };

describe("parseWebSearchFailures", () => {
  it("preserves ordered diagnostics and optional status, ignoring extra keys", () => {
    expect(parseWebSearchFailures({ failures: [
      { ...failure, extra: true },
      { provider: "brave", label: "Brave", reason: "Unavailable" },
    ] })).toEqual([failure, { provider: "brave", label: "Brave", reason: "Unavailable" }]);
  });

  it.each([undefined, null, "bad", [], {}, { failures: null }, { failures: {} }, { failures: [] }])(
    "omits absent or foreign metadata %j", (details) => {
      expect(parseWebSearchFailures(details)).toBeUndefined();
    },
  );

  it.each([
    null, [], "bad", {}, { ...failure, provider: "" }, { ...failure, label: 1 },
    { ...failure, reason: " \n " }, { ...failure, status: "204" },
    { ...failure, status: null }, { ...failure, status: NaN },
    { ...failure, status: Infinity }, { ...failure, status: -1 }, { ...failure, status: 2.5 },
  ])("ignores malformed entry %j without losing valid siblings", (entry) => {
    expect(parseWebSearchFailures({ failures: [entry] })).toBeUndefined();
    expect(parseWebSearchFailures({ failures: [entry, failure] })).toEqual([failure]);
  });

  it("flattens and caps foreign multiline reasons", () => {
    expect(parseWebSearchFailures({ failures: [{ ...failure, reason: " request\n\tfailed " }] })?.[0]?.reason)
      .toBe("request failed");
    expect(parseWebSearchFailures({ failures: [{ ...failure, reason: "x".repeat(300) }] })?.[0]?.reason)
      .toBe("x".repeat(240));
  });
});
