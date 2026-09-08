import { describe, expect, it } from "vitest";
import {
  comparePlanDiagnostics,
  encodePlanPreflightReply,
  isHtmlPlanPath,
  isPlanArtifactPath,
  limitPlanPreflightResult,
  parsePlanPreflightReply,
  parsePlanPreflightResult,
  parsePlanReviewTitle,
  planMessage,
  parsePlanStatus,
  PLAN_DIAGNOSTIC_LIMIT,
  PLAN_EXCERPT_LIMIT,
  PLAN_MESSAGE_LIMIT,
  PLAN_PREFLIGHT_REPLY_LIMIT,
  PLAN_PREFLIGHT_RESULT_PREFIX,
  PLAN_REVIEW_SENTINEL,
  type PlanDiagnostic,
  type PlanPreflightResult,
} from "./plan";

describe("planMessage", () => {
  it("builds the literal html, markdown, and off commands", () => {
    expect(planMessage(true, "html")).toBe("/omp-ui-plan on html");
    expect(planMessage(true, "md")).toBe("/omp-ui-plan on md");
    expect(planMessage(false, "html")).toBe("/omp-ui-plan off");
    expect(planMessage(false, "md")).toBe("/omp-ui-plan off");
  });
});

describe("parsePlanStatus", () => {
  it("reads a published status", () => {
    expect(
      parsePlanStatus(
        JSON.stringify({
          enabled: true,
          planFilePath: "local://a-plan.md",
          planAbsPath: "/l/local/a-plan.md",
          approved: false,
        }),
      ),
    ).toEqual({
      enabled: true,
      planFilePath: "local://a-plan.md",
      planAbsPath: "/l/local/a-plan.md",
      approved: false,
      unavailable: undefined,
    });
  });

  it("carries the unavailable reason so the UI can disable the toggle", () => {
    const status = parsePlanStatus(
      JSON.stringify({ enabled: false, unavailable: "omp session is missing: setPlanModeState" }),
    );
    expect(status?.unavailable).toBe("omp session is missing: setPlanModeState");
  });

  it("treats missing and malformed payloads as no status", () => {
    expect(parsePlanStatus(undefined)).toBeNull();
    expect(parsePlanStatus("")).toBeNull();
    expect(parsePlanStatus("not json")).toBeNull();
    // An array passes a `typeof "object"` guard but fabricates no record:
    // there is no field to read, so it must not default into a fake status.
    expect(parsePlanStatus("[]")).toBeNull();
    expect(parsePlanStatus("[1,2]")).toBeNull();
    expect(parsePlanStatus("null")).toBeNull();
    expect(parsePlanStatus("7")).toBeNull();
  });

  it("never reports enabled from a non-boolean truthy value", () => {
    expect(parsePlanStatus(JSON.stringify({ enabled: "yes" }))?.enabled).toBe(false);
  });
});

describe("parsePlanReviewTitle", () => {
  it("reads a review request off the sentinel title", () => {
    const title =
      PLAN_REVIEW_SENTINEL +
      JSON.stringify({
        title: "add auth",
        planFilePath: "local://auth-plan.md",
        planAbsPath: "/l/local/auth-plan.md",
      });
    expect(parsePlanReviewTitle(title)).toEqual({
      title: "add auth",
      planFilePath: "local://auth-plan.md",
      planAbsPath: "/l/local/auth-plan.md",
    });
  });

  it("falls back to the plan path when the agent dropped the title", () => {
    const title = PLAN_REVIEW_SENTINEL + JSON.stringify({ planFilePath: "local://p.md" });
    expect(parsePlanReviewTitle(title)?.title).toBe("local://p.md");
  });

  it("ignores ordinary dialog titles so they reach the generic dialog", () => {
    expect(parsePlanReviewTitle("Approve plan: local://p.md")).toBeNull();
    expect(parsePlanReviewTitle(undefined)).toBeNull();
  });

  it("rejects a review with no plan file rather than opening an empty pane", () => {
    expect(parsePlanReviewTitle(PLAN_REVIEW_SENTINEL + JSON.stringify({ title: "t" }))).toBeNull();
    expect(parsePlanReviewTitle(PLAN_REVIEW_SENTINEL + "{oops")).toBeNull();
  });

  it("passes main's sourceHash through, and only a real sha256", () => {
    const hash = "a".repeat(64);
    const title = (sourceHash: unknown) =>
      PLAN_REVIEW_SENTINEL +
      JSON.stringify({ title: "t", planFilePath: "local://p.html", sourceHash });
    expect(parsePlanReviewTitle(title(hash))?.sourceHash).toBe(hash);
    // An uppercase or truncated hash is not the contract: dropped, never trusted.
    expect(parsePlanReviewTitle(title(hash.toUpperCase()))?.sourceHash).toBeUndefined();
    expect(parsePlanReviewTitle(title("nope"))?.sourceHash).toBeUndefined();
    expect(parsePlanReviewTitle(title(undefined))).toEqual({
      title: "t",
      planFilePath: "local://p.html",
      planAbsPath: null,
    });
  });
});

describe("isPlanArtifactPath", () => {
  it("accepts both plan formats and nothing else", () => {
    expect(isPlanArtifactPath("local://auth-plan.html")).toBe(true);
    expect(isPlanArtifactPath("local://auth-plan.md")).toBe(true);
    expect(isPlanArtifactPath("local://notes.html")).toBe(false);
    // Only the `local://` artifact URL is a plan file; a bare path is not.
    expect(isPlanArtifactPath("/tmp/auth-plan.md")).toBe(false);
  });
});

describe("isHtmlPlanPath", () => {
  it("routes html plans off the extension of either path shape", () => {
    expect(isHtmlPlanPath("/lineage/local/auth-plan.html")).toBe(true);
    expect(isHtmlPlanPath("local://auth-plan.md")).toBe(false);
    expect(isHtmlPlanPath(null)).toBe(false);
  });
});

/** One well-formed diagnostic with overrides; the wire shape is verbose. */
function diagnostic(over: Partial<PlanDiagnostic> = {}): PlanDiagnostic {
  return {
    code: "CODE_MARKUP",
    stage: "source",
    repair: "source",
    severity: "error",
    message: "a code block holds raw element markup",
    ...over,
  };
}

describe("parsePlanPreflightResult", () => {
  it("reads all three statuses, requiring a hash only for passed", () => {
    const hash = "b".repeat(64);
    expect(
      parsePlanPreflightResult({ status: "passed", sourceHash: hash, diagnostics: [] }),
    ).toEqual({ status: "passed", sourceHash: hash, diagnostics: [] });
    expect(
      parsePlanPreflightResult({ status: "failed", sourceHash: null, diagnostics: [diagnostic()] }),
    ).toEqual({ status: "failed", sourceHash: null, diagnostics: [diagnostic()] });
    expect(
      parsePlanPreflightResult({
        status: "unavailable",
        sourceHash: null,
        diagnostics: [],
        omitted: 3,
      }),
    ).toEqual({ status: "unavailable", sourceHash: null, diagnostics: [], omitted: 3 });
  });

  it("fails closed on every shape a real preflight could not have produced", () => {
    expect(parsePlanPreflightResult(null)).toBeNull();
    expect(parsePlanPreflightResult([])).toBeNull();
    expect(parsePlanPreflightResult("failed")).toBeNull();
    // An unknown status, a `passed` with no hash, and a non-hex hash are all
    // claims of success nobody is entitled to make.
    expect(parsePlanPreflightResult({ status: "ok", sourceHash: null, diagnostics: [] })).toBeNull();
    expect(parsePlanPreflightResult({ status: "passed", sourceHash: null, diagnostics: [] })).toBeNull();
    expect(
      parsePlanPreflightResult({ status: "passed", sourceHash: "deadbeef", diagnostics: [] }),
    ).toBeNull();
    // Machine fields are the contract: an invented code/stage/repair/severity
    // is rejected rather than defaulted.
    expect(
      parsePlanPreflightResult({
        status: "failed",
        sourceHash: null,
        diagnostics: [diagnostic({ code: "LOOKS_BAD" as PlanDiagnostic["code"] })],
      }),
    ).toBeNull();
    expect(
      parsePlanPreflightResult({
        status: "failed",
        sourceHash: null,
        diagnostics: [diagnostic({ stage: "vibes" as PlanDiagnostic["stage"] })],
      }),
    ).toBeNull();
    expect(
      parsePlanPreflightResult({
        status: "failed",
        sourceHash: null,
        diagnostics: [diagnostic({ repair: "hope" as PlanDiagnostic["repair"] })],
      }),
    ).toBeNull();
    // Oversized fields and impossible locations never survive a round trip.
    expect(
      parsePlanPreflightResult({
        status: "failed",
        sourceHash: null,
        diagnostics: [diagnostic({ message: "m".repeat(PLAN_MESSAGE_LIMIT + 1) })],
      }),
    ).toBeNull();
    expect(
      parsePlanPreflightResult({
        status: "failed",
        sourceHash: null,
        diagnostics: [diagnostic({ excerpt: "e".repeat(PLAN_EXCERPT_LIMIT + 1) })],
      }),
    ).toBeNull();
    expect(
      parsePlanPreflightResult({
        status: "failed",
        sourceHash: null,
        diagnostics: [
          diagnostic({ location: { startOffset: -4, endOffset: 9, line: 1, column: 1 } }),
        ],
      }),
    ).toBeNull();
    expect(
      parsePlanPreflightResult({
        status: "failed",
        sourceHash: null,
        diagnostics: [
          diagnostic({ location: { startOffset: 1.5, endOffset: 9, line: 1, column: 1 } }),
        ],
      }),
    ).toBeNull();
    // More than the transport count, or a nonsensical `omitted`, is malformed.
    expect(
      parsePlanPreflightResult({
        status: "failed",
        sourceHash: null,
        diagnostics: Array.from({ length: PLAN_DIAGNOSTIC_LIMIT + 1 }, () => diagnostic()),
      }),
    ).toBeNull();
    expect(
      parsePlanPreflightResult({
        status: "failed",
        sourceHash: null,
        diagnostics: [],
        omitted: -1,
      }),
    ).toBeNull();
  });
});

describe("parsePlanPreflightReply", () => {
  const reply = (envelope: unknown) =>
    PLAN_PREFLIGHT_RESULT_PREFIX + JSON.stringify(envelope);
  const failed = { status: "failed", sourceHash: null, diagnostics: [diagnostic()] };

  it("reads a version-1 failed or unavailable envelope", () => {
    expect(
      parsePlanPreflightReply(reply({ version: 1, planFilePath: "local://a-plan.html", result: failed })),
    ).toEqual({
      version: 1,
      planFilePath: "local://a-plan.html",
      result: { status: "failed", sourceHash: null, diagnostics: [diagnostic()] },
    });
    expect(
      parsePlanPreflightReply(
        reply({
          version: 1,
          planFilePath: "local://a-plan.html",
          result: { status: "unavailable", sourceHash: null, diagnostics: [] },
        }),
      )?.result.status,
    ).toBe("unavailable");
  });

  it("rejects every envelope a human or a passed result could not be", () => {
    // No prefix, junk after the prefix, and non-object envelopes.
    expect(parsePlanPreflightReply("yes")).toBeNull();
    expect(parsePlanPreflightReply(`${PLAN_PREFLIGHT_RESULT_PREFIX}{"version":1`)).toBeNull();
    expect(parsePlanPreflightReply(`${PLAN_PREFLIGHT_RESULT_PREFIX}[1,2]`)).toBeNull();
    expect(parsePlanPreflightReply(undefined)).toBeNull();
    // Another envelope version is a different protocol, not this one.
    expect(
      parsePlanPreflightReply(
        reply({ version: 2, planFilePath: "local://a-plan.html", result: failed }),
      ),
    ).toBeNull();
    expect(
      parsePlanPreflightReply(reply({ planFilePath: "local://a-plan.html", result: failed })),
    ).toBeNull();
    expect(
      parsePlanPreflightReply(reply({ version: 1, planFilePath: "", result: failed })),
    ).toBeNull();
    // main never sends `passed` through a reply: a success claim here is
    // whatever the user typed into the select.
    expect(
      parsePlanPreflightReply(
        reply({
          version: 1,
          planFilePath: "local://a-plan.html",
          result: { status: "passed", sourceHash: "c".repeat(64), diagnostics: [] },
        }),
      ),
    ).toBeNull();
    expect(
      parsePlanPreflightReply(
        reply({ version: 1, planFilePath: "local://a-plan.html", result: { status: "shipped" } }),
      ),
    ).toBeNull();
  });
});

describe("encodePlanPreflightReply", () => {
  const big = (index: number): PlanDiagnostic =>
    diagnostic({
      message: "m".repeat(PLAN_MESSAGE_LIMIT),
      detail: "d".repeat(PLAN_MESSAGE_LIMIT),
      excerpt: "e".repeat(PLAN_EXCERPT_LIMIT),
      location: { startOffset: index, endOffset: index + 1, line: index + 1, column: 1 },
    });

  it("round-trips through the parser unchanged", () => {
    const result: PlanPreflightResult = { status: "failed", sourceHash: null, diagnostics: [diagnostic()] };
    const encoded = encodePlanPreflightReply("local://a-plan.html", result);
    expect(encoded.startsWith(PLAN_PREFLIGHT_RESULT_PREFIX)).toBe(true);
    expect(parsePlanPreflightReply(encoded)).toEqual({
      version: 1,
      planFilePath: "local://a-plan.html",
      result,
    });
  });

  it("stays under the transport ceiling by dropping whole diagnostics", () => {
    const encoded = encodePlanPreflightReply("local://a-plan.html", {
      status: "failed",
      sourceHash: null,
      diagnostics: Array.from({ length: PLAN_DIAGNOSTIC_LIMIT }, (_, i) => big(i)),
    });
    expect(encoded.length).toBeLessThanOrEqual(PLAN_PREFLIGHT_REPLY_LIMIT);
    const decoded = parsePlanPreflightReply(encoded);
    // Dropped entries are counted, never silently missing.
    expect(decoded?.result.diagnostics.length).toBeLessThan(PLAN_DIAGNOSTIC_LIMIT);
    expect(decoded?.result.omitted).toBeGreaterThan(0);
  });

  it("keeps the shape floor parseable when no diagnostic is left to drop", () => {
    const encoded = encodePlanPreflightReply("local://p-plan.html", {
      status: "failed",
      sourceHash: null,
      diagnostics: [],
    });
    const huge = encodePlanPreflightReply(`local://${"h".repeat(PLAN_PREFLIGHT_REPLY_LIMIT)}-plan.html`, {
      status: "failed",
      sourceHash: null,
      diagnostics: [big(0)],
    });
    expect(parsePlanPreflightReply(encoded)?.result.diagnostics).toEqual([]);
    // Over the ceiling is acceptable; JSON truncated mid-token is not.
    expect(huge.length).toBeGreaterThan(PLAN_PREFLIGHT_REPLY_LIMIT);
    expect(parsePlanPreflightReply(huge)?.result.diagnostics).toEqual([]);
  });
});

describe("limitPlanPreflightResult", () => {
  it("orders, clips, and counts what it drops", () => {
    const limited = limitPlanPreflightResult({
      status: "failed",
      sourceHash: null,
      omitted: 2,
      diagnostics: [
        diagnostic({ code: "SOURCE_CHANGED", stage: "service" }),
        diagnostic({ code: "MERMAID_SYNTAX", stage: "diagram", location: { startOffset: 40, endOffset: 60, line: 3, column: 5 } }),
        diagnostic({ code: "RENDER_INVARIANT", stage: "prepare", location: { startOffset: 4, endOffset: 9, line: 1, column: 2 } }),
        diagnostic({ code: "LAYOUT_OVERFLOW", stage: "layout", location: { startOffset: 4, endOffset: 9, line: 1, column: 2 } }),
        ...Array.from({ length: PLAN_DIAGNOSTIC_LIMIT }, (_, i) =>
          diagnostic({ message: "m".repeat(PLAN_MESSAGE_LIMIT + 40), excerpt: "e".repeat(PLAN_EXCERPT_LIMIT + 40), location: { startOffset: 500 + i, endOffset: 501 + i, line: 9, column: 1 } }),
        ),
      ],
    });
    expect(limited.diagnostics.length).toBe(PLAN_DIAGNOSTIC_LIMIT);
    expect(limited.omitted).toBe(2 + 4);
    // Location first, then stage order (source < prepare < layout < diagram <
    // service in pipeline order), then code; unlocated last.
    expect(
      limited.diagnostics.slice(0, 3).map((d) => `${d.stage}:${d.code}`),
    ).toEqual(["prepare:RENDER_INVARIANT", "layout:LAYOUT_OVERFLOW", "diagram:MERMAID_SYNTAX"]);
    // The unlocated tail entry is what the clip drops; the last kept diagnostic
    // is the highest-located surviving filler.
    expect(limited.diagnostics.some((d) => d.code === "SOURCE_CHANGED")).toBe(false);
    expect(limited.diagnostics.at(-1)?.code).toBe("CODE_MARKUP");
    expect(limited.diagnostics.at(-1)?.location?.startOffset).toBe(516);
    for (const d of limited.diagnostics) {
      expect(d.message.length).toBeLessThanOrEqual(PLAN_MESSAGE_LIMIT);
      if (d.excerpt !== undefined) expect(d.excerpt.length).toBeLessThanOrEqual(PLAN_EXCERPT_LIMIT);
    }
  });

  it("leaves an in-bounds result untouched", () => {
    const result: PlanPreflightResult = { status: "failed", sourceHash: null, diagnostics: [diagnostic()] };
    expect(limitPlanPreflightResult(result)).toEqual(result);
  });
});

describe("comparePlanDiagnostics", () => {
  it("orders by location, then stage, then code", () => {
    const located = (offset: number, over: Partial<PlanDiagnostic> = {}) =>
      diagnostic({ location: { startOffset: offset, endOffset: offset + 1, line: 1, column: 1 }, ...over });
    const byLocation = [
      located(90),
      diagnostic(),
      located(10, { code: "EXTERNAL_RESOURCE" }),
      located(10, { code: "CODE_MARKUP" }),
    ];
    expect(
      [...byLocation].sort(comparePlanDiagnostics).map((d) => d.location?.startOffset ?? "none"),
    ).toEqual([10, 10, 90, "none"]);
    // Same location: pipeline stage order decides, then code.
    const byStage = [
      located(1, { stage: "service", code: "SOURCE_CHANGED" }),
      located(1, { stage: "layout", code: "LAYOUT_OVERFLOW" }),
      located(1, { stage: "source", code: "HTML_PARSE_ERROR" }),
      located(1, { stage: "source", code: "CODE_MARKUP" }),
    ];
    expect(
      [...byStage].sort(comparePlanDiagnostics).map((d) => d.code),
    ).toEqual(["CODE_MARKUP", "HTML_PARSE_ERROR", "LAYOUT_OVERFLOW", "SOURCE_CHANGED"]);
    expect(comparePlanDiagnostics(diagnostic(), diagnostic())).toBe(0);
  });
});
