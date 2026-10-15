import { describe, expect, it } from "vitest";
import { emptySpendTotals, parseSessionSpendSnapshot, sessionSpendArmMessage } from "./session-spend";

function totals(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cost: 0.25,
    input: 1_000,
    output: 200,
    reasoning: 50,
    cacheRead: 300,
    cacheWrite: 10,
    totalTokens: 1_510,
    premiumRequests: 0,
    requests: 4,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    processKey: "omp-ui-mc0abcd-xyz",
    revision: 2,
    available: true,
    unavailable: null,
    sessionFile: "/tmp/sessions/root.jsonl",
    main: totals(),
    subagents: totals({ cost: 0.5 }),
    total: totals({ cost: 0.75 }),
    transcripts: 1,
    ...overrides,
  };
}

const parse = (value: Record<string, unknown>) => parseSessionSpendSnapshot(JSON.stringify(value));

describe("parseSessionSpendSnapshot", () => {
  it("parses a valid snapshot", () => {
    const parsed = parse(snapshot());
    expect(parsed).not.toBeNull();
    expect(parsed?.total.cost).toBe(0.75);
    expect(parsed?.subagents.cost).toBe(0.5);
    expect(parsed?.sessionFile).toBe("/tmp/sessions/root.jsonl");
    expect(parsed?.transcripts).toBe(1);
  });

  it("parses an unavailable snapshot with null session file", () => {
    const parsed = parse(
      snapshot({
        available: false,
        unavailable: "this session is not persisted",
        sessionFile: null,
        main: emptySpendTotals(),
        subagents: emptySpendTotals(),
        total: emptySpendTotals(),
        transcripts: 0,
      }),
    );
    expect(parsed?.available).toBe(false);
    expect(parsed?.unavailable).toBe("this session is not persisted");
  });

  it.each([
    ["a negative cost", snapshot({ total: totals({ cost: -1 }) })],
    ["a NaN token count (serialized as null)", snapshot({ main: totals({ totalTokens: Number.NaN }) })],
    ["a missing totals field", snapshot({ subagents: { cost: 0 } })],
    ["revision 0", snapshot({ revision: 0 })],
    ["a fractional revision", snapshot({ revision: 1.5 })],
    ["version 2", snapshot({ version: 2 })],
    ["an empty processKey", snapshot({ processKey: "" })],
    ["a non-boolean available", snapshot({ available: "yes" })],
    ["a numeric sessionFile", snapshot({ sessionFile: 3 })],
    ["a numeric unavailable", snapshot({ unavailable: 3 })],
    ["a negative transcripts count", snapshot({ transcripts: -1 })],
  ])("rejects %s", (_label, value) => {
    expect(parse(value)).toBeNull();
  });

  it("rejects non-object and non-JSON text", () => {
    expect(parseSessionSpendSnapshot(undefined)).toBeNull();
    expect(parseSessionSpendSnapshot("not json")).toBeNull();
    expect(parseSessionSpendSnapshot("[1]")).toBeNull();
  });

  it("arms through the hidden command", () => {
    expect(sessionSpendArmMessage()).toBe("/omp-ui-session-spend");
  });
});
