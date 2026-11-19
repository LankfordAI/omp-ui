import { describe, expect, it } from "vitest";
import {
  ASYNC_NOTIFY_LINES_CAP,
  ASYNC_NOTIFY_MESSAGE_TYPE,
  asyncNotifyReportsFromFrame,
  isAsyncNotifyMessage,
  parseAsyncNotifyReport,
  parseAsyncNotifyReports,
} from "./async-notify";

const report = {
  id: "bg_1",
  type: "bash",
  pattern: "ERROR|FAILED",
  lines: ["ERROR boom"],
  omitted: 3,
  running: true,
  stopped: false,
};

describe("async-notify wire parsing (issue #1235)", () => {
  it("recognizes the omp 19 custom message and ignores hidden ones", () => {
    expect(isAsyncNotifyMessage({ role: "custom", customType: ASYNC_NOTIFY_MESSAGE_TYPE, display: true })).toBe(true);
    expect(isAsyncNotifyMessage({ role: "custom", customType: ASYNC_NOTIFY_MESSAGE_TYPE })).toBe(true);
    expect(isAsyncNotifyMessage({ role: "custom", customType: ASYNC_NOTIFY_MESSAGE_TYPE, display: false })).toBe(false);
    expect(isAsyncNotifyMessage({ role: "assistant", customType: ASYNC_NOTIFY_MESSAGE_TYPE })).toBe(false);
    expect(isAsyncNotifyMessage("nope")).toBe(false);
  });

  it("parses a report verbatim and keeps unknown extra keys out", () => {
    const parsed = parseAsyncNotifyReport({ ...report, futureField: 7 });
    expect(parsed).toEqual(report);
  });

  it("drops only the unusable reports of a mixed batch", () => {
    const reports = parseAsyncNotifyReports({
      reports: [
        report,
        { ...report, id: "" },
        { ...report, type: "service-ish" },
        { ...report, id: "svc", type: "service", lines: "not-an-array" },
      ],
    });
    expect(reports).toHaveLength(2);
    expect(reports?.map((r) => r.id)).toEqual(["bg_1", "svc"]);
    expect(reports?.[1]?.lines).toEqual([]);
  });

  it("reads no reports from a malformed details payload", () => {
    expect(parseAsyncNotifyReports({})).toBeNull();
    expect(parseAsyncNotifyReports({ reports: [] })).toBeNull();
    expect(parseAsyncNotifyReports({ reports: "x" })).toBeNull();
  });

  it("clamps hostile line counts, lengths and counters", () => {
    const parsed = parseAsyncNotifyReport({
      ...report,
      lines: new Array(ASYNC_NOTIFY_LINES_CAP + 50).fill("x".repeat(5_000)),
      omitted: -4,
      running: "yes",
    });
    expect(parsed!.lines).toHaveLength(ASYNC_NOTIFY_LINES_CAP);
    expect(parsed!.lines[0]!.length).toBeLessThanOrEqual(1024);
    expect(parsed!.omitted).toBe(0);
    expect(parsed!.running).toBe(false);
  });

  it("lifts reports only off a message_end carrying the custom message", () => {
    const message = { role: "custom", customType: ASYNC_NOTIFY_MESSAGE_TYPE, display: true, details: { reports: [report] } };
    expect(asyncNotifyReportsFromFrame({ type: "message_end", message })).toEqual([report]);
    // start carries the same message — the feed deliberately reads end only.
    expect(asyncNotifyReportsFromFrame({ type: "message_start", message })).toBeNull();
    expect(asyncNotifyReportsFromFrame({ type: "message_end", message: { role: "assistant" } })).toBeNull();
    expect(asyncNotifyReportsFromFrame({ type: "message_end" })).toBeNull();
  });
});
