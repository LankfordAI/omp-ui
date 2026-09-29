// The Agents pane's steer/kill/revive verbs (issue #684): what each dispatch
// sends, how a published result settles it, and when a verb refuses locally.
import { beforeEach, describe, expect, it } from "vitest";
import {
  SUBAGENT_CONTROL_COMMAND,
  SUBAGENT_CONTROL_STATUS_KEY,
  SUBAGENT_STEER_CHAR_LIMIT,
  type SubagentControlSnapshot,
} from "@omp-ui/core/subagent-control";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

const TOOL_PREFIX = "/" + SUBAGENT_CONTROL_COMMAND + " tool ";

function snapshot(patch: Partial<SubagentControlSnapshot> = {}): SubagentControlSnapshot {
  return {
    available: true,
    processKey: "p-1",
    revision: 1,
    results: [],
    ...patch,
  };
}

function publish(text: string): void {
  h.useStore.getState().handleRpcFrame(h.TAB, {
    type: "extension_ui_request",
    id: "frame-" + Math.random().toString(36).slice(2),
    method: "setStatus",
    statusKey: SUBAGENT_CONTROL_STATUS_KEY,
    statusText: text,
  });
}

function controlPrompts(): string[] {
  return h.sent
    .filter(({ cmd }) => cmd.type === "prompt" && typeof cmd.message === "string")
    .map(({ cmd }) => String(cmd.message))
    .filter((message) => message.startsWith(TOOL_PREFIX));
}

type ControlRequest = {
  requestId: string;
  agentId: string;
  action: "steer" | "kill" | "revive";
  text?: string;
};

/** Reads one control frame's request out with runtime checks (test boundary). */
function requestOf(frame: string): ControlRequest {
  const envelope: unknown = JSON.parse(frame.slice(TOOL_PREFIX.length));
  const request: unknown =
    typeof envelope === "object" && envelope !== null && "request" in envelope
      ? envelope.request
      : null;
  if (
    typeof request !== "object" ||
    request === null ||
    !("requestId" in request) ||
    typeof request.requestId !== "string" ||
    !("agentId" in request) ||
    typeof request.agentId !== "string" ||
    !("action" in request) ||
    typeof request.action !== "string"
  )
    throw new Error("not a control frame: " + frame);
  const text = "text" in request ? request.text : undefined;
  return {
    requestId: request.requestId,
    agentId: request.agentId,
    action: request.action as ControlRequest["action"],
    ...(typeof text === "string" ? { text } : {}),
  };
}

let revision = 1;

/** Publishes an ok settle for every control frame sent so far. */
function settleSent(): void {
  revision += 1;
  publish(
    JSON.stringify(
      snapshot({
        revision,
        results: controlPrompts().map((frame, index) => ({
          ...requestOf(frame),
          ok: true,
          at: index + 2,
        })),
      }),
    ),
  );
}

/** Runs one verb, answering its ack and publishing its settle before awaiting. */
async function verb(run: () => Promise<void>): Promise<void> {
  const promise = run();
  for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, {}, true);
  settleSent();
  await promise;
}

function setup(subagentControl: SubagentControlSnapshot | null = null): void {
  h.backendState = h.stateWithRecord("sess-1");
  h.sent.length = 0;
  revision = 1;
  h.useStore.setState({
    state: h.backendState,
    tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui" })],
    rpc: { [h.TAB]: rpcTabState({ subagentControl }) },
  });
}

const runtime = () => h.useStore.getState().rpc[h.TAB];

describe("subagent control verbs (issue #684)", () => {
  beforeEach(() => setup());

  it("steer sends one quiet hidden frame, settles on its publish, and adds no transcript row", async () => {
    await verb(() => h.useStore.getState().steerSubagent(h.TAB, "agent-1", "try the other route"));
    const [frame] = controlPrompts();
    expect(requestOf(frame!)).toEqual({
      agentId: "agent-1",
      action: "steer",
      text: "try the other route",
      requestId: requestOf(frame!).requestId,
    });
    expect(runtime()?.items).toEqual([]);
    expect(runtime()?.subagentControlBusy).toEqual({});
    expect(runtime()?.subagentControlError).toBeNull();
    expect(runtime()?.subagentControl?.results).toHaveLength(1);
  });

  it("kill and revive send their own frames and refresh the roster once settled", async () => {
    await verb(() => h.useStore.getState().killSubagent(h.TAB, "agent-1"));
    expect(requestOf(controlPrompts()[0]!).action).toBe("kill");
    expect(h.sent.some(({ cmd }) => cmd.type === "get_subagents")).toBe(true);
    h.sent.length = 0;
    await verb(() => h.useStore.getState().reviveSubagent(h.TAB, "agent-9"));
    const request = requestOf(controlPrompts()[0]!);
    expect(request.action).toBe("revive");
    expect(request.agentId).toBe("agent-9");
  });

  it("holds busy state until the result publish lands", async () => {
    const promise = h.useStore.getState().killSubagent(h.TAB, "agent-1");
    for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, {}, true);
    expect(runtime()?.subagentControlBusy).toEqual({ "agent-1": "kill" });
    settleSent();
    await promise;
    expect(runtime()?.subagentControlBusy).toEqual({});
  });

  it("refuses locally when the frame never reaches the bridge", async () => {
    const promise = h.useStore.getState().killSubagent(h.TAB, "agent-1");
    for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, "child died", false);
    await promise;
    expect(runtime()?.subagentControlError).toBe(
      "the subagent bridge never received that request",
    );
    expect(runtime()?.subagentControlBusy).toEqual({});
  });

  it("refuses an over-limit steer before sending anything", async () => {
    await h.useStore
      .getState()
      .steerSubagent(h.TAB, "agent-1", "x".repeat(SUBAGENT_STEER_CHAR_LIMIT + 1));
    expect(controlPrompts()).toEqual([]);
    expect(runtime()?.subagentControlError).toContain(String(SUBAGENT_STEER_CHAR_LIMIT));
  });

  it("refuses an empty steer before sending anything", async () => {
    await h.useStore.getState().steerSubagent(h.TAB, "agent-1", "   ");
    expect(controlPrompts()).toEqual([]);
    expect(runtime()?.subagentControlError).toBeNull();
  });

  it("refuses a second verb for the same agent while one is in flight", async () => {
    const promise = h.useStore.getState().killSubagent(h.TAB, "agent-1");
    const before = h.sent.length;
    await h.useStore.getState().steerSubagent(h.TAB, "agent-1", "too soon");
    expect(h.sent.length).toBe(before);
    for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, {}, true);
    settleSent();
    await promise;
    expect(runtime()?.subagentControlBusy).toEqual({});
  });

  it("clears a stale refusal when a new dispatch starts", async () => {
    await h.useStore
      .getState()
      .steerSubagent(h.TAB, "agent-1", "x".repeat(SUBAGENT_STEER_CHAR_LIMIT + 1));
    expect(runtime()?.subagentControlError).not.toBeNull();
    await verb(() => h.useStore.getState().killSubagent(h.TAB, "agent-1"));
    expect(runtime()?.subagentControlError).toBeNull();
  });
});

describe("subagent control snapshot acceptance (issue #684)", () => {
  it("adopts a newer same-process publish and keeps the last good one otherwise", () => {
    setup(snapshot({ revision: 5 }));
    publish(JSON.stringify(snapshot({ revision: 6 })));
    expect(runtime()?.subagentControl?.revision).toBe(6);
    publish(JSON.stringify(snapshot({ revision: 6 })));
    expect(runtime()?.subagentControl?.revision).toBe(6);
    publish("{not json");
    expect(runtime()?.subagentControl?.revision).toBe(6);
  });

  it("a new processKey always replaces the retained snapshot", () => {
    setup(snapshot({ revision: 9 }));
    publish(JSON.stringify(snapshot({ processKey: "p-2", revision: 1 })));
    expect(runtime()?.subagentControl?.processKey).toBe("p-2");
  });
});
