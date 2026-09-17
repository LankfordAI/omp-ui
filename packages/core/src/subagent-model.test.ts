import { describe, expect, it } from "vitest";
import {
  SUBAGENT_MODEL_INHERIT,
  isSafeAgentName,
  isSafeSelector,
  isSubagentModelMap,
  mergeSubagentModelMaps,
  resolveSubagentOverlayEntries,
} from "./subagent-model";

describe("isSafeSelector", () => {
  it("accepts the inherit alias, role aliases, and provider/id[:level] selectors", () => {
    expect(isSafeSelector(SUBAGENT_MODEL_INHERIT)).toBe(true);
    expect(isSafeSelector("@smol")).toBe(true);
    expect(isSafeSelector("openrouter/openai/gpt-5.6-luna:medium")).toBe(true);
    // A colon inside the id (OpenRouter's `:exacto`) is not a level suffix.
    expect(isSafeSelector("openrouter/zai/glm-4.7:exacto")).toBe(true);
  });

  it("rejects whitespace, quotes, YAML indicators, and the empty string", () => {
    expect(isSafeSelector("")).toBe(false);
    expect(isSafeSelector("openai/gpt 5")).toBe(false);
    expect(isSafeSelector("openai/gpt\n5")).toBe(false);
    expect(isSafeSelector('"openai/gpt"')).toBe(false);
    expect(isSafeSelector("openai/gpt # comment")).toBe(false);
    expect(isSafeSelector("gpt")).toBe(false);
    expect(isSafeSelector("@")).toBe(false);
    expect(isSafeSelector("*alias")).toBe(false);
  });
});

describe("isSafeAgentName", () => {
  it("accepts identifier shapes and refuses anything that could not match omp", () => {
    expect(isSafeAgentName("scout")).toBe(true);
    expect(isSafeAgentName("security-reviewer")).toBe(true);
    expect(isSafeAgentName("")).toBe(false);
    expect(isSafeAgentName("my agent")).toBe(false);
    expect(isSafeAgentName("agent:evil")).toBe(false);
    expect(isSafeAgentName("agent\nname")).toBe(false);
  });
});

describe("mergeSubagentModelMaps", () => {
  it("lets the later layer win per key and drops null layers", () => {
    const global = { scout: "@smol", task: "openai/gpt-5" };
    const project = { task: "anthropic/claude-sonnet-4.5" };
    const session = { scout: SUBAGENT_MODEL_INHERIT };
    expect(mergeSubagentModelMaps(global, null, project, session)).toEqual({
      scout: SUBAGENT_MODEL_INHERIT,
      task: "anthropic/claude-sonnet-4.5",
    });
  });

  it("keeps the inherit alias verbatim through the merge", () => {
    expect(mergeSubagentModelMaps({ scout: SUBAGENT_MODEL_INHERIT })).toEqual({
      scout: SUBAGENT_MODEL_INHERIT,
    });
  });
});

describe("isSubagentModelMap", () => {
  it("accepts string maps with safe names and selectors only", () => {
    expect(isSubagentModelMap({ scout: "*" })).toBe(true);
    expect(isSubagentModelMap({})).toBe(true);
    expect(isSubagentModelMap(null)).toBe(false);
    expect(isSubagentModelMap({ scout: 5 })).toBe(false);
    expect(isSubagentModelMap({ "bad name": "*" })).toBe(false);
    expect(isSubagentModelMap({ scout: "not a selector" })).toBe(false);
  });
});

describe("resolveSubagentOverlayEntries", () => {
  it("fills the roster with inherit when the session has no choice and the umbrella is on", () => {
    expect(resolveSubagentOverlayEntries(null, true, ["scout", "task"])).toEqual({
      scout: SUBAGENT_MODEL_INHERIT,
      task: SUBAGENT_MODEL_INHERIT,
    });
  });

  it("emits nothing when the umbrella is off and the session has no choice", () => {
    expect(resolveSubagentOverlayEntries(null, false, ["scout"])).toEqual({});
  });

  it("lets an explicit session map replace the umbrella outright", () => {
    expect(
      resolveSubagentOverlayEntries({ task: "openai/gpt-5" }, true, ["scout", "task"]),
    ).toEqual({ task: "openai/gpt-5" });
  });
});
