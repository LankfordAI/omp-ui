import { describe, expect, it } from "vitest";
import {
  parseTreeSnapshot,
  TREE_PREVIEW_CHAR_LIMIT,
  TREE_STATUS_BYTE_LIMIT,
  treeNavigateMessage,
  TREE_COMMAND,
  TREE_STATUS_KEY,
} from "./session-tree";

const VALID = {
  available: true,
  revision: 3,
  leafId: "e4",
  activePath: ["e1", "e2", "e4"],
  nodes: [
    {
      id: "e1",
      parentId: null,
      type: "message",
      role: "user",
      text: "first prompt",
      timestamp: "2026-09-28T00:00:00.000Z",
    },
    {
      id: "e2",
      parentId: "e1",
      type: "message",
      role: "assistant",
      text: "",
      timestamp: "2026-09-28T00:00:01.000Z",
    },
    {
      id: "e4",
      parentId: "e2",
      type: "compaction",
      text: "compact",
      timestamp: "2026-09-28T00:00:02.000Z",
    },
  ],
};

describe("parseTreeSnapshot", () => {
  it("reads a complete available snapshot", () => {
    const snapshot = parseTreeSnapshot(JSON.stringify(VALID));
    expect(snapshot).toEqual({
      available: true,
      revision: 3,
      leafId: "e4",
      activePath: ["e1", "e2", "e4"],
      nodes: VALID.nodes,
    });
  });

  it("keeps an unavailable snapshot with its reason", () => {
    const snapshot = parseTreeSnapshot(
      JSON.stringify({
        available: false,
        reason: "missing-api",
        revision: 1,
        leafId: null,
        activePath: [],
        nodes: [],
      }),
    );
    expect(snapshot).toEqual({
      available: false,
      reason: "missing-api",
      revision: 1,
      leafId: null,
      activePath: [],
      nodes: [],
    });
  });

  it("reads the navigation result when present", () => {
    const snapshot = parseTreeSnapshot(
      JSON.stringify({
        ...VALID,
        navigation: { entryId: "e5", ok: false, error: "Entry e5 not found" },
      }),
    );
    expect(snapshot?.navigation).toEqual({
      entryId: "e5",
      ok: false,
      error: "Entry e5 not found",
    });
  });

  it("rejects malformed publishes — the last good snapshot stays standing", () => {
    expect(parseTreeSnapshot("not json")).toBeNull();
    expect(parseTreeSnapshot("[]")).toBeNull();
    expect(parseTreeSnapshot(JSON.stringify({ ...VALID, available: "yes" }))).toBeNull();
    expect(parseTreeSnapshot(JSON.stringify({ ...VALID, revision: "3" }))).toBeNull();
    expect(parseTreeSnapshot(JSON.stringify({ ...VALID, activePath: "e1" }))).toBeNull();
    expect(parseTreeSnapshot(JSON.stringify({ ...VALID, nodes: {} }))).toBeNull();
    expect(
      parseTreeSnapshot(
        JSON.stringify({ ...VALID, nodes: [{ id: "x", parentId: null, type: "message" }] }),
      ),
    ).toBeNull();
    // An available snapshot without a leaf id describes no tree.
    expect(parseTreeSnapshot(JSON.stringify({ ...VALID, leafId: null }))).toBeNull();
    expect(parseTreeSnapshot(JSON.stringify({ ...VALID, reason: "nonsense" }))).toBeNull();
  });

  it("rejects anything over the byte budget", () => {
    const huge = {
      ...VALID,
      nodes: [
        {
          id: "e1",
          parentId: null,
          type: "message",
          // Multi-byte characters so the check exercises the UTF-8 scan.
          text: "é".repeat(TREE_STATUS_BYTE_LIMIT / 2 + 1),
          timestamp: "t",
        },
      ],
    };
    expect(parseTreeSnapshot(JSON.stringify(huge))).toBeNull();
  });

  it("names the hidden command family and messages the renderer dispatches", () => {
    expect(TREE_COMMAND).toBe("omp-ui-tree");
    expect(TREE_STATUS_KEY).toBe("omp-ui:tree");
    // The viewer builds its refresh line from TREE_COMMAND directly
    // (`runHiddenCommand`); only navigate needs a message builder here.
    expect(treeNavigateMessage("e5", false)).toBe("/omp-ui-tree navigate e5");
    expect(treeNavigateMessage("e5", true)).toBe("/omp-ui-tree navigate e5 summarize");
    expect(TREE_PREVIEW_CHAR_LIMIT).toBe(160);
  });
});
