import { describe, expect, it } from "vitest";
import {
  parsePlanReviewTitle,
  parsePlanStatus,
  PLAN_REVIEW_SENTINEL,
} from "./plan";

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
        planHtmlAbsPath: "/l/local/auth-plan.html",
      });
    expect(parsePlanReviewTitle(title)).toEqual({
      title: "add auth",
      planFilePath: "local://auth-plan.md",
      planAbsPath: "/l/local/auth-plan.md",
      planHtmlAbsPath: "/l/local/auth-plan.html",
    });
  });

  it("reports no html rendition for a markdown-only plan", () => {
    // A session planning in md format — and every extension predating the
    // html rendition — omits the field entirely.
    const title =
      PLAN_REVIEW_SENTINEL +
      JSON.stringify({ planFilePath: "local://p.md", planAbsPath: "/l/local/p.md" });
    expect(parsePlanReviewTitle(title)?.planHtmlAbsPath).toBeNull();
    const junk =
      PLAN_REVIEW_SENTINEL + JSON.stringify({ planFilePath: "local://p.md", planHtmlAbsPath: 7 });
    expect(parsePlanReviewTitle(junk)?.planHtmlAbsPath).toBeNull();
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
