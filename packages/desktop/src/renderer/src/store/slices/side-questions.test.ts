// The `/btw` command family in a native tab (issue #682): what the composer
// dispatches, what the pane's verbs send, and how a published snapshot lands.
import { beforeEach, describe, expect, it } from "vitest";
import {
  BTW_COMMAND,
  BTW_QUESTION_CHAR_LIMIT,
  BTW_STATUS_KEY,
  type BtwSnapshot,
} from "@omp-ui/core/side-questions";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

function snapshot(patch: Partial<BtwSnapshot> = {}): BtwSnapshot {
  return { available: true, active: null, topics: [], publishedAt: 1, ...patch };
}

function publish(text: string): void {
  h.useStore.getState().handleRpcFrame(h.TAB, {
    type: "extension_ui_request",
    id: "frame-" + Math.random().toString(36).slice(2),
    method: "setStatus",
    statusKey: BTW_STATUS_KEY,
    statusText: text,
  });
}

function prompts(): string[] {
  return h.sent
    .filter(({ cmd }) => cmd.type === "prompt" && typeof cmd.message === "string")
    .map(({ cmd }) => String(cmd.message));
}

/** Runs a composer line, answering every rpc call it makes before awaiting. */
async function runLine(line: string): Promise<void> {
  const promise = h.useStore.getState().runSlashCommand(h.TAB, line);
  for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, {}, true);
  await promise;
}

function setup(mode: "rpc-ui" | "pty", sideQuestions: BtwSnapshot | null = null): void {
  h.backendState = h.stateWithRecord("sess-1");
  h.sent.length = 0;
  h.useStore.setState({
    state: h.backendState,
    tabs: [tabInfo({ tabId: h.TAB, mode })],
    rpc: { [h.TAB]: rpcTabState({ sideQuestions }) },
    railPaneFocus: {},
  });
}

const items = (): unknown[] => h.useStore.getState().rpc[h.TAB]?.items ?? [];

describe("native /btw (issue #682)", () => {
  beforeEach(() => setup("rpc-ui"));

  it("sends one quiet hidden ask frame, opens the pane, and adds no transcript row", async () => {
    await runLine("/btw what did we just change?");
    const sent = prompts();
    expect(sent).toHaveLength(1);
    expect(sent[0].startsWith(`/${BTW_COMMAND} ask `)).toBe(true);
    expect(JSON.parse(sent[0].slice(`/${BTW_COMMAND} ask `.length))).toMatchObject({
      question: "what did we just change?",
    });
    // Nothing carried the literal line to the model.
    expect(sent.filter((message) => message.startsWith("/btw"))).toEqual([]);
    expect(items()).toEqual([]);
    expect(h.useStore.getState().railPaneFocus[h.TAB]).toMatchObject({ pane: "btw", nonce: 1 });
  });

  it("bare /btw refreshes and focuses the pane without asking anything", async () => {
    await runLine("/btw");
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0].startsWith(`/${BTW_COMMAND} refresh `)).toBe(true);
    expect(items()).toEqual([]);
    expect(h.useStore.getState().railPaneFocus[h.TAB]?.pane).toBe("btw");
  });

  it("does not treat /btwfoo as the command", async () => {
    await runLine("/btwfoo bar");
    expect(prompts().some((message) => message.startsWith(`/${BTW_COMMAND}`))).toBe(false);
  });

  it("refuses an over-limit question locally and never sends the frame", async () => {
    await h.useStore.getState().askSideQuestion(h.TAB, "x".repeat(BTW_QUESTION_CHAR_LIMIT + 1));
    expect(prompts()).toEqual([]);
    expect(h.useStore.getState().rpc[h.TAB]?.sideQuestions?.busy).toMatch(/too long/);
  });

  it("refuses a question locally while one is active", async () => {
    setup("rpc-ui", snapshot({ active: { topicId: "t", question: "q", answer: "" } }));
    await h.useStore.getState().askSideQuestion(h.TAB, "another");
    expect(prompts()).toEqual([]);
    const current = h.useStore.getState().rpc[h.TAB]?.sideQuestions;
    expect(current?.busy).toMatch(/still running/);
    // The refusal keeps the running card and topics standing.
    expect(current?.active?.topicId).toBe("t");
  });

  it("carries the topic id on a follow-up and sends cancel as its own frame", async () => {
    const asking = h.useStore.getState().askSideQuestion(h.TAB, "and then?", "topic-1");
    for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, {}, true);
    await asking;
    expect(JSON.parse(prompts()[0].slice(`/${BTW_COMMAND} ask `.length))).toMatchObject({
      question: "and then?",
      topicId: "topic-1",
    });

    h.sent.length = 0;
    const cancelling = h.useStore.getState().cancelSideQuestion(h.TAB);
    for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, {}, true);
    await cancelling;
    expect(prompts()[0].startsWith(`/${BTW_COMMAND} cancel `)).toBe(true);
  });

  it("adopts a published snapshot and keeps the last good one across a malformed publish", () => {
    const good = snapshot({ publishedAt: 7 });
    publish(JSON.stringify(good));
    expect(h.useStore.getState().rpc[h.TAB]?.sideQuestions).toEqual(good);
    publish("{not json");
    publish(JSON.stringify({ available: "yes" }));
    expect(h.useStore.getState().rpc[h.TAB]?.sideQuestions).toEqual(good);
  });
});

describe("terminal tabs keep omp's own /btw (issue #682)", () => {
  it("forwards the line verbatim and opens no pane", async () => {
    setup("pty");
    await runLine("/btw hi");
    expect(prompts()).toEqual(["/btw hi"]);
    expect(h.useStore.getState().railPaneFocus).toEqual({});
  });
});
