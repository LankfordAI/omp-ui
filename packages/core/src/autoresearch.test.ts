import { describe, expect, it } from "vitest";
import {
  AUTORESEARCH_GOAL_CHAR_LIMIT,
  AUTORESEARCH_STATUS_BYTE_LIMIT,
  autoresearchArmMessage,
  experimentLaunchedValue,
  EXPERIMENT_BRIEF_CHAR_LIMIT,
  EXPERIMENT_LIST_ENTRY_CHAR_LIMIT,
  EXPERIMENT_PROPOSAL_LAUNCHED_PREFIX,
  EXPERIMENT_PROPOSAL_SENTINEL,
  parseExperimentProposal,
  parseExperimentProposalTitle,
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
  proposeUnavailable: null,
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

  it("reads proposeUnavailable tolerantly across bridge versions", () => {
    const { proposeUnavailable: _drop, ...predates } = base;
    expect(parseAutoresearchSnapshot(predates)?.proposeUnavailable).toBeNull();
    expect(
      parseAutoresearchSnapshot({ ...base, proposeUnavailable: "pi.registerTool is missing" })?.proposeUnavailable,
    ).toBe("pi.registerTool is missing");
    expect(parseAutoresearchSnapshot({ ...base, proposeUnavailable: 7 })?.proposeUnavailable).toBeNull();
  });
});

describe("autoresearchArmMessage", () => {
  it("is the hidden arm slash command", () => {
    expect(autoresearchArmMessage()).toBe("/omp-ui-autoresearch");
  });
});

describe("parseExperimentProposal / parseExperimentProposalTitle", () => {
  const proposal = {
    goal: "Cut p95 render latency",
    metric: "p95_ms",
    unit: "ms",
    direction: "lower",
    command: "node bench.js",
    scopePaths: ["src/render"],
    offLimits: ["src/db"],
    constraints: ["no new deps"],
    maxIterations: 12,
    brief: "bench.js prints METRIC p95_ms=...",
  };

  it("round-trips a full payload through the sentinel title", () => {
    const title = EXPERIMENT_PROPOSAL_SENTINEL + JSON.stringify(proposal);
    expect(parseExperimentProposalTitle(title)).toEqual(proposal);
    expect(parseExperimentProposal(proposal)).toEqual(proposal);
  });

  it("accepts the minimal shape with nulls and empty lists", () => {
    const minimal = {
      goal: "faster",
      metric: "t",
      unit: "",
      direction: "higher",
      command: null,
      scopePaths: [],
      offLimits: [],
      constraints: [],
      maxIterations: null,
      brief: null,
    };
    expect(parseExperimentProposal(minimal)).toEqual(minimal);
  });

  it("returns null for a title that is not a proposal", () => {
    expect(parseExperimentProposalTitle(undefined)).toBeNull();
    expect(parseExperimentProposalTitle("Run this?")).toBeNull();
    expect(parseExperimentProposalTitle(EXPERIMENT_PROPOSAL_SENTINEL + "not json")).toBeNull();
  });

  it("rejects what the METRIC line or the form cannot carry", () => {
    expect(parseExperimentProposal({ ...proposal, metric: "p95 ms" })).toBeNull();
    expect(parseExperimentProposal({ ...proposal, direction: "up" })).toBeNull();
    expect(parseExperimentProposal({ ...proposal, goal: "   " })).toBeNull();
    expect(parseExperimentProposal({ ...proposal, goal: "g".repeat(AUTORESEARCH_GOAL_CHAR_LIMIT + 1) })).toBeNull();
    expect(parseExperimentProposal({ ...proposal, scopePaths: [1] })).toBeNull();
    expect(parseExperimentProposal({ ...proposal, offLimits: Array.from({ length: 33 }, (_, i) => `p${i}`) })).toBeNull();
    expect(parseExperimentProposal({ ...proposal, constraints: ["c".repeat(EXPERIMENT_LIST_ENTRY_CHAR_LIMIT + 1)] })).toBeNull();
    expect(parseExperimentProposal({ ...proposal, maxIterations: 0 })).toBeNull();
    expect(parseExperimentProposal({ ...proposal, maxIterations: 1.5 })).toBeNull();
    expect(parseExperimentProposal({ ...proposal, brief: "b".repeat(EXPERIMENT_BRIEF_CHAR_LIMIT + 1) })).toBeNull();
    expect(parseExperimentProposal({ ...proposal, command: "" })).toBeNull();
    expect(parseExperimentProposal(null)).toBeNull();
    expect(parseExperimentProposal(proposal.goal)).toBeNull();
  });

  it("trims the goal on the way through", () => {
    expect(parseExperimentProposal({ ...proposal, goal: "  faster  " })?.goal).toBe("faster");
  });
});

describe("experimentLaunchedValue", () => {
  it("encodes an answer the shared parser reads back with the branch", () => {
    const launched = {
      goal: "faster",
      metric: "t",
      unit: "ms",
      direction: "lower" as const,
      command: null,
      scopePaths: [],
      offLimits: [],
      constraints: [],
      maxIterations: null,
      brief: null,
      branch: "autoresearch/faster/abcd1234",
    };
    const value = experimentLaunchedValue(launched);
    expect(value.startsWith(EXPERIMENT_PROPOSAL_LAUNCHED_PREFIX)).toBe(true);
    const encoded = JSON.parse(value.slice(EXPERIMENT_PROPOSAL_LAUNCHED_PREFIX.length));
    // The shared parser is the proposal contract; branch is the extension's extra leg.
    expect(parseExperimentProposal(encoded)).toEqual({ ...launched, branch: undefined } as never);
    expect(encoded.branch).toBe("autoresearch/faster/abcd1234");
    const noBranch = JSON.parse(
      experimentLaunchedValue({ ...launched, branch: null }).slice(EXPERIMENT_PROPOSAL_LAUNCHED_PREFIX.length),
    );
    expect(parseExperimentProposal(noBranch)).not.toBeNull();
    expect(noBranch.branch).toBeNull();
  });
});
