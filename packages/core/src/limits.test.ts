import { describe, expect, it } from "vitest";
import { parseLimits } from "./limits";

describe("parseLimits", () => {
  it("reads provider windows and banked resets from the stable wire frame", () => {
    expect(
      parseLimits(
        JSON.stringify({
          available: true,
          provider: "anthropic",
          windows: [
            { id: "anthropic:5h", label: "5 hour", percent: 32.5, resetsAtMs: 1_761_700_000_000 },
            { id: "anthropic:week", label: "week", percent: null, resetsAtMs: 1_762_000_000_000 },
          ],
          bankedResets: 2,
          fetchedAtMs: 1_761_600_000_000,
        }),
      ),
    ).toEqual({
      available: true,
      provider: "anthropic",
      windows: [
        { id: "anthropic:5h", label: "5 hour", percent: 32.5, resetsAtMs: 1_761_700_000_000 },
        { id: "anthropic:week", label: "week", percent: null, resetsAtMs: 1_762_000_000_000 },
      ],
      bankedResets: 2,
      fetchedAtMs: 1_761_600_000_000,
    });
  });

  it("keeps the unavailable frame when it carries the reason", () => {
    expect(
      parseLimits(
        JSON.stringify({
          available: false,
          unavailable: "this omp build does not report provider usage",
        }),
      ),
    ).toEqual({
      available: false,
      unavailable: "this omp build does not report provider usage",
      provider: null,
      windows: [],
      bankedResets: 0,
      fetchedAtMs: 0,
    });
  });

  it("drops entries with neither a percent nor a reset time and coerces non-finite numbers", () => {
    const view = parseLimits(
      JSON.stringify({
        available: true,
        provider: "openai",
        windows: [
          { id: "a", label: "5 hour", percent: null, resetsAtMs: null },
          { id: "b", label: "week", percent: Number.NaN, resetsAtMs: 1_762_000_000_000 },
          { id: "c", label: "day", percent: 12, resetsAtMs: Number.POSITIVE_INFINITY },
          { label: "d", percent: "12" },
          "not-an-object",
          { percent: 50 },
        ],
        bankedResets: -3.7,
        fetchedAtMs: "soon",
      }),
    );
    expect(view).toEqual({
      available: true,
      provider: "openai",
      windows: [
        { id: "b", label: "week", percent: null, resetsAtMs: 1_762_000_000_000 },
        { id: "c", label: "day", percent: 12, resetsAtMs: null },
      ],
      bankedResets: 0,
      fetchedAtMs: 0,
    });
  });

  it("falls back to the label for a missing window id", () => {
    const view = parseLimits(
      JSON.stringify({
        available: true,
        provider: null,
        windows: [{ label: "5 hour", percent: 1 }],
        bankedResets: 0,
        fetchedAtMs: 0,
      }),
    );
    expect(view?.windows).toEqual([{ id: "5 hour", label: "5 hour", percent: 1, resetsAtMs: null }]);
    expect(view?.provider).toBeNull();
  });

  it("treats missing, malformed, and reason-less payloads as no snapshot", () => {
    expect(parseLimits(undefined)).toBeNull();
    expect(parseLimits("")).toBeNull();
    expect(parseLimits("not json")).toBeNull();
    expect(parseLimits("[]")).toBeNull();
    // An empty payload is neither available nor a reason — no snapshot at all.
    expect(parseLimits(JSON.stringify({}))).toBeNull();
    expect(parseLimits(JSON.stringify({ available: false }))).toBeNull();
  });
});
