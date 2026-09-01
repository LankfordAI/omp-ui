import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMatches,
  historyToItems,
  isAdvisorMessage,
  itemSearchText,
  markerItem,
  noticeItem,
  preExchange,
  reduceEvent,
  settleRunningTools,
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
        responseId: "resp-42",
        upstreamProvider: "anthropic-direct",
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
      responseId: "resp-42",
      upstreamProvider: "anthropic-direct",
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

  it("lifts the message timestamp onto the finished assistant item", () => {
    const timestamp = 1_754_404_327_000;
    let items: RenderItem[] = [];
    items = reduceEvent(items, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    items = reduceEvent(items, {
      type: "message_end",
      message: { role: "assistant", timestamp, content: [{ type: "text", text: "done" }] },
    });
    expect(assistant(items)).toMatchObject({ timestamp, streaming: false });
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

describe("run-end tool settlement", () => {
  it("agent_end cancels tools still running and appends the finished marker", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, {
      type: "tool_execution_start",
      toolCallId: "t8",
      toolName: "edit",
    });
    items = reduceEvent(items, { type: "agent_end" });
    expect(tool(items, "t8")?.status).toBe("cancelled");
    expect(items.at(-1)).toMatchObject({ kind: "marker", label: "agent finished" });
  });

  it("agent_end with no running tools leaves prior items untouched by identity", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, { type: "tool_execution_start", toolCallId: "t9", toolName: "bash" });
    items = reduceEvent(items, {
      type: "tool_execution_end",
      toolCallId: "t9",
      result: { content: [] },
    });
    const settled = tool(items, "t9");
    const after = reduceEvent(items, { type: "agent_end" });
    expect(tool(after, "t9")).toBe(settled);
  });

  it("settleRunningTools returns the same array by identity when nothing runs", () => {
    const items = reduceEvent([], {
      type: "tool_execution_end",
      toolCallId: "t10",
      result: { content: [] },
    });
    expect(settleRunningTools(items)).toBe(items);
  });

  it("agent_end after an error message_end aborts running tools", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, {
      type: "tool_execution_start",
      toolCallId: "tA",
      toolName: "ask",
    });
    items = reduceEvent(items, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Findings:" }],
        stopReason: "error",
        errorMessage: "OpenAI responses stream stalled while waiting for the next event",
      },
    });
    items = reduceEvent(items, { type: "agent_end" });
    expect(tool(items, "tA")?.status).toBe("aborted");
  });

  it("agent_end after a user-interrupt message_end keeps cancelled", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, {
      type: "tool_execution_start",
      toolCallId: "tB",
      toolName: "bash",
    });
    items = reduceEvent(items, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "on it" }], stopReason: "aborted" },
    });
    items = reduceEvent(items, { type: "agent_end" });
    expect(tool(items, "tB")?.status).toBe("cancelled");
  });

  it("settleRunningTools honors an explicit settled target", () => {
    const items = reduceEvent([], {
      type: "tool_execution_start",
      toolCallId: "tC",
      toolName: "bash",
    });
    expect(tool(settleRunningTools(items, "aborted"), "tC")?.status).toBe("aborted");
    expect(tool(settleRunningTools(items, "cancelled"), "tC")?.status).toBe("cancelled");
  });
});

describe("reduceEvent tool-call args streaming (issue #97)", () => {
  const partialWith = (args: unknown, extra: Record<string, unknown> = {}) => ({
    role: "assistant",
    content: [
      { type: "text", text: "let me write that" },
      { type: "toolCall", id: "w1", name: "write", arguments: args, ...extra },
    ],
  });
  const update = (type: string, fields: Record<string, unknown>) => ({
    type: "message_update",
    assistantMessageEvent: { type, contentIndex: 1, ...fields },
  });

  it("streams a growing write draft into one running card", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, update("toolcall_start", { partial: partialWith({}) }));
    expect(tool(items, "w1")).toMatchObject({ status: "running", argsStreaming: true, name: "write" });

    items = reduceEvent(
      items,
      update("toolcall_delta", { delta: "x", partial: partialWith({ path: "/tmp/a.py", content: "print(" }) }),
    );
    expect(tool(items, "w1")?.args).toEqual({ path: "/tmp/a.py", content: "print(" });

    items = reduceEvent(
      items,
      update("toolcall_end", {
        toolCall: { type: "toolCall", id: "w1", name: "write", arguments: { path: "/tmp/a.py", content: "print(1)" } },
      }),
    );
    const t = tool(items, "w1");
    expect(t).toMatchObject({ status: "running", argsStreaming: false });
    expect(t?.args).toEqual({ path: "/tmp/a.py", content: "print(1)" });
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(1);
  });

  it("tool_execution_start merges into the streamed card instead of duplicating", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, update("toolcall_start", { partial: partialWith({}) }));
    items = reduceEvent(items, {
      type: "tool_execution_start",
      toolCallId: "w1",
      toolName: "write",
      args: { path: "/tmp/a.py", content: "print(1)" },
      intent: "Writing a.py",
    });
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(1);
    expect(tool(items, "w1")).toMatchObject({
      status: "running",
      argsStreaming: false,
      intent: "Writing a.py",
      args: { path: "/tmp/a.py", content: "print(1)" },
    });
  });

  it("a turn aborted mid-generation settles the streaming card to cancelled", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, update("toolcall_start", { partial: partialWith({ content: "half" }) }));
    items = reduceEvent(items, { type: "agent_end" });
    expect(tool(items, "w1")?.status).toBe("cancelled");
  });

  it("a later message's call at the same contentIndex gets its own card", () => {
    let items: RenderItem[] = [];
    items = reduceEvent(items, update("toolcall_start", { partial: partialWith({}) }));
    items = reduceEvent(
      items,
      update("toolcall_end", {
        toolCall: { type: "toolCall", id: "w1", name: "write", arguments: {} },
      }),
    );
    const second = {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        partial: {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "toolCall", id: "w2", name: "write", arguments: {} },
          ],
        },
      },
    };
    items = reduceEvent(items, second);
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(2);
    expect(tool(items, "w2")).toMatchObject({ status: "running", argsStreaming: true });
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

  it("labels auto_retry_start with attempt, budget, and retry delay (issue #100)", () => {
    const item = reduceEvent([], { type: "auto_retry_start", attempt: 2, maxAttempts: 10, delayMs: 4000 })[0];
    expect(item).toMatchObject({
      kind: "marker",
      label: "auto-retry 2/10 started — retrying in 4.0s",
      tone: "copper",
    });
  });

  it("labels a recovered auto_retry_end as retry succeeded (issue #100)", () => {
    const item = reduceEvent([], { type: "auto_retry_end", success: true, attempt: 2 })[0];
    expect(item).toMatchObject({ kind: "marker", label: "retry succeeded", tone: "signal" });
  });

  it("labels a failed auto_retry_end with the clipped final error (issue #100)", () => {
    const item = reduceEvent([], {
      type: "auto_retry_end",
      success: false,
      attempt: 10,
      finalError: "e".repeat(200),
    })[0];
    if (item?.kind !== "marker") throw new Error("expected a marker");
    expect(item.label.startsWith("auto-retry failed: ")).toBe(true);
    expect(item.label.length).toBeLessThanOrEqual(140);
    expect(item.label.endsWith("…")).toBe(true);
    expect(item.tone).toBe("rose");
  });

  it("labels retry_fallback_applied with the provider switch (issue #100)", () => {
    const item = reduceEvent([], {
      type: "retry_fallback_applied",
      from: "openrouter/kimi",
      to: "anthropic/claude",
      role: "default",
    })[0];
    expect(item).toMatchObject({
      kind: "marker",
      label: "retry fallback: openrouter/kimi → anthropic/claude",
      tone: "copper",
    });
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
        responseId: "resp-77",
        upstreamProvider: "anthropic-direct",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.01 } },
        content: [{ type: "toolCall", id: "c9", name: "write", arguments: {} }],
        // Megabytes of raw provider response ride along on stored history too.
        providerPayload: { huge: "x".repeat(1000) },
      },
      {
        role: "toolResult",
        toolCallId: "c9",
        content: [{ type: "text", text: "wrote" }],
        details: { path: "src/new.ts", op: "create" },
      },
    ]);
    expect(assistant(items)).toMatchObject({
      model: "claude-opus-5",
      stopReason: "stop",
      responseId: "resp-77",
      upstreamProvider: "anthropic-direct",
    });
    expect(assistant(items)?.usage).toMatchObject({ total: 3, cost: 0.01 });
    expect(assistant(items)).not.toHaveProperty("providerPayload");
    expect(tool(items, "c9")).toMatchObject({ path: "src/new.ts", op: "create" });
  });

  it("carries the assistant timestamp out of stored history", () => {
    const timestamp = 1_754_404_327_000;
    const items = historyToItems([
      { role: "assistant", timestamp, content: [{ type: "text", text: "hi" }] },
    ]);
    expect(assistant(items)).toMatchObject({ timestamp });
  });

  it("skips malformed entries without throwing", () => {
    const items = historyToItems(["junk", null, { role: "user", content: "hi" }]);
    expect(items).toHaveLength(1);
  });
});

describe("preExchange", () => {
  it("is true for an empty transcript", () => {
    expect(preExchange([])).toBe(true);
  });

  it("is true for ambient notices and markers only", () => {
    expect(preExchange([noticeItem("xd:// mounted"), markerItem("THINKING LEVEL")])).toBe(true);
  });

  const exchangeItems: [string, RenderItem][] = [
    ["user", { kind: "user", id: "u1", text: "hello" }],
    ["assistant", { kind: "assistant", id: "a1", text: "hi", thinking: "", streaming: false }],
    ["tool", { kind: "tool", id: "t1", toolCallId: "c1", name: "read", args: {}, status: "done" }],
    ["plan", { kind: "plan", id: "p1", title: "Ship it", planFilePath: "PLAN.md", planAbsPath: null, text: null, status: "pending" }],
    ["advisory", { kind: "advisory", id: "ad1", notes: [] }],
    ["irc", { kind: "irc", id: "i1", from: "Main", text: "ping" }],
  ];

  it.each(exchangeItems)("is false once a %s item is present", (_kind, item) => {
    expect(preExchange([noticeItem("n"), item])).toBe(false);
  });
});

describe("itemSearchText", () => {
  it("includes the assistant's thinking beside its text", () => {
    const item: RenderItem = { kind: "assistant", id: "a1", text: "Ship it", thinking: "hmm, let me check", streaming: false };

    const text = itemSearchText(item);
    expect(text).toContain("Ship it");
    expect(text).toContain("hmm, let me check");
  });

  it("includes a tool's intent, args and resultText", () => {
    const item: RenderItem = {
      kind: "tool",
      id: "t1",
      toolCallId: "c1",
      name: "bash",
      args: { command: "deploy.sh --env staging" },
      status: "done",
      intent: "Running the deploy script",
      resultText: "Deployed to staging",
    };
    const text = itemSearchText(item);
    expect(text).toContain("Running the deploy script");
    expect(text).toContain("deploy.sh --env staging");
    expect(text).toContain("Deployed to staging");
  });

  it("includes a command's output", () => {
    const item: RenderItem = { kind: "command", id: "c1", name: "mcp", args: "", status: "done", output: "3 servers online" };
    expect(itemSearchText(item)).toContain("3 servers online");
  });

  it("is a marker's label", () => {
    expect(itemSearchText(markerItem("THINKING LEVEL"))).toBe("THINKING LEVEL");
  });
});

describe("findMatches", () => {
  const items: RenderItem[] = [
    { kind: "user", id: "u1", text: "Ship the FIND bar" },
    { kind: "assistant", id: "a1", text: "Find is Find, the bar is small", thinking: "", streaming: false },
    { kind: "user", id: "u2", text: "unrelated" },
    { kind: "user", id: "u3", text: "then ship find" },
  ];

  it("matches case-insensitively as a literal substring", () => {
    expect(findMatches(items, "FIND")).toEqual(["u1", "a1", "u3"]);
  });

  it("transcript order, one id per matching item", () => {
    expect(findMatches(items, "find")).toEqual(["u1", "a1", "u3"]);
  });

  it("excludes non-matching items", () => {
    expect(findMatches(items, "the FIND bar")).toEqual(["u1"]);
    expect(findMatches(items, "no-such-token")).toEqual([]);
  });

  it("returns [] for an empty or whitespace query", () => {
    expect(findMatches(items, "")).toEqual([]);
    expect(findMatches(items, "   ")).toEqual([]);
  });
});

describe("item timestamps (issue #273)", () => {
  const FIXED = Date.parse("2026-08-24T12:00:00.000Z");

  it("stamps a live user item off the message timestamp, falling back to Date.now", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(FIXED));
      const stamped = reduceEvent([], {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1234 },
      });
      expect(stamped[0]).toMatchObject({ kind: "user", timestamp: 1234 });
      const fallback = reduceEvent([], {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      });
      expect(fallback[0]).toMatchObject({ kind: "user", timestamp: FIXED });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps live tool cards at creation in both branches; later updates do not re-stamp", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(FIXED));
      const streamed = reduceEvent([], {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          partial: {
            content: [{ type: "toolCall", id: "c1", name: "write", arguments: {} }],
          },
        },
      });
      expect(tool(streamed, "c1")).toMatchObject({ timestamp: FIXED });

      const exec = reduceEvent([], {
        type: "tool_execution_start",
        toolCallId: "c2",
        toolName: "edit",
      });
      expect(tool(exec, "c2")).toMatchObject({ timestamp: FIXED });

      vi.setSystemTime(new Date(FIXED + 1000));
      const again = reduceEvent(streamed, {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "write",
      });
      expect(tool(again, "c1")).toMatchObject({ timestamp: FIXED });
    } finally {
      vi.useRealTimers();
    }
  });

  it("backfills user and tool timestamps from entry fields; toolResult never overwrites", () => {
    const items = historyToItems([
      { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 111 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c9", name: "write", arguments: {} }],
        timestamp: 222,
      },
      {
        role: "toolResult",
        toolCallId: "c9",
        content: [{ type: "text", text: "ok" }],
        details: { path: "/a.txt", op: "write", timestamp: 333 },
      },
    ]);
    const u = items.find((i) => i.kind === "user");
    expect(u).toMatchObject({ timestamp: 111 });
    expect(tool(items, "c9")).toMatchObject({ timestamp: 222, path: "/a.txt", op: "write" });
  });

  it("markerItem stamps Date.now() by default and honors an explicit timestamp", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(FIXED));
      expect(markerItem("auto-compaction started")).toMatchObject({ timestamp: FIXED });
      expect(markerItem("auto-retry 1/3 started", "copper", 42)).toMatchObject({ timestamp: 42 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("backfill synthesizes no markers", () => {
    const items = historyToItems([
      { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
      { role: "custom", customType: "advisor", content: "note", timestamp: 3 },
    ]);
    expect(items.some((i) => i.kind === "marker")).toBe(false);
  });
});
