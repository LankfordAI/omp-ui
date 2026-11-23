import { describe, expect, it } from "vitest";
import { buildToolNesting, EMPTY_TOOL_NESTING } from "./tool-nesting";
import type { RenderItem, ToolItem } from "./transcript";

/**
 * Nesting fixtures (issue #1274): synthetic rows shaped like what reduceEvent
 * produces for omp 19.1 nested calls — no live omp involved.
 */
function tool(id: string, extra: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id,
    toolCallId: id,
    name: "bash",
    args: { command: "echo hi" },
    status: "done",
    resultText: `out-${id}`,
    ...extra,
  };
}

function assistant(id: string): RenderItem {
  return { kind: "assistant", id, text: "", thinking: "", narration: "", streaming: false };
}

describe("buildToolNesting (issue #1274)", () => {
  it("nests a child whose parentToolCallId matches a rendered tool row", () => {
    const nesting = buildToolNesting([tool("eval-1"), tool("read-1", { parentToolCallId: "eval-1" })]);
    expect(nesting.parentIdByChildId.get("read-1")).toBe("eval-1");
    expect((nesting.childrenByParentId.get("eval-1") ?? []).map((item) => item.id)).toEqual(["read-1"]);
  });

  it("keys the parent lookup by toolCallId, not render-item id", () => {
    // reduceEvent uses toolCallId as the id for its cards, but history rows
    // and synthetic fixtures may differ; the relation reads toolCallIds.
    const parent = tool("card-a", { toolCallId: "call-a" });
    const child = tool("card-b", { toolCallId: "call-b", parentToolCallId: "call-a" });
    const nesting = buildToolNesting([parent, child]);
    expect(nesting.parentIdByChildId.get("card-b")).toBe("card-a");
  });

  it("orders children in transcript order, not call order", () => {
    const nesting = buildToolNesting([
      tool("eval-1"),
      tool("read-2", { parentToolCallId: "eval-1" }),
      assistant("a1"),
      tool("read-1", { parentToolCallId: "eval-1" }),
    ]);
    expect((nesting.childrenByParentId.get("eval-1") ?? []).map((item) => item.id)).toEqual(["read-2", "read-1"]);
  });

  it("nests a child that appears before its parent row", () => {
    // A late tool_execution_start reorders nothing: derivation runs over the
    // full list, so arrival order is irrelevant.
    const nesting = buildToolNesting([tool("read-1", { parentToolCallId: "eval-1" }), tool("eval-1")]);
    expect(nesting.parentIdByChildId.get("read-1")).toBe("eval-1");
  });

  it("leaves an orphan (no rendered parent row) top-level", () => {
    const nesting = buildToolNesting([tool("read-1", { parentToolCallId: "gone" })]);
    expect(nesting.parentIdByChildId.size).toBe(0);
    expect(nesting).toBe(EMPTY_TOOL_NESTING);
  });

  it("refuses a non-tool row as a parent", () => {
    // A render item that happens to carry no tool kind never hosts children:
    // only tool rows build the lookup.
    const items: RenderItem[] = [assistant("eval-1"), tool("read-1", { parentToolCallId: "eval-1" })];
    expect(buildToolNesting(items).parentIdByChildId.size).toBe(0);
  });

  it("treats a self-parent as an orphan", () => {
    const nesting = buildToolNesting([tool("read-1", { parentToolCallId: "read-1" })]);
    expect(nesting.parentIdByChildId.size).toBe(0);
  });

  it("orphans every member of a two-node cycle", () => {
    const nesting = buildToolNesting([
      tool("a", { parentToolCallId: "b" }),
      tool("b", { parentToolCallId: "a" }),
    ]);
    expect(nesting.parentIdByChildId.size).toBe(0);
  });

  it("orphans every member of a longer cycle and keeps its feeder chain attached", () => {
    // c → d → e → c is the cycle; f nests under d. Breaking the cycle leaves
    // d unparented, so f stays nested under d — never dropped.
    const nesting = buildToolNesting([
      tool("c", { parentToolCallId: "d" }),
      tool("d", { parentToolCallId: "e" }),
      tool("e", { parentToolCallId: "c" }),
      tool("f", { parentToolCallId: "d" }),
    ]);
    expect(nesting.parentIdByChildId.has("c")).toBe(false);
    expect(nesting.parentIdByChildId.has("d")).toBe(false);
    expect(nesting.parentIdByChildId.has("e")).toBe(false);
    expect(nesting.parentIdByChildId.get("f")).toBe("d");
  });

  it("keeps deep chains", () => {
    const nesting = buildToolNesting([
      tool("outer"),
      tool("inner", { parentToolCallId: "outer" }),
      tool("innermost", { parentToolCallId: "inner" }),
    ]);
    expect(nesting.parentIdByChildId.get("inner")).toBe("outer");
    expect(nesting.parentIdByChildId.get("innermost")).toBe("inner");
  });

  it("ignores an empty-string parent id like an absent one", () => {
    const nesting = buildToolNesting([tool("a", { parentToolCallId: "" })]);
    expect(nesting).toBe(EMPTY_TOOL_NESTING);
  });

  it("points a duplicate toolCallId at the first rendered row only", () => {
    const first = tool("card-a", { toolCallId: "dup" });
    const second = tool("card-b", { toolCallId: "dup" });
    const nesting = buildToolNesting([first, second, tool("kid", { parentToolCallId: "dup" })]);
    expect(nesting.parentIdByChildId.get("kid")).toBe("card-a");
  });

  it("returns the shared empty relation when nothing nests", () => {
    expect(buildToolNesting([tool("a"), tool("b")])).toBe(EMPTY_TOOL_NESTING);
  });
});
