import { describe, expect, it } from "vitest";
import { parseApprovalPrompt } from "./approval";

const OPTIONS = ["Approve", "Deny"];

describe("parseApprovalPrompt", () => {
  it("reads the bare one-line title", () => {
    expect(parseApprovalPrompt("Allow tool: Bash", OPTIONS)).toEqual({
      toolName: "Bash",
      origin: null,
      reason: null,
      restrictedFolder: null,
      details: [],
      providerSafety: [],
      sessionLabel: null,
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
      restrictedFolder: null,
      details: ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1 +1 @@"],
      providerSafety: [],
      sessionLabel: null,
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

  it("reads a restricted-folder prompt (omp 18.13.1, issue #951)", () => {
    const prompt = parseApprovalPrompt(
      [
        "Allow tool: read",
        "Reason: Restricted folder: /home/u/secrets",
        "Path: /home/u/secrets/a.txt",
      ].join("\n"),
      OPTIONS,
    );
    expect(prompt).toMatchObject({
      toolName: "read",
      reason: "Restricted folder: /home/u/secrets",
      restrictedFolder: "/home/u/secrets",
      sessionLabel: null,
      details: ["Path: /home/u/secrets/a.txt"],
    });
  });

  it("leaves restrictedFolder null for other reasons and an empty folder", () => {
    const policy = parseApprovalPrompt("Allow tool: read\nReason: policy: x", OPTIONS);
    expect(policy?.reason).toBe("policy: x");
    expect(policy?.restrictedFolder).toBeNull();
    const empty = parseApprovalPrompt("Allow tool: read\nReason: Restricted folder: ", OPTIONS);
    expect(empty?.reason).toBe("Restricted folder: ");
    expect(empty?.restrictedFolder).toBeNull();
  });

  it("accepts object options carrying the same labels", () => {
    const options = [{ label: "Approve" }, { label: "Deny" }];
    expect(parseApprovalPrompt("Allow tool: Bash", options)?.toolName).toBe("Bash");
  });

  it("accepts the 18.11.3 three-option shape, keeping the label verbatim", () => {
    const prompt = parseApprovalPrompt("Allow tool: Bash\nls -la", [
      "Approve",
      "Approve Bash(git *) for this session",
      "Deny",
    ]);
    expect(prompt).toMatchObject({
      toolName: "Bash",
      sessionLabel: "Approve Bash(git *) for this session",
    });
  });

  it("accepts an object-form middle option through the label normalizer", () => {
    const prompt = parseApprovalPrompt("Allow tool: Bash", [
      "Approve",
      { label: "Approve X for this session" },
      "Deny",
    ]);
    expect(prompt?.sessionLabel).toBe("Approve X for this session");
  });

  it("rejects grown or forged option lists — the card is omp's protocol or nothing", () => {
    expect(parseApprovalPrompt("Allow tool: Bash", ["Approve", "Deny", "Always"])).toBeNull();
    expect(parseApprovalPrompt("Allow tool: Bash", ["Deny", "Approve"])).toBeNull();
    expect(parseApprovalPrompt("Allow tool: Bash", ["Approve"])).toBeNull();
    // Middle session label at the wrong index: last option must be Deny.
    expect(
      parseApprovalPrompt("Allow tool: Bash", [
        "Approve",
        "Deny",
        "Approve Bash for this session",
      ]),
    ).toBeNull();
    // Non-matching middle wording.
    expect(parseApprovalPrompt("Allow tool: Bash", ["Approve", "Always", "Deny"])).toBeNull();
    // The regex needs a subject between the spaces.
    expect(
      parseApprovalPrompt("Allow tool: Bash", [
        "Approve",
        "Approve for this session",
        "Deny",
      ]),
    ).toBeNull();
  });

  it("rejects frames without options and titles without the prefix", () => {
    expect(parseApprovalPrompt("Allow tool: Bash", undefined)).toBeNull();
    expect(parseApprovalPrompt("Allow tool: ", OPTIONS)).toBeNull();
    expect(parseApprovalPrompt("Do you want to Allow tool: Bash?", OPTIONS)).toBeNull();
    expect(parseApprovalPrompt(undefined, OPTIONS)).toBeNull();
    expect(parseApprovalPrompt(42, OPTIONS)).toBeNull();
  });
});
