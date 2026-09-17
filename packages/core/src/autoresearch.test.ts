import { describe, expect, it } from "vitest";
import {
  AUTORESEARCH_STATUS_BYTE_LIMIT,
  autoresearchArmMessage,
  parseAutoresearchSnapshot,
  type AutoresearchSnapshot,
} from "./autoresearch";

const base: AutoresearchSnapshot = {
  version: 1,
  processKey: "omp-ui-p",
  sessionId: "s1",
  revision: 3,
  available: true,
  unavailable: null,
  mode: "on",
  goal: "faster",
  goalTruncated: false,
  lastTool: { name: "log_experiment", at: 1_700_000_000_000, isError: false },
};

describe("parseAutoresearchSnapshot", () => {
  it("accepts a well-formed snapshot as an object or a JSON string", () => {
    expect(parseAutoresearchSnapshot(base)).toEqual(base);
    expect(parseAutoresearchSnapshot(JSON.stringify(base))).toEqual(base);
  });

  it("accepts the pre-session and unavailable shapes", () => {
    expect(parseAutoresearchSnapshot({ ...base, sessionId: "" })?.sessionId).toBe("");
    expect(
      parseAutoresearchSnapshot({
        ...base,
        available: false,
        unavailable: "sessionManager.getBranch is missing",
        mode: "off",
        goal: null,
        lastTool: null,
      }),
    ).toMatchObject({ available: false, mode: "off", goal: null, lastTool: null });
  });

  it("rejects malformed envelopes", () => {
    expect(parseAutoresearchSnapshot(undefined)).toBeNull();
    expect(parseAutoresearchSnapshot("not json")).toBeNull();
    expect(parseAutoresearchSnapshot([base])).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, version: 2 })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, processKey: "" })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, sessionId: null })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, revision: -1 })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, revision: 1.5 })).toBeNull();
  });

  it("rejects an availability flag that disagrees with its reason", () => {
    expect(parseAutoresearchSnapshot({ ...base, available: false })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, unavailable: "broken" })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, unavailable: 5 })).toBeNull();
  });

  it("rejects unknown modes, goals, and tools", () => {
    expect(parseAutoresearchSnapshot({ ...base, mode: "clear" })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, goal: 7 })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, goalTruncated: "no" })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, lastTool: { ...base.lastTool, name: "read" } })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, lastTool: { ...base.lastTool, at: -1 } })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, lastTool: { ...base.lastTool, isError: "yes" } })).toBeNull();
    expect(parseAutoresearchSnapshot({ ...base, lastTool: "log_experiment" })).toBeNull();
  });

  it("rejects a payload over the byte limit", () => {
    const huge = { ...base, goal: "g".repeat(AUTORESEARCH_STATUS_BYTE_LIMIT) };
    expect(parseAutoresearchSnapshot(huge)).toBeNull();
    expect(parseAutoresearchSnapshot(JSON.stringify(huge))).toBeNull();
  });
});

describe("autoresearchArmMessage", () => {
  it("is the hidden arm slash command", () => {
    expect(autoresearchArmMessage()).toBe("/omp-ui-autoresearch");
  });
});
