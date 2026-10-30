// Seance consult (issue #885): the composer line is intercepted in native
// tabs and opens the dialog (never forwarded as prose); below the version
// floor nothing dispatches; the launch is either one composed prompt in the
// hosting tab or a spawn-then-prompt consult session that never wakes the
// source.
import { beforeEach, describe, expect, it } from "vitest";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
import type { SessionSummary } from "@omp-ui/core/types";
import { remoteOwnedState, rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

// The harness owns the window-stub ordering (no test file imports ../store
// statically); the slice module is pure, but reach it dynamically anyway.
async function resolveSeanceSource(
  state: Parameters<typeof import("../../store/slices/seance").resolveSeanceSource>[0],
  instanceId: string | null,
  token: string,
): Promise<{ sourceSession: string; sourceLabel: string; private: boolean } | null> {
  const mod = await import("../../store/slices/seance");
  return mod.resolveSeanceSource(state, instanceId, token);
}

const FRESH = "consult-1";

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

function setup(
  mode: "rpc-ui" | "pty",
  ompVersion: string | null = "18.12.0",
): void {
  h.backendState = h.stateWithRecord("sess-1", "dormant");
  h.sent.length = 0;
  h.useStore.setState({
    state: h.backendState,
    tabs: [tabInfo({ tabId: h.TAB, mode, projectCwd: "/p" })],
    rpc: { [h.TAB]: rpcTabState({ capabilities: capabilities(ompVersion) }) },
    railPaneFocus: {},
    seanceDialog: null,
  });
}

/** Runs a composer line, answering every rpc call it makes before awaiting. */
async function runLine(line: string): Promise<void> {
  const promise = h.useStore.getState().runSlashCommand(h.TAB, line);
  for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, {}, true);
  await promise;
}

const items = (tabId: string = h.TAB): unknown[] =>
  h.useStore.getState().rpc[tabId]?.items ?? [];
const prompts = (): Record<string, unknown>[] =>
  h.sent.filter(({ cmd }) => cmd.type === "prompt").map(({ cmd }) => cmd);
const notices = (tabId: string = h.TAB): string[] =>
  (items(tabId) as { kind: string; text?: string }[])
    .filter((item) => item.kind === "notice")
    .map((item) => item.text ?? "");
/** Answers every command sent so far and returns their wire messages. */
function answerSent(): string[] {
  return h.sent.splice(0).map(({ tabId, cmd }) => {
    h.respond(tabId, cmd, {});
    return String(cmd.message ?? cmd.type);
  });
}

describe("composer /seance (issue #885)", () => {
  beforeEach(() => setup("rpc-ui"));

  it("opens the dialog pre-filled, focuses the Seance pane, and consumes the line", async () => {
    await runLine("/seance 019faeab --model anthropic/a:b");
    expect(h.useStore.getState().seanceDialog).toEqual({
      projectCwd: "/p",
      instanceId: null,
      sourceTabId: h.TAB,
      prefill: { source: "019faeab", model: "anthropic/a:b" },
    });
    expect(h.useStore.getState().railPaneFocus[h.TAB]).toMatchObject({ pane: "seance", nonce: 1 });
    // Nothing carried the literal line to the model.
    expect(prompts()).toEqual([]);
    expect(items()).toEqual([]);
  });

  it("bare /seance opens an empty dialog on the tab's project", async () => {
    await runLine("/seance");
    const dialog = h.useStore.getState().seanceDialog;
    expect(dialog?.sourceTabId).toBe(h.TAB);
    expect(dialog?.prefill).toBeUndefined();
  });

  it("refuses a bad flag with the usage notice and still consumes the line", async () => {
    await runLine("/seance --fast");
    expect(notices().join("\n")).toContain("usage: /seance [session id|path] [--model selector]");
    expect(h.useStore.getState().seanceDialog).toBeNull();
    expect(prompts()).toEqual([]);
  });

  it("below the version floor the pane opens, nothing launches, and the line is consumed", async () => {
    setup("rpc-ui", "18.11.2");
    await runLine("/seance what did we decide?");
    expect(h.useStore.getState().railPaneFocus[h.TAB]?.pane).toBe("seance");
    expect(notices().join("\n")).toContain("18.11.3");
    expect(h.useStore.getState().seanceDialog).toBeNull();
    expect(prompts()).toEqual([]);
  });

  it("falls through to the TUI in a terminal tab", async () => {
    setup("pty");
    await runLine("/seance old-session");
    // The verbatim line reached omp as the unknown-command prompt fallback.
    expect(String(prompts()[0]?.message)).toBe("/seance old-session");
    expect(h.useStore.getState().seanceDialog).toBeNull();
  });
});

describe("launchSeanceConsult (issue #885)", () => {
  it("in place: one composed prompt on the ready host, no spawn", async () => {
    setup("rpc-ui");
    const launch = h.useStore.getState().launchSeanceConsult(
      {
        projectCwd: "/p",
        instanceId: null,
        tabId: h.TAB,
        sourceSession: "/s/lineage/transcript.jsonl",
        sourceLabel: "Deadlock investigation",
      },
      "Why did the retry loop stall?",
    );
    await h.flushMicrotasks();
    const [kickoff] = answerSent();
    expect(kickoff).toContain('agent: "seance"');
    expect(kickoff).toContain('sourceSession: "/s/lineage/transcript.jsonl"');
    expect(kickoff).toContain("Why did the retry loop stall?");
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    await launch;
  });

  it("in place while not ready: a busy notice, no prompt", async () => {
    setup("rpc-ui");
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "error" }) } });
    await h.useStore.getState().launchSeanceConsult(
      { projectCwd: "/p", instanceId: null, tabId: h.TAB, sourceSession: "/x.jsonl", sourceLabel: "x" },
      "q",
    );
    expect(prompts()).toEqual([]);
    expect(notices().length).toBe(1);
  });

  it("in place while plan mode is on: redirects to a fresh session, never prompts the host", async () => {
    // omp drops `sourceSession` from the task schema while plan mode is on,
    // so the kickoff would die at preflight inside the host tab.
    setup("rpc-ui");
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          capabilities: capabilities("18.12.0"),
          plan: { enabled: true, planFilePath: null, planAbsPath: null, approved: false },
        }),
      },
    });
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: FRESH });
    const launch = h.useStore.getState().launchSeanceConsult(
      {
        projectCwd: "/p",
        instanceId: null,
        tabId: h.TAB,
        sourceSession: "/s/lineage/transcript.jsonl",
        sourceLabel: "Deadlock investigation",
      },
      "Why did the retry loop stall?",
    );
    await h.flushMicrotasks();
    expect(prompts().filter(({ message }) => String(message).includes("seance"))).toEqual([]);
    expect(notices().join("\n")).toContain("plan mode cannot host the consultant");
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "new", mode: "rpc-ui", planMode: false }),
    );
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [FRESH]: rpcTabState() } });
    await h.flushMicrotasks();
    const consult = h.sent.filter(({ tabId }) => tabId === FRESH);
    expect(consult).toHaveLength(1);
    expect(String(consult[0]!.cmd.message)).toContain('agent: "seance"');
    answerSent();
    await launch;
  });

  it("from a row: spawns a fresh rpc-ui session, prompts it only after ready", async () => {
    setup("rpc-ui");
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: FRESH });
    const launch = h.useStore.getState().consultFromRow(h.TAB);
    await h.flushMicrotasks();

    expect(h.mockBackend.sessionTranscriptPath).toHaveBeenCalledWith(h.TAB);
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "new", mode: "rpc-ui", projectCwd: "/p" }),
    );
    const mounted = h.useStore.getState();
    expect(mounted.tabs.map((tab) => tab.tabId)).toEqual([h.TAB, FRESH]);
    expect(mounted.activeTabId).toBe(FRESH);
    // Nothing reaches omp before the fresh session reports ready.
    expect(h.sent.filter(({ tabId }) => tabId === FRESH)).toEqual([]);

    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [FRESH]: rpcTabState() } });
    await h.flushMicrotasks();
    const consult = h.sent.filter(({ tabId }) => tabId === FRESH);
    expect(consult).toHaveLength(1);
    const message = String(consult[0]!.cmd.message);
    expect(message).toContain('agent: "seance"');
    // The task-tool resolver needs the absolute path — a bare id cannot cross
    // lineage dirs (ADR-0003).
    answerSent();
    await launch;
  });

  it("a private source spawns the consult session private", async () => {
    setup("rpc-ui");
    h.backendState = structuredClone(h.backendState);
    (h.backendState.projects[0]!.sessions[0] as SessionSummary).private = true;
    h.useStore.setState({ state: h.backendState });
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: FRESH });
    const consult = h.useStore.getState().consultFromRow(h.TAB);
    await h.flushMicrotasks();
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [FRESH]: rpcTabState() } });
    await h.flushMicrotasks();
    answerSent();
    await consult;

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "new", private: true }),
    );
  });

  it("a chat source spawns a chat consult, prompted once ready", async () => {
    setup("rpc-ui");
    const base = h.backendState;
    const record = { ...base.projects[0]!.sessions[0]!, projectCwd: "/data/chats/chat-1", chat: true };
    h.backendState = { ...base, projects: [], chats: [record] };
    h.useStore.setState({ state: h.backendState });
    // Main mints the consult chat; the post-spawn getState lists it too.
    h.backendState = { ...h.backendState, chats: [record, { ...record, tabId: FRESH, sessionId: null }] };
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: FRESH });
    const launch = h.useStore.getState().consultFromRow(h.TAB);
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledTimes(1);
    const req = h.mockBackend.spawnSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(req).toMatchObject({ origin: "new", chat: true, mode: "rpc-ui" });
    expect("projectCwd" in req).toBe(false);
    expect(h.sent.filter(({ tabId }) => tabId === FRESH)).toEqual([]);

    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [FRESH]: rpcTabState() } });
    await h.flushMicrotasks();
    const consult = h.sent.filter(({ tabId }) => tabId === FRESH);
    expect(consult).toHaveLength(1);
    expect(String(consult[0]!.cmd.message)).toContain('agent: "seance"');
    answerSent();
    await launch;
  });

  it("no saved transcript: an error notice, no spawn", async () => {
    setup("rpc-ui");
    h.mockBackend.sessionTranscriptPath.mockResolvedValueOnce(null);
    await h.useStore.getState().consultFromRow(h.TAB);
    expect(h.errorMessages().join("\n")).toContain("no saved transcript");
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
  });

  it("never-materialized session id: nothing to resolve, nothing spawns", async () => {
    setup("rpc-ui");
    h.backendState = structuredClone(h.backendState);
    (h.backendState.projects[0]!.sessions[0] as SessionSummary).sessionId = null;
    h.useStore.setState({ state: h.backendState });
    await h.useStore.getState().consultFromRow(h.TAB);
    expect(h.mockBackend.sessionTranscriptPath).not.toHaveBeenCalled();
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
  });
});

describe("resolveSeanceSource (issue #885)", () => {
  beforeEach(() => setup("rpc-ui"));

  it("upgrades an exact session id to its transcript path", async () => {
    const resolved = await resolveSeanceSource(h.backendState, null, "sess-1");
    expect(resolved).toEqual({
      sourceSession: "/s/lineage/transcript.jsonl",
      sourceLabel: "New session",
      private: false,
    });
  });

  it("accepts a unique id prefix", async () => {
    const resolved = await resolveSeanceSource(h.backendState, null, "sess");
    expect(resolved?.sourceSession).toBe("/s/lineage/transcript.jsonl");
  });

  it("passes a path token through untouched", async () => {
    const resolved = await resolveSeanceSource(h.backendState, null, "/elsewhere/x.jsonl.gz");
    expect(resolved).toEqual({ sourceSession: "/elsewhere/x.jsonl.gz", sourceLabel: "/elsewhere/x.jsonl.gz", private: false });
  });

  it("resolves nothing for junk or an ambiguous prefix", async () => {
    expect(await resolveSeanceSource(h.backendState, null, "019zzzz")).toBeNull();
    // Two sessions sharing a prefix are ambiguous: the dialog keeps the raw
    // token and omp's own error speaks.
    const two = structuredClone(h.backendState);
    const second = structuredClone(two.projects[0]!.sessions[0]!);
    second.tabId = "other";
    second.sessionId = "sess-2";
    two.projects[0]!.sessions.push(second as SessionSummary);
    expect(await resolveSeanceSource(two, null, "sess-")).toBeNull();
  });
});

describe("referenceSession (issue #984)", () => {
  const SOURCE = "source-tab";
  /** The target tab plus one more local session to reference. */
  function withSource(sessionId: string | null): void {
    setup("rpc-ui");
    const state = structuredClone(h.backendState);
    const source = structuredClone(state.projects[0]!.sessions[0]!);
    source.tabId = SOURCE;
    source.sessionId = sessionId;
    source.title = "Deploy fix";
    state.projects[0]!.sessions.push(source as SessionSummary);
    h.backendState = state;
    h.useStore.setState({ state });
  }
  const queued = () => h.useStore.getState().rpc[h.TAB]?.composerQueue?.references;

  it("queues the owner's resolved reference, tagged with the owning instance", async () => {
    withSource("sess-ref");
    await h.useStore.getState().referenceSession(h.TAB, SOURCE);
    expect(h.mockBackend.sessionReference).toHaveBeenCalledWith(SOURCE);
    expect(queued()).toEqual([
      { sessionId: "sess-ref", title: "Deploy fix", machine: "box", path: "/s/lineage/ref.jsonl", instanceId: null },
    ]);
  });

  it("refuses a session on another instance without asking any host", async () => {
    withSource("sess-ref");
    const remote = remoteOwnedState("remote-tab", "inst-1");
    const state = { ...h.backendState, remoteInstances: remote.remoteInstances };
    h.useStore.setState({ state });
    h.mockBackend.sessionReference.mockClear();
    await h.useStore.getState().referenceSession(h.TAB, "remote-tab");
    expect(h.mockBackend.sessionReference).not.toHaveBeenCalled();
    expect(queued()).toBeUndefined();
    expect(notices().join("\n")).toContain("box-a");
  });

  it("refuses the session itself and one with nothing saved", async () => {
    withSource(null);
    h.mockBackend.sessionReference.mockClear();
    await h.useStore.getState().referenceSession(h.TAB, h.TAB);
    await h.useStore.getState().referenceSession(h.TAB, SOURCE);
    expect(h.mockBackend.sessionReference).not.toHaveBeenCalled();
    expect(queued()).toBeUndefined();
    expect(notices()).toHaveLength(2);
  });
});
