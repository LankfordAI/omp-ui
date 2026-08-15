import { describe, expect, it } from "vitest";
import type { RenderItem } from "./transcript";
import { reduceSubagentFrame, SUBAGENT_BUFFER_CAP, subagentKey } from "./subagent-events";

describe("subagentKey", () => {
  it("prefers the payload id over the display name (issue #62)", () => {
    const frame = {
      type: "subagent_progress",
      payload: { id: "s1", agent: "scout", progress: { agent: "renamed" } },
    };
    expect(subagentKey(frame)).toBe("s1");
  });

  it("falls back through agent names to a neutral key", () => {
    expect(subagentKey({ payload: { agent: "scout" } })).toBe("scout");
    expect(subagentKey({ payload: { progress: { agent: "task" } } })).toBe("task");
    expect(subagentKey({ payload: {} })).toBe("subagent");
    expect(subagentKey({})).toBe("subagent");
  });
});

describe("reduceSubagentFrame", () => {
  it("turns a plain text payload into an assistant render item", () => {
    const items = reduceSubagentFrame([], {
      type: "subagent_event",
      payload: { id: "s1", text: "mapping the store" },
    });
    expect(items).toEqual([
      expect.objectContaining({ kind: "assistant", text: "mapping the store", streaming: false }),
    ]);
  });

  it("accepts message-shaped content as assistant text", () => {
    const items = reduceSubagentFrame([], {
      type: "subagent_event",
      payload: { id: "s1", progress: { message: "still thinking" } },
    });
    expect(items).toEqual([
      expect.objectContaining({ kind: "assistant", text: "still thinking" }),
    ]);
  });

  it("reduces an AgentSessionEvent-shaped payload through reduceEvent", () => {
    const items = reduceSubagentFrame([], {
      type: "subagent_event",
      payload: {
        id: "s1",
        event: {
          type: "message_start",
          message: { role: "user", content: [{ type: "text", text: "scout this" }] },
        },
      },
    });
    expect(items).toEqual([expect.objectContaining({ kind: "user", text: "scout this" })]);
  });

  it("falls back to a marker for a bare status", () => {
    const items = reduceSubagentFrame([], {
      type: "subagent_lifecycle",
      payload: { id: "s1", agent: "scout", status: "started" },
    });
    expect(items).toEqual([expect.objectContaining({ kind: "marker", label: "started" })]);
  });

  it("adds nothing for unknown or empty shapes", () => {
    const frames: unknown[] = [
      { type: "subagent_event", payload: { id: "s1" } },
      { type: "subagent_event", payload: { id: "s1", progress: {} } },
      { type: "subagent_event" },
      { type: "subagent_event", payload: { id: "s1", index: 3 } },
    ];
    for (const frame of frames) {
      const items: RenderItem[] = [];
      expect(reduceSubagentFrame(items, frame)).toBe(items);
    }
  });

  it("dedupes consecutive identical entries, so heartbeats never flood the buffer", () => {
    const heartbeat = () => ({
      type: "subagent_progress",
      payload: { id: "s1", progress: { status: "running" } },
    });
    let items: RenderItem[] = [];
    items = reduceSubagentFrame(items, heartbeat());
    const afterSecond = reduceSubagentFrame(items, heartbeat());
    expect(afterSecond).toHaveLength(1);
    // A genuine change still lands after a deduped run.
    const afterText = reduceSubagentFrame(afterSecond, {
      type: "subagent_event",
      payload: { id: "s1", text: "done mapping" },
    });
    expect(afterText).toHaveLength(2);
  });

  it("caps the buffer, dropping the oldest render items", () => {
    let items: RenderItem[] = [];
    for (let i = 0; i < SUBAGENT_BUFFER_CAP + 5; i++) {
      items = reduceSubagentFrame(items, {
        type: "subagent_event",
        payload: { id: "s1", text: `note ${i}` },
      });
    }
    expect(items).toHaveLength(SUBAGENT_BUFFER_CAP);
    expect(items[0]).toMatchObject({ text: "note 5" });
    expect(items.at(-1)).toMatchObject({ text: `note ${SUBAGENT_BUFFER_CAP + 4}` });
  });

  it("caps retained buffers at SUBAGENT_BUFFER_CAP by default", () => {
    let items: RenderItem[] = [];
    for (let i = 0; i < SUBAGENT_BUFFER_CAP + 10; i++) {
      items = reduceSubagentFrame(items, {
        type: "subagent_event",
        payload: { id: "s1", text: `line ${i}` },
      });
    }
    expect(items).toHaveLength(SUBAGENT_BUFFER_CAP);
    expect(items.at(-1)).toMatchObject({ text: `line ${SUBAGENT_BUFFER_CAP + 9}` });
  });

  it("does not truncate when the viewed agent's cap is lifted", () => {
    let items: RenderItem[] = [];
    for (let i = 0; i < SUBAGENT_BUFFER_CAP + 10; i++) {
      items = reduceSubagentFrame(
        items,
        { type: "subagent_event", payload: { id: "s1", text: `line ${i}` } },
        false,
      );
    }
    expect(items).toHaveLength(SUBAGENT_BUFFER_CAP + 10);
  });
});
