import { describe, expect, it } from "vitest";
import { parseApprovalPrompt } from "./approval";

const OPTIONS = ["Approve", "Deny"];

describe("parseApprovalPrompt", () => {
  it("reads the bare one-line title", () => {
    expect(parseApprovalPrompt("Allow tool: Bash", OPTIONS)).toEqual({
      toolName: "Bash",
      origin: null,
      reason: null,
      details: [],
      providerSafety: [],
    });
  });

  it("reads origin, reason, and detail lines", () => {
    const prompt = parseApprovalPrompt(
      [
        "Allow tool: Edit",
        "Origin: MCP server tool",
        "Reason: policy: edits need a person",
        "--- a/src/x.ts",
        "+++ b/src/x.ts",
        "@@ -1 +1 @@",
      ].join("\n"),
      OPTIONS,
    );
    expect(prompt).toEqual({
      toolName: "Edit",
      origin: "mcp",
      reason: "policy: edits need a person",
      details: ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1 +1 @@"],
      providerSafety: [],
    });
  });

  it("splits the provider-safety block at its sentinel line", () => {
    const prompt = parseApprovalPrompt(
      [
        "Allow tool: WebSearch",
        "query: thing",
        "Provider safety checks:",
        "  - injection scan: passed",
        "  - grounding: unknown",
      ].join("\n"),
      OPTIONS,
    );
    expect(prompt?.details).toEqual(["query: thing"]);
    expect(prompt?.providerSafety).toEqual([
      "  - injection scan: passed",
      "  - grounding: unknown",
    ]);
  });

  it("folds a multi-line reason's continuation lines into details", () => {
    const prompt = parseApprovalPrompt(
      ["Allow tool: Bash", "Reason: because", "more of the reason", "ls -la"].join("\n"),
      OPTIONS,
    );
    expect(prompt?.reason).toBe("because");
    expect(prompt?.details).toEqual(["more of the reason", "ls -la"]);
  });

  it("accepts object options carrying the same labels", () => {
    const options = [{ label: "Approve" }, { label: "Deny" }];
    expect(parseApprovalPrompt("Allow tool: Bash", options)?.toolName).toBe("Bash");
  });

  it("rejects a grown option list — the card is omp's protocol or nothing", () => {
    expect(parseApprovalPrompt("Allow tool: Bash", ["Approve", "Deny", "Always"])).toBeNull();
    expect(parseApprovalPrompt("Allow tool: Bash", ["Deny", "Approve"])).toBeNull();
    expect(parseApprovalPrompt("Allow tool: Bash", ["Approve"])).toBeNull();
  });

  it("rejects frames without options and titles without the prefix", () => {
    expect(parseApprovalPrompt("Allow tool: Bash", undefined)).toBeNull();
    expect(parseApprovalPrompt("Allow tool: ", OPTIONS)).toBeNull();
    expect(parseApprovalPrompt("Do you want to Allow tool: Bash?", OPTIONS)).toBeNull();
    expect(parseApprovalPrompt(undefined, OPTIONS)).toBeNull();
    expect(parseApprovalPrompt(42, OPTIONS)).toBeNull();
  });
});
