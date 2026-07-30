import { afterEach, describe, expect, it, vi } from "vitest";
import {
  historyToItems,
  isAdvisorMessage,
  reduceEvent,
  type AssistantItem,
  type RenderItem,
  type ToolItem,
} from "./transcript";

afterEach(() => {
  vi.restoreAllMocks();
});

function assistant(items: RenderItem[]): AssistantItem | undefined {
  return items.find((i): i is AssistantItem => i.kind === "assistant");
}

function tool(items: RenderItem[], toolCallId: string): ToolItem | undefined {
  return items.find((i): i is ToolItem => i.kind === "tool" && i.toolCallId === toolCallId);
}

describe("reduceEvent message lifecycle", () => {
  it("streams user → assistant text deltas → end", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    items = reduceEvent(items, { type: "message_start", message: { role: "assistant", content: [] } });
    items = reduceEvent(items, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hi" },
    });
    items = reduceEvent(items, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " there" },
    });
    items = reduceEvent(items, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    });
    items = reduceEvent(items, { type: "message_end", message: { role: "assistant" } });

    expect(items[0]).toMatchObject({ kind: "user", text: "hello" });
    const a = assistant(items);
    expect(a).toMatchObject({ text: "Hi there", thinking: "hmm", streaming: false });
  });

  it("creates a streaming item when deltas arrive without message_start", () => {
    const items = reduceEvent([], {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "orphan" },
    });
    expect(assistant(items)).toMatchObject({ text: "orphan", streaming: true });
  });

  it("renders a completed assistant message from message_end alone", () => {
    const items = reduceEvent([], {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "final" }] },
    });
    expect(assistant(items)).toMatchObject({ text: "final", streaming: false });
  });

  it("accepts string content as well as blocks", () => {
    const items = reduceEvent([], {
      type: "message_start",
      message: { role: "user", content: "plain string" },
    });
    expect(items[0]).toMatchObject({ kind: "user", text: "plain string" });
  });
});

describe("reduceEvent tool executions", () => {
  it("runs start → end with diff and notes", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "edit",
      args: { path: "a.ts" },
    });
    expect(tool(items, "t1")).toMatchObject({ status: "running", name: "edit" });

    items = reduceEvent(items, {
      type: "tool_execution_end",
      toolCallId: "t1",
      result: {
        content: [{ type: "text", text: "edited" }],
        details: { diff: "+1|x", notes: [{ note: "careful", severity: "concern", advisor: "sec" }] },
      },
    });
    const t = tool(items, "t1");
    expect(t).toMatchObject({ status: "done", resultText: "edited" });
    expect(t?.diff).toEqual([{ kind: "add", lineNum: 1, text: "x" }]);
    expect(t?.notes).toEqual([{ note: "careful", severity: "concern", advisor: "sec" }]);
  });

  it("marks isError results as error", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, { type: "tool_execution_start", toolCallId: "t2", toolName: "bash" });
    items = reduceEvent(items, {
      type: "tool_execution_end",
      toolCallId: "t2",
      isError: true,
      result: { content: [{ type: "text", text: "exit 1" }] },
    });
    expect(tool(items, "t2")?.status).toBe("error");
  });

  it("creates a done item for an unmatched end", () => {
    const items = reduceEvent([], {
      type: "tool_execution_end",
      toolCallId: "ghost",
      result: { content: [] },
    });
    expect(tool(items, "ghost")).toMatchObject({ status: "done" });
  });
});

describe("reduceEvent advisory cards", () => {
  const advisorMessage = {
    role: "custom",
    customType: "advisor",
    content: "<advisory>xml not parsed</advisory>",
    details: { notes: [{ note: "Hardcoded key", severity: "blocker", advisor: "security" }] },
  };

  it("renders from details.notes on message_start", () => {
    const items = reduceEvent([], { type: "message_start", message: advisorMessage });
    expect(items[0]).toMatchObject({
      kind: "advisory",
      notes: [{ note: "Hardcoded key", severity: "blocker", advisor: "security" }],
    });
  });

  it("does not duplicate the card when message_end repeats the message", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, { type: "message_start", message: advisorMessage });
    items = reduceEvent(items, { type: "message_end", message: advisorMessage });
    expect(items.filter((i) => i.kind === "advisory")).toHaveLength(1);
  });

  it("isAdvisorMessage ports the custom/advisor rule", () => {
    expect(isAdvisorMessage(advisorMessage)).toBe(true);
    expect(isAdvisorMessage({ role: "assistant" })).toBe(false);
    expect(isAdvisorMessage({ role: "custom", customType: "other" })).toBe(false);
  });
});

describe("reduceEvent markers, notice, irc, unknowns", () => {
  it("emits quiet marker rows for lifecycle events", () => {
    let items: RenderItem[] = [];
    for (const type of [
      "agent_start",
      "turn_start",
      "auto_compaction_start",
      "auto_compaction_end",
      "auto_retry_start",
      "auto_retry_end",
      "retry_fallback_applied",
      "retry_succeeded",
      "todo_reminder",
      "todo_auto_clear",
      "turn_end",
      "agent_end",
    ]) {
      items = reduceEvent(items, { type });
    }
    expect(items).toHaveLength(12);
    expect(items.every((i) => i.kind === "marker")).toBe(true);
  });

  it("renders notice and irc_message", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, { type: "notice", message: "watch out" });
    items = reduceEvent(items, { type: "irc_message", from: "agent-2", text: "ping" });
    expect(items[0]).toMatchObject({ kind: "notice", text: "watch out" });
    expect(items[1]).toMatchObject({ kind: "irc", from: "agent-2", text: "ping" });
  });

  it("renders thinking_level_changed and goal_updated as markers", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, { type: "thinking_level_changed", thinkingLevel: "high" });
    items = reduceEvent(items, { type: "goal_updated" });
    expect(items[0]).toMatchObject({ kind: "marker", label: "thinking level: high" });
    expect(items[1]).toMatchObject({ kind: "marker", label: "goal updated" });
  });

  it("warns once per unknown type and never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let items: RenderItem[] = [];
    items = reduceEvent(items, { type: "ttsr_triggered" });
    items = reduceEvent(items, { type: "ttsr_triggered" });
    items = reduceEvent(items, { type: "brand_new_event", foo: 1 });
    items = reduceEvent(items, "garbage");
    items = reduceEvent(items, 42);
    expect(items).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("historyToItems", () => {
  it("pairs tool calls with results and folds advisor messages", () => {
    const items = historyToItems([
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "editing" },
          { type: "toolCall", id: "c1", name: "edit", arguments: { path: "a" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        content: [{ type: "text", text: "ok" }],
        details: { diff: "-2|old\n+2|new" },
      },
      {
        role: "custom",
        customType: "advisor",
        content: "<advisory/>",
        details: { notes: [{ note: "nitpick", severity: "nit", advisor: "style" }] },
      },
    ]);

    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "advisory"]);
    const a = assistant(items);
    expect(a).toMatchObject({ text: "editing", thinking: "plan", streaming: false });
    const t = tool(items, "c1");
    expect(t).toMatchObject({ status: "done", resultText: "ok" });
    expect(t?.diff).toEqual([
      { kind: "del", lineNum: 2, text: "old" },
      { kind: "add", lineNum: 2, text: "new" },
    ]);
    expect(items[3]).toMatchObject({
      kind: "advisory",
      notes: [{ note: "nitpick", severity: "nit", advisor: "style" }],
    });
  });

  it("skips malformed entries without throwing", () => {
    const items = historyToItems(["junk", null, { role: "user", content: "hi" }]);
    expect(items).toHaveLength(1);
  });
});
