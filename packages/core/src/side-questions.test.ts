import { describe, expect, it } from "vitest";
import {
  BTW_COMMAND,
  BTW_STATUS_BYTE_LIMIT,
  btwAskMessage,
  btwCancelMessage,
  btwEntryFileName,
  btwPromptText,
  btwRefreshMessage,
  parseBtwRecord,
  parseBtwSnapshot,
} from "./side-questions";

const turn = {
  question: "why?",
  answer: "because",
  status: "complete",
  createdAt: 1,
  updatedAt: 2,
};
const record = { ...turn, id: "abc-1", leafId: null };

describe("btw history record grammar", () => {
  it("round-trips omp's record shape, including follow-ups and turn errors", () => {
    const full = {
      ...record,
      leafId: "leaf",
      followUps: [{ ...turn, status: "error", error: "boom" }],
    };
    expect(parseBtwRecord(JSON.stringify(full))).toEqual(full);
  });

  it("rejects unknown keys at the root and inside follow-ups", () => {
    expect(parseBtwRecord(JSON.stringify({ ...record, extra: 1 }))).toBeNull();
    expect(
      parseBtwRecord(JSON.stringify({ ...record, followUps: [{ ...turn, extra: 1 }] })),
    ).toBeNull();
  });

  it("rejects nested follow-ups, bad ids, statuses and out-of-range timestamps", () => {
    expect(
      parseBtwRecord(
        JSON.stringify({ ...record, followUps: [{ ...turn, followUps: [] }] }),
      ),
    ).toBeNull();
    for (const id of ["", "-lead", "has space", "a".repeat(129)])
      expect(parseBtwRecord(JSON.stringify({ ...record, id }))).toBeNull();
    expect(parseBtwRecord(JSON.stringify({ ...record, status: "done" }))).toBeNull();
    expect(parseBtwRecord(JSON.stringify({ ...record, createdAt: -1 }))).toBeNull();
    expect(
      parseBtwRecord(JSON.stringify({ ...record, updatedAt: 8_640_000_000_000_001 })),
    ).toBeNull();
    expect(parseBtwRecord("not json")).toBeNull();
  });

  it("leaves a running turn running: normalising to interrupted is the loader's job", () => {
    const parsed = parseBtwRecord(JSON.stringify({ ...record, status: "running" }));
    expect(parsed?.status).toBe("running");
  });

  it("names files the way omp's store does", () => {
    expect(btwEntryFileName("abc-1")).toBe("entry-abc-1.json");
  });
});

describe("hidden bridge frames", () => {
  it("are single-line slash commands with compact JSON", () => {
    const ask = btwAskMessage({ requestId: "r1", question: "line one\nline two", topicId: "t" });
    expect(ask).not.toContain("\n");
    expect(ask.startsWith(`/${BTW_COMMAND} ask `)).toBe(true);
    expect(JSON.parse(ask.slice(`/${BTW_COMMAND} ask `.length))).toEqual({
      requestId: "r1",
      question: "line one\nline two",
      topicId: "t",
    });
    expect(btwCancelMessage({ requestId: "r2" })).toBe(`/${BTW_COMMAND} cancel {"requestId":"r2"}`);
    expect(btwRefreshMessage({ requestId: "r3" })).toBe(`/${BTW_COMMAND} refresh {"requestId":"r3"}`);
  });

  it("wraps a question without interpreting $ replacement patterns", () => {
    expect(btwPromptText("cost is $& and $1")).toContain("cost is $& and $1");
  });
});

describe("parseBtwSnapshot", () => {
  const snapshot = {
    available: true,
    active: null,
    topics: [
      {
        id: "t1",
        question: "q",
        answer: "a",
        status: "complete",
        updatedAt: 5,
        turns: [{ question: "q", answer: "a", status: "complete", updatedAt: 5 }],
      },
    ],
    publishedAt: 9,
  };

  it("accepts a well-formed snapshot", () => {
    expect(parseBtwSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("returns null for malformed, wrong-shaped or over-limit payloads", () => {
    expect(parseBtwSnapshot(undefined)).toBeNull();
    expect(parseBtwSnapshot("{")).toBeNull();
    expect(parseBtwSnapshot(JSON.stringify({ ...snapshot, available: "yes" }))).toBeNull();
    expect(
      parseBtwSnapshot(
        JSON.stringify({ ...snapshot, topics: [{ ...snapshot.topics[0], status: "bogus" }] }),
      ),
    ).toBeNull();
    const huge = JSON.stringify({ ...snapshot, busy: "x".repeat(BTW_STATUS_BYTE_LIMIT) });
    expect(parseBtwSnapshot(huge)).toBeNull();
  });
});
