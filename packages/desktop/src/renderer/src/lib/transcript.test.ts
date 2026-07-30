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

  it("keeps image blocks on a pasted user message", () => {
    // The shape omp actually emits: images follow the single text block, and
    // omp re-encodes on ingest, so a pasted PNG comes back as webp.
    const items = reduceEvent([], {
      type: "message_start",
      message: {
        role: "user",
        content: [
          { type: "text", text: "what colour?" },
          { type: "image", data: "AAAB", mimeType: "image/webp" },
          { type: "image", data: "AAAC", mimeType: "image/png" },
        ],
      },
    });
    expect(items[0]).toMatchObject({
      kind: "user",
      text: "what colour?",
      images: [
        { data: "AAAB", mimeType: "image/webp" },
        { data: "AAAC", mimeType: "image/png" },
      ],
    });
  });

  it("carries images on a text-free user message", () => {
    // An image alone is a legitimate prompt, so it must not reduce to nothing.
    const items = reduceEvent([], {
      type: "message_start",
      message: { role: "user", content: [{ type: "image", data: "AAAB", mimeType: "image/png" }] },
    });
    expect(items[0]).toMatchObject({ kind: "user", text: "" });
    expect((items[0] as { images?: unknown[] }).images).toHaveLength(1);
  });

  it("leaves images undefined on a text-only message", () => {
    const items = reduceEvent([], {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "plain" }] },
    });
    expect((items[0] as { images?: unknown[] }).images).toBeUndefined();
  });

  it("drops an image block with no data rather than rendering a broken img", () => {
    const items = reduceEvent([], {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "x" }, { type: "image", mimeType: "image/png" }],
      },
    });
    expect((items[0] as { images?: unknown[] }).images).toBeUndefined();
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

  it("extracts usage, model and timings from an assistant message_end", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    items = reduceEvent(items, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "done" },
    });
    items = reduceEvent(items, {
      type: "message_end",
      message: {
        role: "assistant",
        model: "claude-opus-5",
        provider: "anthropic",
        stopReason: "stop",
        duration: 4200,
        ttft: 610,
        usage: {
          input: 12,
          output: 34,
          cacheRead: 5,
          cacheWrite: 6,
          totalTokens: 57,
          cost: { input: 0.1, output: 0.2, total: 0.3 },
        },
        // Megabytes of raw provider response ride along on every message_end.
        providerPayload: { huge: "x".repeat(1000) },
      },
    });
    const a = assistant(items);
    expect(a).toMatchObject({
      text: "done",
      streaming: false,
      model: "claude-opus-5",
      provider: "anthropic",
      stopReason: "stop",
      durationMs: 4200,
      ttftMs: 610,
    });
    expect(a?.usage).toEqual({
      input: 12,
      output: 34,
      cacheRead: 5,
      cacheWrite: 6,
      total: 57,
      cost: 0.3,
    });
    expect(a).not.toHaveProperty("providerPayload");
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

  it("captures the start intent as the card headline", () => {
    const items = reduceEvent([], {
      type: "tool_execution_start",
      toolCallId: "t3",
      toolName: "read",
      intent: "Reading hello.txt",
    });
    expect(tool(items, "t3")).toMatchObject({ intent: "Reading hello.txt", status: "running" });
  });

  it("tool_execution_update streams partial text without ending the run", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, {
      type: "tool_execution_start",
      toolCallId: "t4",
      toolName: "bash",
    });
    items = reduceEvent(items, {
      type: "tool_execution_update",
      toolCallId: "t4",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "line 1" }] },
    });
    expect(tool(items, "t4")).toMatchObject({ partialText: "line 1", status: "running" });

    items = reduceEvent(items, {
      type: "tool_execution_update",
      toolCallId: "t4",
      partialResult: { content: [{ type: "text", text: "line 1\nline 2" }] },
    });
    expect(tool(items, "t4")?.partialText).toBe("line 1\nline 2");
  });

  it("an update for an unknown toolCallId is ignored", () => {
    const items = reduceEvent([], {
      type: "tool_execution_update",
      toolCallId: "nobody",
      partialResult: { content: [{ type: "text", text: "x" }] },
    });
    expect(items).toEqual([]);
  });

  it("extracts path and op from edit details", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, {
      type: "tool_execution_start",
      toolCallId: "t5",
      toolName: "edit",
    });
    items = reduceEvent(items, {
      type: "tool_execution_end",
      toolCallId: "t5",
      result: { content: [], details: { path: "src/a.ts", op: "update", diff: "+1|x" } },
    });
    expect(tool(items, "t5")).toMatchObject({ path: "src/a.ts", op: "update" });
  });

  it("extracts the read path from details.meta.source.value", () => {
    const items = reduceEvent([], {
      type: "tool_execution_end",
      toolCallId: "t6",
      toolName: "read",
      result: {
        content: [],
        details: { meta: { source: { type: "file", value: "docs/readme.md" } } },
      },
    });
    expect(tool(items, "t6")?.path).toBe("docs/readme.md");
  });

  it("extracts wallTimeMs from bash details", () => {
    const items = reduceEvent([], {
      type: "tool_execution_end",
      toolCallId: "t7",
      toolName: "bash",
      result: { content: [], details: { timeoutSeconds: 30, wallTimeMs: 1234 } },
    });
    expect(tool(items, "t7")?.wallTimeMs).toBe(1234);
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
      "auto_compaction_start",
      "auto_compaction_end",
      "auto_retry_start",
      "auto_retry_end",
      "retry_fallback_applied",
      "retry_succeeded",
      "todo_reminder",
      "todo_auto_clear",
      "agent_end",
    ]) {
      items = reduceEvent(items, { type });
    }
    expect(items).toHaveLength(10);
    expect(items.every((i) => i.kind === "marker")).toBe(true);
  });

  it("stays silent on turn boundaries", () => {
    // One live prompt emitted four turn pairs; rendering them buried the
    // actual content. agent_start/agent_end already bracket the exchange.
    let items: RenderItem[] = [];
    for (let i = 0; i < 4; i++) {
      items = reduceEvent(items, { type: "turn_start" });
      items = reduceEvent(items, { type: "turn_end" });
    }
    expect(items).toEqual([]);
  });

  it("tones markers by meaning: liveness signal, attention copper", () => {
    const toneOf = (type: string): string | undefined => {
      const item = reduceEvent([], { type })[0];
      return item?.kind === "marker" ? item.tone : undefined;
    };
    expect(toneOf("agent_start")).toBe("neutral");
    expect(toneOf("agent_end")).toBe("signal");
    expect(toneOf("retry_succeeded")).toBe("signal");
    expect(toneOf("auto_compaction_start")).toBe("copper");
    expect(toneOf("auto_retry_end")).toBe("copper");
    expect(toneOf("retry_fallback_applied")).toBe("copper");
    expect(toneOf("todo_reminder")).toBe("copper");
  });

  it("renders notice and irc_message", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, { type: "notice", message: "watch out" });
    items = reduceEvent(items, { type: "irc_message", from: "agent-2", text: "ping" });
    expect(items[0]).toMatchObject({ kind: "notice", text: "watch out" });
    expect(items[1]).toMatchObject({ kind: "irc", from: "agent-2", text: "ping" });
  });

  it("reads irc from the nested CustomMessage payload omp actually sends", () => {
    const items = reduceEvent([], {
      type: "irc_message",
      message: {
        role: "custom",
        customType: "irc:incoming",
        content: "[IRC `scout` → `main`]\n\nrendered template",
        details: { id: "m1", from: "scout", message: "found it" },
      },
    });
    expect(items[0]).toMatchObject({ kind: "irc", from: "scout", text: "found it" });
  });

  it("carries notice level and source, folding omp's 'warning' onto 'warn'", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, {
      type: "notice",
      level: "warning",
      source: "advisor",
      message: "slow down",
    });
    items = reduceEvent(items, { type: "notice", level: "error", message: "boom" });
    items = reduceEvent(items, { type: "notice", level: "bogus", message: "shrug" });
    expect(items[0]).toMatchObject({ kind: "notice", level: "warn", source: "advisor" });
    expect(items[1]).toMatchObject({ kind: "notice", level: "error" });
    expect(items[2]).toMatchObject({ kind: "notice", level: undefined });
  });

  it("renders thinking_level_changed and goal_updated as markers", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, { type: "thinking_level_changed", thinkingLevel: "high" });
    items = reduceEvent(items, { type: "goal_updated" });
    expect(items[0]).toMatchObject({ kind: "marker", label: "thinking level: high" });
    expect(items[1]).toMatchObject({ kind: "marker", label: "goal updated" });
  });

  it("renders ttsr_triggered as a copper rule-interrupt marker", () => {
    const items = reduceEvent([], {
      type: "ttsr_triggered",
      rules: [{ name: "no-any", path: "/r/no-any.md", content: "" }],
    });
    expect(items[0]).toMatchObject({
      kind: "marker",
      label: "rule interrupt: no-any",
      tone: "copper",
    });
  });

  it("warns once per unknown type and never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let items: RenderItem[] = [];
    items = reduceEvent(items, { type: "brand_new_event", foo: 1 });
    items = reduceEvent(items, { type: "brand_new_event", foo: 2 });
    items = reduceEvent(items, { type: "another_new_event" });
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

  it("restores images on a resumed session's user messages", () => {
    // Reopening a session goes through get_messages, not the event stream, so
    // the attachments have to survive that path too or they vanish on resume.
    const items = historyToItems([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", data: "AAAB", mimeType: "image/webp" },
        ],
      },
    ]);
    expect(items[0]).toMatchObject({
      kind: "user",
      text: "what is this?",
      images: [{ data: "AAAB", mimeType: "image/webp" }],
    });
  });

  it("carries assistant usage/model and toolResult path/op out of stored history", () => {
    const items = historyToItems([
      {
        role: "assistant",
        model: "claude-opus-5",
        stopReason: "stop",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.01 } },
        content: [{ type: "toolCall", id: "c9", name: "write", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "c9",
        content: [{ type: "text", text: "wrote" }],
        details: { path: "src/new.ts", op: "create" },
      },
    ]);
    expect(assistant(items)).toMatchObject({ model: "claude-opus-5", stopReason: "stop" });
    expect(assistant(items)?.usage).toMatchObject({ total: 3, cost: 0.01 });
    expect(tool(items, "c9")).toMatchObject({ path: "src/new.ts", op: "create" });
  });

  it("skips malformed entries without throwing", () => {
    const items = historyToItems(["junk", null, { role: "user", content: "hi" }]);
    expect(items).toHaveLength(1);
  });
});
