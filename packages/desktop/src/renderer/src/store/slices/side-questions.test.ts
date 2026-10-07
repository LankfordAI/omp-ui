// The native `/btw` command family in a native tab (issue #775): what the
// composer dispatches, what the pane's verbs send, and how the command
// responses land as snapshots. omp ≥ 18.6.3 owns the run; below the floor the
// slice dispatches nothing.
import { beforeEach, describe, expect, it } from "vitest";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
import {
  BTW_QUESTION_CHAR_LIMIT,
  type BtwSnapshot,
} from "@omp-ui/core/side-questions";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

function capabilities(ompVersion: string | null): CapabilitySnapshot {
  return {
    version: 1,
    processKey: "p",
    sessionId: null,
    revision: 1,
    updatedAt: 0,
    ompVersion,
    skillCommandsEnabled: null,
    skills: { status: "unavailable", reason: "missing-api" },
    tools: { status: "unavailable", reason: "missing-api" },
    magicKeywords: { status: "unavailable", reason: "missing-api" },
    toolControl: "unsupported",
    toolMutation: null,
  };
}

const record = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  question: "why?",
  answer: "because",
  status: "complete",
  createdAt: 1,
  updatedAt: 2,
  leafId: null,
  ...patch,
});

function snapshot(patch: Partial<BtwSnapshot> = {}): BtwSnapshot {
  return { available: true, active: null, topics: [], publishedAt: 1, ...patch };
}

/** Runs a composer line, answering every rpc call it makes before awaiting. */
async function runLine(line: string): Promise<void> {
  const promise = h.useStore.getState().runSlashCommand(h.TAB, line);
  for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, {}, true);
  await promise;
}

function setup(
  mode: "rpc-ui" | "pty",
  sideQuestions: BtwSnapshot | null = null,
  ompVersion: string | null = "18.7.0",
): void {
  h.backendState = h.stateWithRecord("sess-1");
  h.sent.length = 0;
  h.useStore.setState({
    state: h.backendState,
    tabs: [tabInfo({ tabId: h.TAB, mode })],
    rpc: {
      [h.TAB]: rpcTabState({ sideQuestions, capabilities: capabilities(ompVersion) }),
    },
    railPaneFocus: {},
  });
}

const items = (): unknown[] => h.useStore.getState().rpc[h.TAB]?.items ?? [];
const commands = (type: string): Record<string, unknown>[] =>
  h.sent.filter(({ cmd }) => cmd.type === type).map(({ cmd }) => cmd);

describe("native /btw (issue #775)", () => {
  beforeEach(() => setup("rpc-ui"));

  it("dispatches the native btw command, opens the pane, and adds no transcript row", async () => {
    await runLine("/btw what did we just change?");
    const asked = commands("btw");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ question: "what did we just change?" });
    // Nothing carried the literal line to the model.
    expect(commands("prompt")).toEqual([]);
    expect(items()).toEqual([]);
    expect(h.useStore.getState().railPaneFocus[h.TAB]).toMatchObject({ pane: "btw", nonce: 1 });
  });

  it("bare /btw refreshes and focuses the pane without asking anything", async () => {
    await runLine("/btw");
    expect(commands("btw")).toEqual([]);
    expect(commands("get_btw_history")).toHaveLength(1);
    expect(items()).toEqual([]);
    expect(h.useStore.getState().railPaneFocus[h.TAB]?.pane).toBe("btw");
  });

  it("does not treat /btwfoo as the command", async () => {
    await runLine("/btwfoo bar");
    expect(commands("btw")).toEqual([]);
    expect(commands("get_btw_history")).toEqual([]);
  });

  it("refuses an over-limit question locally and never dispatches", async () => {
    await h.useStore.getState().askSideQuestion(h.TAB, "x".repeat(BTW_QUESTION_CHAR_LIMIT + 1));
    expect(h.sent).toEqual([]);
    expect(h.useStore.getState().rpc[h.TAB]?.sideQuestions?.busy).toMatch(/too long/);
  });

  it("refuses a question locally while one is active", async () => {
    setup("rpc-ui", snapshot({ active: { topicId: "t", question: "q", answer: "" } }));
    await h.useStore.getState().askSideQuestion(h.TAB, "another");
    expect(h.sent).toEqual([]);
    const current = h.useStore.getState().rpc[h.TAB]?.sideQuestions;
    expect(current?.busy).toMatch(/still running/);
    // The refusal keeps the running card and topics standing.
    expect(current?.active?.topicId).toBe("t");
  });

  it("an omp below the native floor dispatches nothing", async () => {
    setup("rpc-ui", null, "18.6.2");
    await h.useStore.getState().askSideQuestion(h.TAB, "anything");
    await h.useStore.getState().refreshSideQuestions(h.TAB);
    expect(h.sent).toEqual([]);
    // Silence, not a false refusal: the pane renders the unavailable line.
    expect(h.useStore.getState().rpc[h.TAB]?.sideQuestions).toBeNull();
  });

  it("applies the running record the btw response carries", async () => {
    const asking = h.useStore.getState().askSideQuestion(h.TAB, "what changed?");
    const [sent] = [...h.sent];
    h.respond(sent.tabId, sent.cmd, { record: record("t1", { question: "what changed?", status: "running", answer: "", updatedAt: 3 }) }, true);
    await asking;
    expect(h.useStore.getState().rpc[h.TAB]?.sideQuestions).toMatchObject({
      available: true,
      active: { topicId: "t1", question: "what changed?", answer: "" },
      topics: [{ id: "t1", question: "what changed?", status: "running" }],
    });
  });

  it("carries the topic id as recordId on a follow-up", async () => {
    const asking = h.useStore.getState().askSideQuestion(h.TAB, "and then?", "topic-1");
    for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, {}, true);
    await asking;
    expect(commands("btw")[0]).toMatchObject({ question: "and then?", recordId: "topic-1" });
  });

  it("cancel dispatches btw_cancel and a healed cancel refreshes the history", async () => {
    const cancelling = h.useStore.getState().cancelSideQuestion(h.TAB);
    const [sent] = [...h.sent];
    h.respond(sent.tabId, sent.cmd, { cancelled: true }, true);
    await cancelling;
    expect(commands("btw_cancel")).toHaveLength(1);
    expect(commands("get_btw_history")).toEqual([]);

    h.sent.length = 0;
    const raced = h.useStore.getState().cancelSideQuestion(h.TAB);
    const [again] = [...h.sent];
    h.respond(again.tabId, again.cmd, { cancelled: false }, true);
    for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, { records: [] }, true);
    await raced;
    // The turn finished first: the heal dispatches get_btw_history.
    expect(commands("get_btw_history")).toHaveLength(1);
  });

  it("a refresh adopts the full snapshot from get_btw_history", async () => {
    const refreshing = h.useStore.getState().refreshSideQuestions(h.TAB);
    const [sent] = [...h.sent];
    h.respond(
      sent.tabId,
      sent.cmd,
      {
        records: [
          record("old", { updatedAt: 5 }),
          record("run", { status: "running", answer: "par", updatedAt: 9 }),
        ],
      },
      true,
    );
    await refreshing;
    const snap = h.useStore.getState().rpc[h.TAB]?.sideQuestions;
    expect(snap?.topics.map((t) => t.id)).toEqual(["run", "old"]);
    expect(snap?.active).toEqual({ topicId: "run", question: "why?", answer: "par" });
    expect(snap?.busy).toBeUndefined();
  });

  it("a failed command refuses with the sendFailed line", async () => {
    const asking = h.useStore.getState().askSideQuestion(h.TAB, "anything");
    const [sent] = [...h.sent];
    h.respond(sent.tabId, sent.cmd, "A /btw question is still running; cancel it first", false);
    await asking;
    expect(h.useStore.getState().rpc[h.TAB]?.sideQuestions?.busy).toMatch(/could not be sent/);

    h.sent.length = 0;
    const refreshing = h.useStore.getState().refreshSideQuestions(h.TAB);
    const [again] = [...h.sent];
    h.respond(again.tabId, again.cmd, "boom", false);
    await refreshing;
    expect(h.useStore.getState().rpc[h.TAB]?.sideQuestions?.busy).toMatch(/could not be sent/);
  });

  it("a record-less or malformed btw response changes nothing locally", async () => {
    const asking = h.useStore.getState().askSideQuestion(h.TAB, "anything");
    const [sent] = [...h.sent];
    h.respond(sent.tabId, sent.cmd, { record: { bogus: true } }, true);
    await asking;
    // The frames carry the truth; the slice invented nothing.
    expect(h.useStore.getState().rpc[h.TAB]?.sideQuestions).toBeNull();
  });
});

describe("terminal tabs keep omp's own /btw (issue #775)", () => {
  it("forwards the line verbatim and opens no pane", async () => {
    setup("pty");
    await runLine("/btw hi");
    expect(
      h.sent
        .filter(({ cmd }) => cmd.type === "prompt" && typeof cmd.message === "string")
        .map(({ cmd }) => String(cmd.message)),
    ).toEqual(["/btw hi"]);
    expect(h.useStore.getState().railPaneFocus).toEqual({});
  });
});
