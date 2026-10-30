import type { PendingPlan, SessionSummary } from "@omp-ui/core/types";
import { describe, expect, it } from "vitest";
import { dialogQuestion, tileModel, tileQuote } from "./session-tile";

function session(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    tabId: "tab-1",
    sessionId: null,
    lineageDir: "lineage-tab-1",
    projectCwd: "/a",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    fleet: null,
    launchedAt: "2026-08-19T12:00:00.000Z",
    mode: "rpc-ui",
    model: null,
    thinkingLevel: null,
    agentMode: "build",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    autoTitled: false,
    snoozed: false,
    snoozedUntilMs: null,
    pinnedAtMs: null,
    heldPrompt: null,
    scheduledPrompt: null,
    pullRequests: [],
    autoSettleOnMerge: null,
    private: false,
    chat: false,
    askSource: null,
    cachedTitle: null,
    cachedModified: null,
    title: "Session",
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  };
}

function plan(title: string): PendingPlan {
  return {
    title,
    planFilePath: "local://plan.md",
    planAbsPath: null,
    frameId: "frame-plan",
    proposedAt: "2026-08-19T12:00:00.000Z",
  };
}

const selectFrame = {
  type: "extension_ui_request",
  id: "d1",
  method: "select",
  title: "(2 selected) Which DB? (2/3)",
};

describe("dialogQuestion", () => {
  it("strips a select loop's count prefix and page marker", () => {
    expect(dialogQuestion(selectFrame)).toBe("Which DB?");
  });

  it("keeps only an editor's first line", () => {
    expect(dialogQuestion({ method: "editor", title: "Describe it\nmore body" })).toBe(
      "Describe it",
    );
  });

  it("passes a confirm title through", () => {
    expect(dialogQuestion({ method: "confirm", title: "Proceed?" })).toBe("Proceed?");
  });

  it("returns null without a title", () => {
    expect(dialogQuestion({ method: "confirm" })).toBeNull();
  });

  it("returns null for a blank title", () => {
    expect(dialogQuestion({ method: "confirm", title: "   " })).toBeNull();
  });
});

describe("tileQuote", () => {
  it("prefers the pending plan over a dialog", () => {
    expect(
      tileQuote(session({ pendingPlan: plan("Ship the tile"), pendingDialogs: [selectFrame] })),
    ).toEqual({ kind: "plan", text: "Ship the tile" });
  });

  it("quotes the head dialog's question", () => {
    expect(tileQuote(session({ pendingDialogs: [selectFrame] }))).toEqual({
      kind: "question",
      text: "Which DB?",
    });
  });

  it("returns null when an older host omits pendingDialogs", () => {
    expect(tileQuote(session())).toBeNull();
  });

  it("returns null with no pending dialogs", () => {
    expect(tileQuote(session({ pendingDialogs: [] }))).toBeNull();
  });
});

describe("tileModel", () => {
  it("joins the short model label and thinking level", () => {
    expect(
      tileModel(session({ model: "openrouter/anthropic/claude-x:high", thinkingLevel: "high" })),
    ).toBe("claude-x · high");
  });

  it("omits a null thinking level", () => {
    expect(
      tileModel(session({ model: "openrouter/anthropic/claude-x:high", thinkingLevel: null })),
    ).toBe("claude-x");
  });

  it("returns null while no model is pinned", () => {
    expect(tileModel(session({ model: null, thinkingLevel: "high" }))).toBeNull();
  });
});
