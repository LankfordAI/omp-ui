import { describe, expect, it } from "vitest";
import {
  isHtmlPlanPath,
  isPlanArtifactPath,
  parsePlanReviewTitle,
  planMessage,
  parsePlanStatus,
  PLAN_REVIEW_SENTINEL,
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
    expect(parsePlanStatus("[]")).toEqual({
      enabled: false,
      planFilePath: null,
      planAbsPath: null,
      approved: false,
      unavailable: undefined,
    });
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
