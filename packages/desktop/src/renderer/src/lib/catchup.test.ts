import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import { describe, expect, it } from "vitest";

import { buildCatchupDigest, CATCHUP_THRESHOLD_MS } from "./catchup";
import type { RenderItem } from "./transcript";

const T0 = Date.parse("2026-08-24T10:00:00.000Z");
const SINCE = T0 + 20 * 60_000;
const NOW = T0 + 40 * 60_000;

const user = (text: string, at: number): RenderItem => ({
  kind: "user", id: `u${at}`, text, timestamp: at,
});
const assistant = (
  at: number,
  patch: Partial<{
    stopReason: string;
    streaming: boolean;
    input: number;
    output: number;
    cacheRead: number;
    cost: number;
  }> = {},
): RenderItem => ({
  kind: "assistant",
  id: `a${at}`,
  text: "done",
  thinking: "",
  streaming: patch.streaming ?? false,
  ...(patch.stopReason !== undefined ? { stopReason: patch.stopReason } : {}),
  ...(patch.input !== undefined
    ? {
        usage: {
          input: patch.input,
          output: patch.output ?? 0,
          cacheRead: patch.cacheRead ?? 0,
          cacheWrite: 0,
          total: (patch.input ?? 0) + (patch.output ?? 0) + (patch.cacheRead ?? 0),
          cost: patch.cost ?? 0,
        },
      }
    : {}),
  timestamp: at,
});
const tool = (
  at: number,
  patch: Partial<{ path: string; op: string }> = {},
): RenderItem => ({
  kind: "tool",
  id: `t${at}`,
  toolCallId: `tc${at}`,
  name: "write",
  args: null,
  status: "done",
  ...(patch.path !== undefined ? { path: patch.path } : {}),
  ...(patch.op !== undefined ? { op: patch.op } : {}),
  timestamp: at,
});
const marker = (label: string, at: number): RenderItem => ({
  kind: "marker", id: `m${at}`, label, timestamp: at,
});
const adv = (patch: Partial<AdvisorStatsView> = {}): AdvisorStatsView => ({
  available: true,
  configured: true,
  active: true,
  model: "adv-model",
  subscription: false,
  contextWindow: 0,
  contextTokens: 0,
  cost: 0,
  totalTokens: 0,
  ...patch,
});

const digest = (
  items: RenderItem[],
  extra: Partial<{
    advisor: AdvisorStatsView | null;
    since: number;
    now: number;
    live: boolean;
    pendingPlanTitle: string | null;
  }> = {},
) =>
  buildCatchupDigest({
    items,
    advisor: null,
    since: SINCE,
    now: NOW,
    live: false,
    pendingPlanTitle: null,
    ...extra,
  });

const completedTurn = (): RenderItem[] => [
  user("y", SINCE),
  assistant(SINCE + 1, { stopReason: "stop" }),
];

describe("buildCatchupDigest (issue #273)", () => {
  it("exports a 15-minute threshold and sums windowed fields", () => {
    expect(CATCHUP_THRESHOLD_MS).toBe(15 * 60_000);
    const d = digest(completedTurn());
    expect(d?.since).toBe(SINCE);
    expect(d?.awayMs).toBe(NOW - SINCE);
  });

  it("excludes items before the window and includes the boundary", () => {
    const before = digest([
      user("before", SINCE - 1),
      assistant(SINCE - 1, { stopReason: "stop" }),
    ]);
    expect(before).toBeNull();
    const at = digest([user("at", SINCE), assistant(SINCE, { stopReason: "stop" })]);
    expect(at?.turns).toEqual([
      expect.objectContaining({ prompt: "at", outcome: "completed" }),
    ]);
  });

  it("maps stop/end_turn to completed, and error/aborted/maxTokens to their outcomes", () => {
    const d = digest([
      user("one", SINCE), assistant(SINCE + 1, { stopReason: "stop" }),
      user("two", SINCE + 2), assistant(SINCE + 3, { stopReason: "end_turn" }),
      user("three", SINCE + 4), assistant(SINCE + 5, { stopReason: "error" }),
      user("four", SINCE + 6), assistant(SINCE + 7, { stopReason: "aborted" }),
      user("five", SINCE + 8), assistant(SINCE + 9, { stopReason: "maxTokens" }),
    ]);
    expect(d?.turns).toEqual([
      { prompt: "one", outcome: "completed" },
      { prompt: "two", outcome: "completed" },
      { prompt: "three", outcome: "error" },
      { prompt: "four", outcome: "interrupted" },
      { prompt: "five", outcome: "truncated" },
    ]);
  });

  it("reads a turn with no assistant end as running live, interrupted dead", () => {
    const items = [user("open", SINCE)];
    expect(digest(items, { live: true })?.turns).toEqual([
      { prompt: "open", outcome: "running" },
    ]);
    expect(digest(items, { live: false })?.turns).toEqual([
      { prompt: "open", outcome: "interrupted" },
    ]);
  });

  it("reads a streaming end as running live, interrupted dead", () => {
    const items = [user("open", SINCE), assistant(SINCE + 1, { streaming: true })];
    expect(digest(items, { live: true })?.turns).toEqual([
      { prompt: "open", outcome: "running" },
    ]);
    expect(digest(items, { live: false })?.turns).toEqual([
      { prompt: "open", outcome: "interrupted" },
    ]);
  });

  it("caps turns at the last 5 chronological and counts omissions", () => {
    const items: RenderItem[] = [];
    for (let i = 0; i < 7; i++) {
      items.push(user(`p${i}`, SINCE + i * 2), assistant(SINCE + i * 2 + 1, { stopReason: "stop" }));
    }
    const d = digest(items);
    expect(d?.turns.map((t) => t.prompt)).toEqual(["p2", "p3", "p4", "p5", "p6"]);
    expect(d?.turnsOmitted).toBe(2);
  });

  it("formats prompts: first line, 80-char snippet, image-only", () => {
    const long = "x".repeat(120);
    const d = digest([
      user(`${long}\nsecond line`, SINCE), assistant(SINCE + 1, { stopReason: "stop" }),
      user("", SINCE + 2), assistant(SINCE + 3, { stopReason: "stop" }),
    ]);
    expect(d?.turns[0]!.prompt).toBe(`${"x".repeat(79)}…`);
    expect(d?.turns[1]!.prompt).toBe("(image)");
  });

  it("dedupes files by path in first-seen order and upgrades the op", () => {
    const d = digest([
      tool(SINCE, { path: "/a.txt" }),
      tool(SINCE + 1, { path: "/b.txt", op: "edit" }),
      tool(SINCE + 2, { path: "/a.txt", op: "write" }),
      tool(SINCE + 3, { path: "/c.txt", op: "create" }),
      tool(SINCE + 4),
    ]);
    expect(d?.files).toEqual([
      { path: "/a.txt", op: "write" },
      { path: "/b.txt", op: "edit" },
      { path: "/c.txt", op: "write" },
    ]);
    expect(d?.filesOmitted).toBe(0);
  });

  it("caps files at 4 distinct paths and ignores pathless tools", () => {
    const items = [
      tool(SINCE, { path: "/a" }),
      tool(SINCE + 1, { path: "/b" }),
      tool(SINCE + 2, { path: "/c" }),
      tool(SINCE + 3, { path: "/d" }),
      tool(SINCE + 4, { path: "/e" }),
      tool(SINCE + 5, { path: "/f" }),
      tool(SINCE + 6),
    ];
    const d = digest(items);
    expect(d?.files?.length).toBe(4);
    expect(d?.filesOmitted).toBe(2);
  });

  it("sums spend and tokens over in-window non-streaming receipts only", () => {
    const d = digest([
      user("old", SINCE - 10),
      assistant(SINCE - 5, { stopReason: "stop", input: 10, output: 20, cost: 0.5 }),
      user("y", SINCE),
      assistant(SINCE + 1, { stopReason: "stop", input: 100, output: 50, cacheRead: 30, cost: 0.25 }),
      assistant(SINCE + 2, { streaming: true, input: 999, output: 999, cost: 9 }),
    ]);
    expect(d?.cost).toBeCloseTo(0.25, 10);
    expect(d?.tokens).toEqual({ input: 100, output: 50, cacheRead: 30 });
  });

  it("includes advisor totals only when available and nonzero", () => {
    const items = completedTurn();
    expect(
      digest(items, { advisor: adv({ cost: 0.5, totalTokens: 1200 }) })?.advisor,
    ).toEqual({ cost: 0.5, tokens: 1200 });
    expect(digest(items, { advisor: adv() })?.advisor).toBeNull();
    expect(
      digest(items, { advisor: adv({ available: false, cost: 1, totalTokens: 5 }) })?.advisor,
    ).toBeNull();
    expect(digest(items, { advisor: null })?.advisor).toBeNull();
  });

  it("keeps compaction/retry markers only, dedupes exact labels, caps at 4", () => {
    const d = digest([
      marker("auto-compaction started", SINCE),
      marker("auto-compaction started", SINCE + 1),
      marker("agent started", SINCE + 2),
      marker("thinking level: high", SINCE + 3),
      marker("auto-retry 2/3 started", SINCE + 4),
      marker("retry succeeded", SINCE + 5),
      marker("auto-retry 3/3 started", SINCE + 6),
      marker("auto-compact 1", SINCE + 7),
      marker("auto-compact 2", SINCE + 8),
    ]);
    expect(d?.lifecycle).toEqual([
      "auto-compaction started",
      "auto-retry 2/3 started",
      "retry succeeded",
      "auto-retry 3/3 started",
    ]);
    expect(d?.lifecycleOmitted).toBe(2);
  });

  it("carries the pending plan title", () => {
    expect(digest([], { pendingPlanTitle: "Ship it" })).toEqual(
      expect.objectContaining({ pendingPlan: { title: "Ship it" } }),
    );
  });

  it("returns null only when every section is empty", () => {
    expect(digest([])).toBeNull();
    expect(
      digest([user("old", SINCE - 1), assistant(SINCE - 1, { stopReason: "stop" })]),
    ).toBeNull();
    expect(digest([tool(SINCE - 1, { path: "/x" })])).toBeNull();
    // Each section alone is enough to be non-empty.
    expect(digest(completedTurn())).not.toBeNull();
    expect(digest([tool(SINCE, { path: "/x" })])).not.toBeNull();
    expect(
      digest([assistant(SINCE, { stopReason: "stop", input: 1, output: 1, cost: 0.1 })]),
    ).not.toBeNull();
    expect(
      digest(completedTurn(), { advisor: adv({ cost: 1, totalTokens: 2 }) }),
    ).not.toBeNull();
    expect(digest([marker("auto-compaction started", SINCE)])).not.toBeNull();
    expect(digest([], { pendingPlanTitle: "x" })).not.toBeNull();
  });
});
