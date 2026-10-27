import { describe, expect, it } from "vitest";
import { approvalReply, parseApprovalPrompt, type ApprovalPrompt } from "./approval";

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
      grants: [],
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
      grants: [],
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

  it("reads folder and file grants (5 options) in omp's order", () => {
    const prompt = parseApprovalPrompt("Allow tool: Read\nReason: target not yet approved", [
      "Approve Directory: /home/me/my proj",
      "Approve File",
      "Always Approve Directory: /home/me/my proj",
      "Always Approve File",
      "Approve Once",
      "Deny",
    ]);
    expect(prompt).toMatchObject({
      toolName: "Read",
      reason: "target not yet approved",
      sessionLabel: null,
      grants: [
        {
          scope: "folder",
          label: "Approve Directory: /home/me/my proj",
          alwaysLabel: "Always Approve Directory: /home/me/my proj",
        },
        { scope: "target", label: "Approve File", alwaysLabel: "Always Approve File" },
      ],
    });
  });

  it("reads a bare Approve target grant (4 options) because Approve Once is located first", () => {
    const prompt = parseApprovalPrompt("Allow tool: Bash", [
      "Approve",
      "Always Approve",
      "Approve Once",
      "Deny",
    ]);
    expect(prompt?.grants).toEqual([
      { scope: "target", label: "Approve", alwaysLabel: "Always Approve" },
    ]);
    expect(prompt?.sessionLabel).toBeNull();
  });

  it("accepts grants together with a session label (6 options)", () => {
    const prompt = parseApprovalPrompt("Allow tool: Edit", [
      "Approve Directory: /src",
      "Approve File",
      "Always Approve Directory: /src",
      "Always Approve File",
      "Approve Once",
      "Approve Edit for this session",
      "Deny",
    ]);
    expect(prompt?.grants.map((g) => g.scope)).toEqual(["folder", "target"]);
    expect(prompt?.sessionLabel).toBe("Approve Edit for this session");
  });

  it("accepts object-form grant options through the label normalizer", () => {
    const prompt = parseApprovalPrompt("Allow tool: Read", [
      { label: "Approve File" },
      { value: "Always Approve File" },
      { label: "Approve Once" },
      "Deny",
    ]);
    expect(prompt?.grants).toEqual([
      { scope: "target", label: "Approve File", alwaysLabel: "Always Approve File" },
    ]);
  });

  it("rejects malformed grant shapes", () => {
    const reject = (options: unknown[]) =>
      expect(parseApprovalPrompt("Allow tool: Read", options)).toBeNull();
    // Mismatched folder always pair.
    reject(["Approve Directory: /a", "Always Approve Directory: /b", "Approve Once", "Deny"]);
    // Odd pair count before Approve Once.
    reject(["Approve File", "Always Approve File", "Approve", "Approve Once", "Deny"]);
    // Target before folder.
    reject([
      "Approve File",
      "Approve Directory: /a",
      "Always Approve File",
      "Always Approve Directory: /a",
      "Approve Once",
      "Deny",
    ]);
    // Duplicate scope.
    reject([
      "Approve Directory: /a",
      "Approve Directory: /b",
      "Always Approve Directory: /a",
      "Always Approve Directory: /b",
      "Approve Once",
      "Deny",
    ]);
    // Three pairs.
    reject([
      "Approve Directory: /a",
      "Approve File",
      "Approve",
      "Always Approve Directory: /a",
      "Always Approve File",
      "Always Approve",
      "Approve Once",
      "Deny",
    ]);
    // Unknown grant wording.
    reject(["Approve Folder", "Always Approve Folder", "Approve Once", "Deny"]);
    // No grants before Approve Once.
    reject(["Approve Once", "Deny"]);
    // Two labels after Approve Once.
    reject([
      "Approve File",
      "Always Approve File",
      "Approve Once",
      "Approve X for this session",
      "Approve Y for this session",
      "Deny",
    ]);
  });
});

describe("approvalReply", () => {
  const base: ApprovalPrompt = {
    toolName: "Read",
    origin: null,
    reason: null,
    details: [],
    providerSafety: [],
    sessionLabel: null,
    grants: [],
    restrictedFolder: null,
  };
  const granted: ApprovalPrompt = {
    ...base,
    grants: [
      {
        scope: "folder",
        label: "Approve Directory: /a",
        alwaysLabel: "Always Approve Directory: /a",
      },
    ],
  };

  it("answers once with Approve Once when grants exist and Approve otherwise", () => {
    expect(approvalReply(granted, "once")).toBe("Approve Once");
    expect(approvalReply(base, "once")).toBe("Approve");
    expect(approvalReply(base, "deny")).toBe("Deny");
  });

  it("echoes the grant's label or always-label verbatim", () => {
    expect(approvalReply(granted, { grant: "folder", always: false })).toBe("Approve Directory: /a");
    expect(approvalReply(granted, { grant: "folder", always: true })).toBe(
      "Always Approve Directory: /a",
    );
  });

  it("returns null for a choice the frame does not offer", () => {
    expect(approvalReply(granted, { grant: "target", always: false })).toBeNull();
    expect(approvalReply(base, "session")).toBeNull();
    expect(approvalReply({ ...base, sessionLabel: "Approve X for this session" }, "session")).toBe(
      "Approve X for this session",
    );
  });
});
