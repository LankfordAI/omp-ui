import { describe, expect, it } from "vitest";
import type { RenderItem } from "./transcript";
import {
  correlatePromptEntry,
  discardedEntryCount,
  entryUserPrompt,
  visiblePromptEntries,
} from "./session-rewind";

// Entry fixtures mirror omp 18.4.2's get_entries payloads (probed): every
// entry carries {type, id, parentId, timestamp}; messages carry the message.

function userEntry(id: string, parentId: string | null, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-28T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantEntry(id: string, parentId: string | null, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-28T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 1, output: 1, cost: { total: 0 } },
    },
  };
}

function imageEntry(
  id: string,
  parentId: string | null,
  data = "aGVsbG8=",
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-28T00:00:00.000Z",
    message: {
      role: "user",
      content: [{ type: "image", data, mimeType: "image/png" }],
    },
  };
}

function compactionEntry(
  id: string,
  parentId: string | null,
  firstKeptEntryId: string,
): Record<string, unknown> {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-09-28T00:00:00.000Z",
    summary: "compressed history",
    firstKeptEntryId,
  };
}

function userItem(text: string, images?: { data: string; mimeType: string }[]): RenderItem {
  return {
    kind: "user",
    id: `user-${text}`,
    text,
    ...(images === undefined ? {} : { images }),
  };
}

describe("visiblePromptEntries", () => {
  it("walks a linear leaf path root-first", () => {
    const entries = [
      userEntry("e1", null, "first"),
      assistantEntry("e2", "e1", "answer"),
      userEntry("e3", "e2", "second"),
    ];
    expect(visiblePromptEntries(entries, "e3")).toEqual([
      { entryId: "e1", text: "first", images: [] },
      { entryId: "e3", text: "second", images: [] },
    ]);
  });

  it("excludes sibling branches from the walk", () => {
    const entries = [
      userEntry("e1", null, "first"),
      assistantEntry("e2", "e1", "answer"),
      userEntry("e3", "e2", "kept branch"),
      userEntry("e4", "e3", "current leaf"),
      // A rewind's abandoned sibling: same parent as e3, off the leaf path.
      userEntry("e5", "e2", "abandoned branch"),
    ];
    expect(visiblePromptEntries(entries, "e4")).toEqual([
      { entryId: "e1", text: "first", images: [] },
      { entryId: "e3", text: "kept branch", images: [] },
      { entryId: "e4", text: "current leaf", images: [] },
    ]);
  });

  it("drops entries before an on-path compaction's firstKeptEntryId", () => {
    const entries = [
      userEntry("e1", null, "pre-compaction"),
      assistantEntry("e2", "e1", "answer"),
      compactionEntry("e3", "e2", "e4"),
      userEntry("e4", "e3", "kept"),
      userEntry("e5", "e4", "current"),
    ];
    expect(visiblePromptEntries(entries, "e5")).toEqual([
      { entryId: "e4", text: "kept", images: [] },
      { entryId: "e5", text: "current", images: [] },
    ]);
  });

  it("ignores an off-path compaction entry entirely", () => {
    const entries = [
      userEntry("e1", null, "first"),
      assistantEntry("e2", "e1", "answer"),
      userEntry("e3", "e2", "current"),
      // A sibling branch's compaction: its firstKeptEntryId must not truncate.
      compactionEntry("e4", "e2", "e1"),
    ];
    expect(visiblePromptEntries(entries, "e3")).toEqual([
      { entryId: "e1", text: "first", images: [] },
      { entryId: "e3", text: "current", images: [] },
    ]);
  });

  it("ignores a compaction whose firstKeptEntryId is off the path", () => {
    const entries = [
      userEntry("e1", null, "first"),
      userEntry("e2", "e1", "second"),
      assistantEntry("aux", null, "unrelated root"),
      compactionEntry("c", "e1", "aux"),
      userEntry("e3", "e2", "current"),
    ];
    expect(visiblePromptEntries(entries, "e3")).toEqual([
      { entryId: "e1", text: "first", images: [] },
      { entryId: "e2", text: "second", images: [] },
      { entryId: "e3", text: "current", images: [] },
    ]);
  });

  it("keeps an image-only prompt's position with empty text", () => {
    const entries = [
      userEntry("e1", null, "first"),
      imageEntry("e2", "e1"),
      userEntry("e3", "e2", "after the image"),
    ];
    const prompts = visiblePromptEntries(entries, "e3");
    expect(prompts).toEqual([
      { entryId: "e1", text: "first", images: [] },
      {
        entryId: "e2",
        text: "",
        images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
      },
      { entryId: "e3", text: "after the image", images: [] },
    ]);
  });

  it("returns null for a leaf the entries never carried", () => {
    expect(visiblePromptEntries([userEntry("e1", null, "only")], "missing")).toBeNull();
  });

  it("returns null for a dangling parent or a cycle", () => {
    expect(
      visiblePromptEntries([userEntry("e2", "e1", "orphan")], "e2"),
    ).toBeNull();
    const cyclic = [
      { type: "message", id: "a", parentId: "b", message: { role: "user", content: [] } },
      { type: "message", id: "b", parentId: "a", message: { role: "user", content: [] } },
    ];
    expect(visiblePromptEntries(cyclic, "a")).toBeNull();
  });

  it("returns null when the leaf id is not a string", () => {
    expect(visiblePromptEntries([userEntry("e1", null, "one")], undefined)).toBeNull();
    expect(visiblePromptEntries([userEntry("e1", null, "one")], null)).toBeNull();
  });
});

describe("correlatePromptEntry", () => {
  const LINEAR = [
    userEntry("e1", null, "first"),
    assistantEntry("e2", "e1", "answer"),
    userEntry("e3", "e2", "second"),
  ];

  it("maps positions to leaf-path user entries", () => {
    const items = [userItem("first"), assistant("a1", "answer"), userItem("second")];
    expect(correlatePromptEntry(items, LINEAR, "e3", 0)).toBe("e1");
    expect(correlatePromptEntry(items, LINEAR, "e3", 1)).toBe("e3");
  });

  it("refuses when the clicked row's text drifted", () => {
    const items = [userItem("edited locally"), userItem("second")];
    expect(correlatePromptEntry(items, LINEAR, "e3", 0)).toBeNull();
    expect(correlatePromptEntry(items, LINEAR, "e3", 1)).toBe("e3");
  });

  it("refuses on an image-count mismatch", () => {
    const items = [
      userItem("", [{ data: "x", mimeType: "image/png" }]),
      userItem("second"),
    ];
    expect(correlatePromptEntry(items, LINEAR, "e3", 0)).toBeNull();
  });

  it("tolerates a tail entry the transcript has not rendered yet", () => {
    const entries = [...LINEAR, userEntry("e4", "e3", "just sent")];
    const items = [userItem("first"), userItem("second")];
    // Position 1 exists on both sides; the extra entry is the beat-ahead tail.
    expect(correlatePromptEntry(items, entries, "e4", 1)).toBe("e3");
    // A position only the entries side has is refused.
    expect(correlatePromptEntry(items, entries, "e4", 2)).toBeNull();
  });

  it("refuses when transcript rows outnumber the leaf-path entries", () => {
    const items = [userItem("first"), userItem("second"), userItem("phantom")];
    expect(correlatePromptEntry(items, LINEAR, "e3", 2)).toBeNull();
  });

  it("never matches beyond either list", () => {
    const items = [userItem("first"), userItem("second")];
    expect(correlatePromptEntry(items, LINEAR, "e3", 2)).toBeNull();
    expect(correlatePromptEntry(items, LINEAR, "e3", -1)).toBeNull();
  });
});

function assistant(id: string, text: string): RenderItem {
  return { kind: "assistant", id, text, thinking: "", streaming: false };
}

describe("entryUserPrompt", () => {
  it("reduces a user entry by id without positional correlation", () => {
    const entries = [userEntry("e1", null, "first"), assistantEntry("e2", "e1", "answer")];
    expect(entryUserPrompt(entries, "e1")).toEqual({
      entryId: "e1",
      text: "first",
      images: [],
    });
  });

  it("refuses non-message and non-user entries — branch would throw on them", () => {
    const entries = [
      assistantEntry("a1", null, "answer"),
      compactionEntry("c1", "a1", "a1"),
    ];
    expect(entryUserPrompt(entries, "a1")).toBeNull();
    expect(entryUserPrompt(entries, "c1")).toBeNull();
    expect(entryUserPrompt(entries, "missing")).toBeNull();
  });
});

describe("discardedEntryCount", () => {
  //   e1 ─ a2 ─ e3 ─ a4   (leaf)
  //        └── e5          (abandoned sibling)
  const TREE = [
    userEntry("e1", null, "first"),
    assistantEntry("a2", "e1", "answer one"),
    userEntry("e3", "a2", "second"),
    assistantEntry("a4", "e3", "answer two"),
    userEntry("e5", "a2", "rewound sibling"),
  ];

  it("counts leaf-chain entries below the common ancestor", () => {
    expect(discardedEntryCount(TREE, "a4", "e5")).toBe(2); // e3, a4
    expect(discardedEntryCount(TREE, "a4", "a2")).toBe(2);
    expect(discardedEntryCount(TREE, "a4", "e3")).toBe(1); // a4 only
    expect(discardedEntryCount(TREE, "a4", "a4")).toBe(0); // the leaf itself
  });

  it("is null when either id is unknown or the leaf is malformed", () => {
    expect(discardedEntryCount(TREE, "a4", "missing")).toBeNull();
    expect(discardedEntryCount(TREE, undefined, "e5")).toBeNull();
  });
});
