import { describe, expect, it } from "vitest";
import {
  findSubagentControlResult,
  parseSubagentControlSnapshot,
  SUBAGENT_CONTROL_ARG_PREFIX,
  SUBAGENT_CONTROL_ARM_PREFIX,
  SUBAGENT_CONTROL_COMMAND,
  SUBAGENT_CONTROL_STATUS_KEY,
  subagentControlArmMessage,
  subagentControlMessage,
  type SubagentControlSnapshot,
} from "./subagent-control";

const RESULT = {
  requestId: "r-1",
  agentId: "agent-1",
  action: "kill" as const,
  ok: true,
  at: 1_700_000_000_000,
};

const VALID: SubagentControlSnapshot = {
  available: true,
  processKey: "omp-ui-abc-123",
  revision: 4,
  results: [RESULT],
};

describe("subagentControl messages", () => {
  it("arms with the bare command", () => {
    expect(subagentControlArmMessage()).toBe("/" + SUBAGENT_CONTROL_COMMAND);
    expect(SUBAGENT_CONTROL_ARM_PREFIX).toBe(SUBAGENT_CONTROL_COMMAND + " arm");
  });

  it("carries one strict envelope per verb", () => {
    const message = subagentControlMessage({
      requestId: "r-2",
      agentId: "agent-9",
      action: "steer",
      text: "check the tests",
    });
    expect(message.startsWith("/" + SUBAGENT_CONTROL_ARG_PREFIX)).toBe(true);
    expect(JSON.parse(message.slice(1 + SUBAGENT_CONTROL_ARG_PREFIX.length))).toEqual({
      v: 1,
      request: { requestId: "r-2", agentId: "agent-9", action: "steer", text: "check the tests" },
    });
  });
});

describe("parseSubagentControlSnapshot", () => {
  it("reads a complete available snapshot", () => {
    expect(parseSubagentControlSnapshot(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("reads an unavailable snapshot with its reason", () => {
    const text = JSON.stringify({
      available: false,
      reason: "missing-api",
      processKey: "p",
      revision: 0,
      results: [],
    });
    expect(parseSubagentControlSnapshot(text)).toEqual({
      available: false,
      reason: "missing-api",
      processKey: "p",
      revision: 0,
      results: [],
    });
  });

  it("keeps a result's error sentence verbatim", () => {
    const snapshot = parseSubagentControlSnapshot(
      JSON.stringify({
        ...VALID,
        results: [
          {
            requestId: "r-3",
            agentId: "a",
            action: "revive",
            ok: false,
            error: 'Cannot revive subagent "a": no persisted session contract.',
            at: 1,
          },
        ],
      }),
    );
    expect(snapshot?.results[0]?.error).toContain("no persisted session contract");
  });

  it("rejects every malformed frame", () => {
    expect(parseSubagentControlSnapshot(undefined)).toBeNull();
    expect(parseSubagentControlSnapshot("{not json")).toBeNull();
    expect(parseSubagentControlSnapshot("[1,2]")).toBeNull();
    expect(parseSubagentControlSnapshot(JSON.stringify({ ...VALID, available: "yes" }))).toBeNull();
    expect(parseSubagentControlSnapshot(JSON.stringify({ ...VALID, processKey: "" }))).toBeNull();
    expect(parseSubagentControlSnapshot(JSON.stringify({ ...VALID, revision: -1 }))).toBeNull();
    expect(
      parseSubagentControlSnapshot(JSON.stringify({ ...VALID, revision: 1.5 })),
    ).toBeNull();
    expect(parseSubagentControlSnapshot(JSON.stringify({ ...VALID, results: {} }))).toBeNull();
    expect(
      parseSubagentControlSnapshot(
        JSON.stringify({ ...VALID, results: [{ ...RESULT, action: "nap" }] }),
      ),
    ).toBeNull();
    expect(
      parseSubagentControlSnapshot(
        JSON.stringify({ ...VALID, results: [{ ...RESULT, requestId: "" }] }),
      ),
    ).toBeNull();
    expect(
      parseSubagentControlSnapshot(
        JSON.stringify({ ...VALID, results: [{ ...RESULT, at: Number.NaN }] }),
      ),
    ).toBeNull();
    expect(parseSubagentControlSnapshot(JSON.stringify({ ...VALID, reason: "shrug" }))).toBeNull();
    // Over-budget: the whole frame is rejected, the last good snapshot stands.
    expect(
      parseSubagentControlSnapshot(
        JSON.stringify({ ...VALID, results: [{ ...RESULT, error: "x".repeat(70 * 1024) }] }),
      ),
    ).toBeNull();
  });

  it("STATUS_KEY names the channel", () => {
    expect(SUBAGENT_CONTROL_STATUS_KEY).toBe("omp-ui:subagent-control");
  });
});

describe("findSubagentControlResult", () => {
  it("finds the newest match and nothing else", () => {
    const snapshot: SubagentControlSnapshot = {
      ...VALID,
      results: [
        { ...RESULT, requestId: "r-1" },
        { ...RESULT, requestId: "r-2", ok: false },
        { ...RESULT, requestId: "r-1", ok: false, action: "steer" },
      ],
    };
    expect(findSubagentControlResult(snapshot, "r-1")).toEqual({
      ...RESULT,
      ok: false,
      action: "steer",
    });
    expect(findSubagentControlResult(snapshot, "r-3")).toBeUndefined();
    expect(findSubagentControlResult(null, "r-1")).toBeUndefined();
  });
});
