import { describe, expect, it } from "vitest";
import {
  applyBtwDelta,
  applyBtwRecord,
  btwEntryFileName,
  btwSnapshotFromRecords,
  btwTopicFromRecord,
  parseBtwRecord,
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

describe("btwTopicFromRecord", () => {
  it("titles with the root question and reads the latest turn's verdict", () => {
    const topic = btwTopicFromRecord(
      parseBtwRecord(
        JSON.stringify({
          ...record,
          status: "running",
          answer: "root answer",
          updatedAt: 5,
          followUps: [
            { question: "and then?", answer: "follow-up answer", status: "complete", createdAt: 6, updatedAt: 7 },
          ],
        }),
      )!,
    );
    expect(topic).toMatchObject({
      id: "abc-1",
      question: "why?",
      answer: "follow-up answer",
      status: "complete",
      updatedAt: 7,
    });
    expect(topic.turns.map((t) => t.question)).toEqual(["why?", "and then?"]);
    // The view turns drop the record's createdAt but keep every other field.
    expect(topic.turns[0]).toEqual({
      question: "why?",
      answer: "root answer",
      status: "running",
      updatedAt: 5,
    });
  });

  it("carries a latest-turn error and keeps follow-up order", () => {
    const topic = btwTopicFromRecord(
      parseBtwRecord(
        JSON.stringify({
          ...record,
          followUps: [
            { ...turn, question: "a", createdAt: 3, updatedAt: 4 },
            { ...turn, question: "b", status: "error", error: "boom", createdAt: 5, updatedAt: 6 },
          ],
        }),
      )!,
    );
    expect(topic.turns.map((t) => t.question)).toEqual(["why?", "a", "b"]);
    expect(topic).toMatchObject({ status: "error", error: "boom", updatedAt: 6 });
  });
});

describe("btwSnapshotFromRecords", () => {
  it("sorts newest updatedAt first and sets available/publishedAt", () => {
    const snapshot = btwSnapshotFromRecords(
      [
        { ...record, id: "old", updatedAt: 10 },
        { ...record, id: "new", updatedAt: 20 },
      ],
      99,
    );
    expect(snapshot.topics.map((t) => t.id)).toEqual(["new", "old"]);
    expect(snapshot).toMatchObject({ available: true, active: null, publishedAt: 99 });
    expect(snapshot.busy).toBeUndefined();
  });

  it("derives active from the running topic's latest turn", () => {
    const snapshot = btwSnapshotFromRecords(
      [
        {
          ...record,
          id: "t1",
          status: "running",
          answer: "partial",
          updatedAt: 30,
          followUps: [
            { ...turn, question: "follow", status: "running", answer: "streaming", createdAt: 30, updatedAt: 31 },
          ],
        },
      ],
      99,
    );
    // The running card shows what is being answered: the latest turn's question.
    expect(snapshot.active).toEqual({
      topicId: "t1",
      question: "follow",
      answer: "streaming",
    });
  });

  it("skips malformed entries and tolerates an empty list", () => {
    const snapshot = btwSnapshotFromRecords(
      [{ nope: true }, null, "x", { ...record, id: "good" }],
      1,
    );
    expect(snapshot.topics.map((t) => t.id)).toEqual(["good"]);
    expect(btwSnapshotFromRecords([], 1).topics).toEqual([]);
  });
});

describe("applyBtwRecord", () => {
  const base = btwSnapshotFromRecords([{ ...record, id: "a", updatedAt: 5 }], 1);

  it("replaces a known topic and inserts an unknown one, newest first", () => {
    const replaced = applyBtwRecord(base, parseBtwRecord(JSON.stringify({ ...record, id: "a", answer: "fresh", updatedAt: 6 }))!);
    expect(replaced.topics).toHaveLength(1);
    expect(replaced.topics[0]).toMatchObject({ id: "a", answer: "fresh" });

    const inserted = applyBtwRecord(base, parseBtwRecord(JSON.stringify({ ...record, id: "b", updatedAt: 7 }))!);
    expect(inserted.topics.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("clears the refusal line and re-derives active", () => {
    const refused = { ...base, busy: "A side question is still running" };
    const running = applyBtwRecord(refused, parseBtwRecord(JSON.stringify({ ...record, id: "a", status: "running", updatedAt: 8 }))!);
    expect(running.busy).toBeUndefined();
    expect(running.active).toEqual({ topicId: "a", question: "why?", answer: "because" });
    const done = applyBtwRecord(running, parseBtwRecord(JSON.stringify({ ...record, id: "a", updatedAt: 9 }))!);
    expect(done.active).toBeNull();
  });

  it("re-titles nothing on a follow-up record: the root question stays the title", () => {
    const follow = applyBtwRecord(
      base,
      parseBtwRecord(
        JSON.stringify({
          ...record,
          id: "a",
          status: "running",
          updatedAt: 10,
          followUps: [{ ...turn, question: "and then?", status: "running", createdAt: 10, updatedAt: 11 }],
        }),
      )!,
    );
    expect(follow.topics[0]?.question).toBe("why?");
    expect(follow.active).toEqual({ topicId: "a", question: "and then?", answer: "because" });
  });
});

describe("applyBtwDelta", () => {
  const running = btwSnapshotFromRecords(
    [{ ...record, id: "a", status: "running", answer: "par", updatedAt: 5 }],
    1,
  );

  it("appends to the running topic's latest answer", () => {
    const next = applyBtwDelta(running, "a", "tial")!;
    expect(next.topics[0]).toMatchObject({ answer: "partial" });
    expect(next.topics[0]?.turns[0]?.answer).toBe("partial");
    expect(next.active).toEqual({ topicId: "a", question: "why?", answer: "partial" });
  });

  it("drops a delta for an unknown id or a finished topic", () => {
    expect(applyBtwDelta(running, "ghost", "x")).toBe(running);
    const done = applyBtwRecord(null, parseBtwRecord(JSON.stringify({ ...record, id: "a" }))!);
    expect(applyBtwDelta(done, "a", "x")).toBe(done);
  });

  it("appends to the latest turn of a follow-up topic, not the root", () => {
    const followed = btwSnapshotFromRecords(
      [
        {
          ...record,
          id: "a",
          status: "complete",
          answer: "root answer",
          updatedAt: 5,
          followUps: [{ ...turn, question: "and then?", status: "running", answer: "par", createdAt: 6, updatedAt: 7 }],
        },
      ],
      1,
    );
    const next = applyBtwDelta(followed, "a", "tial")!;
    expect(next.topics[0]?.turns.map((t) => t.answer)).toEqual(["root answer", "partial"]);
    expect(next.topics[0]?.answer).toBe("partial");
  });

  it("has nothing to append to without a snapshot", () => {
    expect(applyBtwDelta(null, "a", "x")).toBeNull();
  });
});
