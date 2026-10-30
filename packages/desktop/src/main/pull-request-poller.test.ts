import { describe, expect, it, vi } from "vitest";
import type { AutoSettledSession, OwnedSessionRecord, PullRequestLink, PullRequestLookup } from "@omp-ui/core";
import { PullRequestPoller } from "./pull-request-poller";
import { ownedSessionRecord } from "./test/fixtures";

const open: PullRequestLink = { number: 7, url: "https://github.com/o/r/pull/7", state: "open", checks: "passing" };
const merged: PullRequestLink = { ...open, state: "merged" };

function harness(opts: { records: OwnedSessionRecord[]; live?: boolean; turn?: boolean; autoDefault?: boolean }) {
  const records = opts.records;
  let answer: PullRequestLookup = { ok: true, byBranch: new Map() };
  let turn = opts.turn ?? false;
  const lookup = vi.fn(async () => answer);
  const settle = vi.fn(async () => true);
  const announced: AutoSettledSession[][] = [];
  const poller = new PullRequestPoller({
    sessions: () => records,
    updateSession: (tabId, patch) => Object.assign(records.find((r) => r.tabId === tabId)!, patch),
    autoSettleDefault: () => opts.autoDefault ?? true,
    isLive: () => opts.live ?? true,
    isTurnRunning: () => turn,
    settle,
    broadcast: vi.fn(),
    announceSettled: (s) => announced.push(s),
    isFocused: () => true,
    lookup,
  });
  return {
    poller,
    lookup,
    settle,
    announced,
    answer: (byBranch: Record<string, PullRequestLink[]>) => {
      answer = { ok: true, byBranch: new Map(Object.entries(byBranch)) };
    },
    fail: (reason: "unauthenticated" | "failed" = "unauthenticated") => {
      answer = { ok: false, reason, detail: "" };
    },
    setTurn: (v: boolean) => {
      turn = v;
    },
  };
}

const worktreeRecord = (patch: Partial<OwnedSessionRecord> = {}): OwnedSessionRecord =>
  ownedSessionRecord({
    tabId: "t1",
    projectCwd: "/repo",
    worktree: { path: "/wt/t1", branch: "feature", base: "main" },
    cachedTitle: "Feature",
    ...patch,
  });

describe("PullRequestPoller (issue #985)", () => {
  it("settles a live session when its open PR merges, and announces it for Undo", async () => {
    const rec = worktreeRecord();
    const h = harness({ records: [rec] });
    h.answer({ feature: [open] });
    await h.poller.poll();
    expect(rec.pullRequests).toEqual([open]);
    expect(h.settle).not.toHaveBeenCalled();

    h.answer({ feature: [merged] });
    await h.poller.poll();
    expect(h.settle).toHaveBeenCalledWith("t1");
    expect(h.announced).toEqual([[{ tabId: "t1", title: "Feature", wasLive: true, snoozed: false, snoozedUntilMs: null }]]);
  });

  it("never settles on the first sighting of an already-merged PR", async () => {
    const rec = worktreeRecord();
    const h = harness({ records: [rec] });
    h.answer({ feature: [merged] });
    await h.poller.poll();
    expect(rec.pullRequests).toEqual([merged]);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("waits out a running turn, then settles on a later poll", async () => {
    const rec = worktreeRecord({ pullRequests: [open] });
    const h = harness({ records: [rec], turn: true });
    h.answer({ feature: [merged] });
    await h.poller.poll();
    expect(h.settle).not.toHaveBeenCalled();
    h.setTurn(false);
    await h.poller.poll();
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it("keeps a session the user opted out of, whatever the app default", async () => {
    const rec = worktreeRecord({ pullRequests: [open], autoSettleOnMerge: false });
    const h = harness({ records: [rec], autoDefault: true });
    h.answer({ feature: [merged] });
    await h.poller.poll();
    expect(rec.pullRequests).toEqual([merged]);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("settles an opted-in session while the app default is off", async () => {
    const rec = worktreeRecord({ pullRequests: [open], autoSettleOnMerge: true });
    const h = harness({ records: [rec], autoDefault: false });
    h.answer({ feature: [merged] });
    await h.poller.poll();
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it("waits until every linked PR merged", async () => {
    const second: PullRequestLink = { ...open, number: 8, url: "https://github.com/o/r/pull/8" };
    const rec = worktreeRecord({ pullRequests: [second, open] });
    const h = harness({ records: [rec] });
    h.answer({ feature: [second, merged] });
    await h.poller.poll();
    expect(h.settle).not.toHaveBeenCalled();
    h.answer({ feature: [{ ...second, state: "merged" }, merged] });
    await h.poller.poll();
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it("leaves a dormant unsnoozed session alone: it is already settled", async () => {
    const rec = worktreeRecord({ pullRequests: [open] });
    const h = harness({ records: [rec], live: false });
    h.answer({ feature: [merged] });
    await h.poller.poll();
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("keeps the last links when the forge answers none, and backs off a failing repository", async () => {
    const rec = worktreeRecord({ pullRequests: [open] });
    const h = harness({ records: [rec] });
    h.answer({});
    await h.poller.poll();
    expect(rec.pullRequests).toEqual([open]);

    h.fail();
    await h.poller.poll();
    await h.poller.poll();
    // A logged-out gh is skipped on the next poll instead of re-running.
    expect(h.lookup).toHaveBeenCalledTimes(2);
  });

  it("retries a transient failure (a GitHub 5xx) on the next poll", async () => {
    const rec = worktreeRecord({ pullRequests: [open] });
    const h = harness({ records: [rec] });
    h.fail("failed");
    await h.poller.poll();
    h.answer({ feature: [merged] });
    await h.poller.poll();
    expect(h.lookup).toHaveBeenCalledTimes(2);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it("asks once per repository for every worktree branch in it", async () => {
    const a = worktreeRecord();
    const b = worktreeRecord({ tabId: "t2", worktree: { path: "/wt/t2", branch: "other", base: "main" } });
    const h = harness({ records: [a, b] });
    await h.poller.poll();
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.lookup).toHaveBeenCalledWith("/repo", ["feature", "other"]);
  });
});
