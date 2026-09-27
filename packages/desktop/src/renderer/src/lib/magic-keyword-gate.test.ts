import { describe, expect, it } from "vitest";
import type {
  CapabilityMagicKeyword,
  CapabilitySnapshot,
  CapabilityTool,
} from "@omp-ui/core/capabilities";
import { ALL_MAGIC_KEYWORDS } from "@omp-ui/core/magic-keywords";
import { firingKeywords, keywordsOffInSettings } from "./magic-keyword-gate";

const KEYWORDS: CapabilityMagicKeyword[] = [
  { id: "ultrathink", word: "ultrathink", requires: [], enabled: true },
  { id: "orchestrate", word: "orchestrate", requires: ["task"], enabled: true },
  { id: "workflow", word: "workflowz", requires: ["task", "eval"], enabled: true },
  { id: "jevify", word: "jevify", requires: ["eval"], enabled: true },
];

function tool(name: string, enabled: boolean | null): CapabilityTool {
  return {
    name,
    description: "",
    descriptionTruncated: false,
    source: "builtin",
    sourcePath: null,
    enabled,
    direct: null,
    xdev: null,
    evalBridge: null,
    mcpServerName: null,
    mcpToolName: null,
  };
}

function snapshot(
  keywords: CapabilityMagicKeyword[],
  tools: CapabilityTool[],
): CapabilitySnapshot {
  return {
    version: 1,
    processKey: "proc-1",
    sessionId: "s-1",
    revision: 1,
    updatedAt: 0,
    ompVersion: null,
    skillCommandsEnabled: null,
    skills: { status: "available", items: [] },
    tools: { status: "available", items: tools },
    magicKeywords: { status: "available", items: keywords },
    toolControl: "available",
    toolMutation: null,
  };
}

const ALL_TOOLS = [tool("read", true), tool("bash", true), tool("task", true), tool("eval", true)];

describe("firingKeywords", () => {
  it("returns every known keyword when there is no snapshot", () => {
    expect(firingKeywords(null)).toBe(ALL_MAGIC_KEYWORDS);
  });

  it("returns every known keyword when the section is unavailable", () => {
    const snap = snapshot(KEYWORDS, ALL_TOOLS);
    snap.magicKeywords = { status: "unavailable", reason: "missing-api" };
    expect(firingKeywords(snap)).toBe(ALL_MAGIC_KEYWORDS);
  });

  it("drops a keyword whose omp setting is off", () => {
    const snap = snapshot(
      KEYWORDS.map((k) => (k.id === "orchestrate" ? { ...k, enabled: false } : k)),
      ALL_TOOLS,
    );
    expect([...firingKeywords(snap)]).toEqual(["ultrathink", "workflowz", "jevify"]);
  });

  it("drops keywords whose required tools are not enabled", () => {
    const snap = snapshot(KEYWORDS, [tool("read", true), tool("bash", true), tool("task", true)]);
    expect([...firingKeywords(snap)]).toEqual(["ultrathink", "orchestrate"]);
    const evalOnly = snapshot(KEYWORDS, [
      tool("read", true),
      tool("bash", true),
      tool("eval", true),
    ]);
    expect([...firingKeywords(evalOnly)]).toEqual(["ultrathink", "jevify"]);
  });

  it("ignores tool requirements when any membership is unknown", () => {
    const snap = snapshot(KEYWORDS, [tool("read", true), tool("task", null)]);
    expect([...firingKeywords(snap)]).toEqual(["ultrathink", "orchestrate", "workflowz", "jevify"]);
  });

  it("ignores a published word the port does not know", () => {
    const snap = snapshot(
      [...KEYWORDS, { id: "future", word: "futureword", requires: [], enabled: true }],
      ALL_TOOLS,
    );
    expect([...firingKeywords(snap)]).toEqual(["ultrathink", "orchestrate", "workflowz", "jevify"]);
  });
});

describe("keywordsOffInSettings", () => {
  it("reports only rows explicitly off", () => {
    const snap = snapshot(
      KEYWORDS.map((k) => (k.id === "workflow" ? { ...k, enabled: false } : k)),
      ALL_TOOLS,
    );
    expect([...keywordsOffInSettings(snap)]).toEqual(["workflowz"]);
  });

  it("is empty without a snapshot or with an unavailable section", () => {
    expect(keywordsOffInSettings(null).size).toBe(0);
    const snap = snapshot(KEYWORDS, ALL_TOOLS);
    snap.magicKeywords = { status: "unavailable", reason: "read-failed" };
    expect(keywordsOffInSettings(snap).size).toBe(0);
  });

  it("ignores unknown words", () => {
    const snap = snapshot(
      [{ id: "future", word: "futureword", requires: [], enabled: false }],
      ALL_TOOLS,
    );
    expect(keywordsOffInSettings(snap).size).toBe(0);
  });
});
