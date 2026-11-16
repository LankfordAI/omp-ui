// Static contract of the issue tools (ADR-0095): schemas are strict object
// roots without root combinators (#1135), the parser enforces per-kind
// requirements naming the field, and the renderer matches the repo templates'
// headings verbatim.
import { describe, expect, it } from "vitest";
import {
  BUG_TAB_MODES,
  DEFAULT_ISSUE_REPOSITORY,
  ISSUE_AREAS,
  ISSUE_BODY_MAX,
  duplicateSearchCommand,
  formatIssueDraftAnswer,
  issueRepositoryOf,
  parseDuplicateRows,
  parseIssueToolArgs,
  renderIssueBody,
  renderIssueTitle,
  type IssueToolArgs,
  type IssueVersionFacts,
} from "./issue-tool";
import { issueDraftTool, issueFileTool } from "./issue-tool";

const FACTS: IssueVersionFacts = { appVersion: "0.9.9", ompVersion: "18.4.3", os: "Linux 7.3.3" };

function bugArgs(overrides: Partial<IssueToolArgs> = {}): Record<string, unknown> {
  return {
    kind: "bug",
    title: "Sidebar drops a session on rename",
    description: "Renaming a session in the sidebar removes it from the list.",
    steps: "1. Open a session\n2. Rename it",
    expected: "The row keeps its new title.",
    actual: "The row vanishes.",
    tabMode: BUG_TAB_MODES[1],
    ...overrides,
  };
}

function featureArgs(overrides: Partial<IssueToolArgs> = {}): Record<string, unknown> {
  return {
    kind: "feature",
    title: "Group sessions by worktree",
    description: "I cannot see which sessions share a worktree.",
    proposal: "The sidebar nests worktree sessions under their base checkout.",
    area: ISSUE_AREAS[0],
    ...overrides,
  };
}

describe("issue tool schemas", () => {
  for (const tool of [issueDraftTool(), issueFileTool()]) {
    it(`${tool.name} is an essential strict object schema without root combinators`, () => {
      expect(tool.loadMode).toBe("essential");
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.additionalProperties).toBe(false);
      for (const key of ["oneOf", "anyOf", "allOf"]) expect(tool.parameters, key).not.toHaveProperty(key);
      expect(tool.parameters.required).toEqual(["kind", "title", "description"]);
    });
  }

  it("both descriptions bind filing to consent-in-session and cross-reference the pairing tool", () => {
    for (const tool of [issueDraftTool(), issueFileTool()]) {
      expect(tool.description).toContain("explicit request");
      expect(tool.description).toContain("this session");
    }
    // The draft points at the only write verb; the file call names the draft
    // it must reproduce — the pairing is in the contract, not just in docs.
    expect(issueDraftTool().description).toContain("omp-ui_issue_file");
    expect(issueFileTool().description).toContain("omp-ui_issue_draft");
  });
});

describe("parseIssueToolArgs", () => {
  it("accepts a complete bug and keeps optionals out", () => {
    const parsed = parseIssueToolArgs(bugArgs());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.tabMode).toBe("rpc-ui / native transcript");
      expect(parsed.args.logs).toBeUndefined();
      expect(parsed.args.repository).toBeUndefined();
    }
  });

  it("names the first missing bug field, one line", () => {
    const args = bugArgs();
    delete args.steps;
    expect(parseIssueToolArgs(args)).toEqual({ ok: false, reason: "steps is required for this kind of issue" });
  });

  it("names the first missing feature field", () => {
    const args = featureArgs();
    delete args.area;
    expect(parseIssueToolArgs(args)).toEqual({ ok: false, reason: "area is required for this kind of issue" });
  });

  it("rejects cross-kind fields by name", () => {
    expect(parseIssueToolArgs(bugArgs({ proposal: "x" }))).toEqual({
      ok: false,
      reason: "proposal belongs to feature issues, not bug",
    });
    expect(parseIssueToolArgs(featureArgs({ tabMode: "Both" }))).toEqual({
      ok: false,
      reason: "tabMode belongs to bug issues, not feature",
    });
    expect(parseIssueToolArgs(featureArgs({ logs: "boom" })).ok).toBe(false);
  });

  it("refuses an unknown field", () => {
    expect(parseIssueToolArgs(bugArgs({ extra: 1 } as never))).toEqual({
      ok: false,
      reason: "unknown field extra",
    });
  });

  it("enforces the exact template dropdown strings", () => {
    expect(parseIssueToolArgs(bugArgs({ tabMode: "terminal" as never })).ok).toBe(false);
    expect(parseIssueToolArgs(featureArgs({ area: "Sidebar" as never })).ok).toBe(false);
    for (const mode of BUG_TAB_MODES) expect(parseIssueToolArgs(bugArgs({ tabMode: mode })).ok).toBe(true);
    for (const area of ISSUE_AREAS) expect(parseIssueToolArgs(featureArgs({ area })).ok).toBe(true);
  });

  it("normalizes the title prefix so titles never double-prefix", () => {
    const parsed = parseIssueToolArgs(bugArgs({ title: "[Bug]: Sidebar drops" }));
    expect(parsed.ok && parsed.args.title).toBe("Sidebar drops");
    expect(renderIssueTitle((parsed as { ok: true; args: IssueToolArgs }).args)).toBe("[Bug]: Sidebar drops");
  });

  it("caps the title and each section", () => {
    expect(parseIssueToolArgs(bugArgs({ title: "x".repeat(201) })).ok).toBe(false);
    expect(parseIssueToolArgs(bugArgs({ steps: "x".repeat(16_001) })).ok).toBe(false);
  });

  it("requires an owner/repo pattern and rejects control characters in single-line fields", () => {
    expect(parseIssueToolArgs(bugArgs({ repository: "a/b" })).ok).toBe(true);
    expect(parseIssueToolArgs(bugArgs({ repository: DEFAULT_ISSUE_REPOSITORY })).ok).toBe(true);
    expect(parseIssueToolArgs(bugArgs({ repository: "nope" })).ok).toBe(false);
    expect(parseIssueToolArgs(bugArgs({ repository: "a/b\ncd" }))).toEqual({
      ok: false,
      reason: "repository must be a single-line owner/repo string",
    });
    expect(parseIssueToolArgs(bugArgs({ title: "line one\nline two" })).ok).toBe(false);
  });

  it("allows newlines and tabs in free text, normalizes CRLF, and refuses other control characters", () => {
    const parsed = parseIssueToolArgs(bugArgs({ steps: "1. a\r\n2. b\ttabbed" }));
    expect(parsed.ok && parsed.args.steps).toBe("1. a\n2. b\ttabbed");
    expect(parseIssueToolArgs(bugArgs({ expected: "a\u0000b" })).ok).toBe(false);
    expect(parseIssueToolArgs(bugArgs({ actual: "a\u0007b" })).ok).toBe(false);
  });
});

describe("renderIssueBody", () => {
  it("emits the bug template's headings verbatim, in template order, with host facts once", () => {
    const body = renderIssueBody(parseIssueToolArgs(bugArgs()).args as never, FACTS);
    expect(body.match(/^## (.*)$/gm)).toEqual([
      "## Description",
      "## Steps to reproduce",
      "## Expected behavior",
      "## Actual behavior",
      "## Tab mode",
      "## omp-ui version / commit",
      "## omp version",
      "## OS",
    ]);
    expect(body).toContain("0.9.9");
    expect(body).toContain("18.4.3");
    expect(body).toContain("Linux 7.3.3");
    // The facts block appears exactly once even when agent prose repeats versions.
    const withProse = renderIssueBody(
      parseIssueToolArgs(bugArgs({ description: "On 0.9.9 and omp 1.2.3 it breaks." })).args as never,
      FACTS,
    );
    expect(withProse.match(/^## omp-ui version \/ commit$/gm)).toHaveLength(1);
    expect(withProse).toContain("0.9.9");
    expect(withProse.split("omp-ui version / commit")).toHaveLength(2);
  });

  it("prints unknown for a null omp version", () => {
    const body = renderIssueBody(parseIssueToolArgs(bugArgs()).args as never, { ...FACTS, ompVersion: null });
    expect(body).toContain("## omp version\n\nunknown");
  });

  it("fences logs as shell only when non-empty", () => {
    const withLogs = renderIssueBody(parseIssueToolArgs(bugArgs({ logs: "boom at 3" })).args as never, FACTS);
    expect(withLogs).toContain("## Logs / output\n\n```shell\nboom at 3\n```");
    const blank = renderIssueBody(parseIssueToolArgs(bugArgs({ logs: "   " })).args as never, FACTS);
    expect(blank).not.toContain("Logs / output");
  });

  it("emits the feature template's headings and omits absent optionals", () => {
    const plain = renderIssueBody(parseIssueToolArgs(featureArgs()).args as never, FACTS);
    expect(plain.match(/^## (.*)$/gm)).toEqual([
      "## Problem / motivation",
      "## Proposed solution",
      "## Area",
    ]);
    expect(plain).not.toContain("omp-ui version");
    const full = renderIssueBody(
      parseIssueToolArgs(featureArgs({ alternatives: "A DR covers it", context: "see #1" })).args as never,
      FACTS,
    );
    expect(full.match(/^## (.*)$/gm)).toEqual([
      "## Problem / motivation",
      "## Proposed solution",
      "## Area",
      "## Alternatives considered",
      "## Additional context",
    ]);
  });
});

describe("issueRepositoryOf", () => {
  it("defaults the repository", () => {
    expect(issueRepositoryOf(parseIssueToolArgs(bugArgs()).args as never)).toBe(DEFAULT_ISSUE_REPOSITORY);
    expect(issueRepositoryOf(parseIssueToolArgs(bugArgs({ repository: "other/repo" })).args as never)).toBe("other/repo");
  });
});

describe("duplicate search helpers", () => {
  it("searches up to the 6 longest title words in title order", () => {
    expect(duplicateSearchCommand("r/x", "Sidebar drops a session on rename loudly")[5]).toBe(
      "Sidebar drops session on rename loudly",
    );
    const args = duplicateSearchCommand("r/x", "one");
    expect(args.slice(0, 2)).toEqual(["issue", "list"]);
    expect(args).toContain("--json");
    expect(args.at(-1)).toBe("number,title,state,url");
  });

  it("caps long titles at six words", () => {
    expect(duplicateSearchCommand("r/x", "alpha beta gamma delta epsilon zeta eta theta")[5].split(" ")).toHaveLength(6);
  });

  it("tolerates malformed rows: a bad row drops only itself", () => {
    const rows = parseDuplicateRows(
      JSON.stringify([
        { number: 1, title: "ok", state: "OPEN", url: "https://x/1" },
        { number: "two", title: "bad", state: "OPEN", url: "u" },
        null,
        { number: 3, title: "also ok", state: "CLOSED", url: "https://x/3" },
      ]),
    );
    expect(rows.map((row) => row.number)).toEqual([1, 3]);
    expect(parseDuplicateRows("not json")).toEqual([]);
    expect(parseDuplicateRows("{}")).toEqual([]);
  });
});

describe("formatIssueDraftAnswer", () => {
  it("renders duplicates and the consent sentence", () => {
    const text = formatIssueDraftAnswer("r/x", "[Bug]: t", "body", [{ number: 7, title: "dup", state: "OPEN", url: "u" }], null);
    expect(text).toContain("#7 [OPEN] dup — u");
    expect(text).toContain("report it and stop");
    expect(text).toContain("omp-ui_issue_file");
  });

  it("keeps the draft honest when the search failed", () => {
    const text = formatIssueDraftAnswer("r/x", "[Bug]: t", "body", null, "gh is not authenticated");
    expect(text).toContain("duplicate search unavailable (gh is not authenticated)");
    expect(text).toContain("Body:");
  });

  it("respects the body cap constant the bridge enforces", () => {
    expect(ISSUE_BODY_MAX).toBe(64_000);
  });
});
