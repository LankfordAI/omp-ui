import { describe, expect, it } from "vitest";
import type { AsyncNotifyReport } from "@omp-ui/core/async-notify";
import {
  ASYNC_NOTICE_LINE_CAP,
  ASYNC_NOTICE_SOURCE_CAP,
  feedAsyncNotices,
  orphanNoticeKeys,
  type AsyncNoticeFeed,
} from "./async-notices";

const report = (overrides: Partial<AsyncNotifyReport> = {}): AsyncNotifyReport => ({
  id: "bg_1",
  type: "bash",
  pattern: "ERROR",
  lines: ["ERROR boom"],
  omitted: 0,
  running: true,
  stopped: false,
  ...overrides,
});

describe("feedAsyncNotices (issue #1235)", () => {
  it("folds deliveries into one bounded source and returns the same object when nothing arrives", () => {
    expect(feedAsyncNotices({}, [], 1)).toEqual({});
    let feed: AsyncNoticeFeed = {};
    feed = feedAsyncNotices(feed, [report({ lines: ["a"] })], 10);
    feed = feedAsyncNotices(feed, [report({ lines: ["b"], running: false, stopped: true, omitted: 2 })], 20);
    expect(Object.keys(feed)).toEqual(["bash:bg_1"]);
    const source = feed["bash:bg_1"]!;
    expect(source.lines).toEqual(["a", "b"]);
    expect(source.running).toBe(false);
    expect(source.stopped).toBe(true);
    expect(source.omitted).toBe(2);
    expect(source.lastAt).toBe(20);
  });

  it("keeps job ids and service names in separate namespaces", () => {
    const feed = feedAsyncNotices({}, [report(), report({ id: "bg_1", type: "service", lines: ["svc"] })], 1);
    expect(Object.keys(feed).sort()).toEqual(["bash:bg_1", "service:bg_1"]);
  });

  it("rolls the line cap off the head and counts what fell off", () => {
    const many = new Array(ASYNC_NOTICE_LINE_CAP + 7).fill("x");
    let feed: AsyncNoticeFeed = {};
    feed = feedAsyncNotices(feed, [report({ lines: many })], 1);
    feed = feedAsyncNotices(feed, [report({ lines: ["late"] })], 2);
    const source = feed["bash:bg_1"]!;
    expect(source.lines).toHaveLength(ASYNC_NOTICE_LINE_CAP);
    expect(source.lines.at(-1)).toBe("late");
    expect(source.droppedLines).toBe(8);
  });

  it("evicts the least recently fed source past the cap", () => {
    let feed: AsyncNoticeFeed = {};
    for (let i = 0; i < ASYNC_NOTICE_SOURCE_CAP; i++) {
      feed = feedAsyncNotices(feed, [report({ id: `bg_${i}` })], i + 1);
    }
    feed = feedAsyncNotices(feed, [report({ id: "bg_new" })], 1_000);
    expect(Object.keys(feed)).toHaveLength(ASYNC_NOTICE_SOURCE_CAP);
    expect(feed["bash:bg_0"]).toBeUndefined();
    expect(feed["bash:bg_new"]).toBeDefined();
  });
});

describe("orphanNoticeKeys (issue #1235)", () => {
  const feed = feedAsyncNotices(
    {},
    [report(), report({ id: "bg_gone" }), report({ id: "web", type: "service" })],
    1,
  );

  it("lists services and evicted jobs, oldest first; a listed job never appears", () => {
    const orphans = orphanNoticeKeys(feed, new Set(["bg_1"]));
    expect(orphans.map((s) => s.id)).toEqual(["bg_gone", "web"]);
  });

  it("an empty row list keeps every source readable (no silent drop)", () => {
    expect(orphanNoticeKeys(feed, new Set())).toHaveLength(3);
  });
});
