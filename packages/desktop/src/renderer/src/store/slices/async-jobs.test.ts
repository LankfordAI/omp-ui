// The Jobs pane's kill verbs (issue #835, ADR-0054): a hidden slash prompt
// whose outcome rides the bridge's next snapshot, correlated by requestId.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASYNC_JOBS_COMMAND,
  ASYNC_JOBS_STATUS_KEY,
  ASYNC_JOBS_SNAPSHOT_VERSION,
  type AsyncJobsSnapshot,
} from "@omp-ui/core/async-jobs";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

const runtime = () => h.useStore.getState().rpc[h.TAB];

function snapshot(overrides: Partial<AsyncJobsSnapshot> = {}): AsyncJobsSnapshot {
  return {
    version: ASYNC_JOBS_SNAPSHOT_VERSION,
    processKey: "omp-ui-proc-1",
    revision: 1,
    available: true,
    unavailable: null,
    canInspect: true,
    canCancel: true,
    running: [],
    recent: [],
    rootId: null,
    agents: [],
    result: null,
    ...overrides,
  };
}

function publish(next: AsyncJobsSnapshot): void {
  h.useStore.getState().handleRpcFrame(h.TAB, {
    type: "extension_ui_request",
    id: "frame-" + Math.random().toString(36).slice(2),
    method: "setStatus",
    statusKey: ASYNC_JOBS_STATUS_KEY,
    statusText: JSON.stringify(next),
  });
}

function setTab(patch: Parameters<typeof rpcTabState>[0]): void {
  h.useStore.setState((s) => ({ rpc: { ...s.rpc, [h.TAB]: rpcTabState(patch) } }));
}

const prompts = () =>
  h.sent
    .filter(({ cmd }) => cmd.type === "prompt" && typeof cmd.message === "string")
    .map(({ cmd }) => String(cmd.message));

beforeEach(() => {
  h.backendState = h.stateWithRecord("sess-1");
  h.useStore.setState({
    state: h.backendState,
    tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui" })],
    rpc: { [h.TAB]: rpcTabState() },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("async-jobs snapshot acceptance (issue #835)", () => {
  it("a setStatus frame fills asyncJobs and an older same-process revision is ignored", () => {
    publish(snapshot({ revision: 5 }));
    expect(runtime()?.asyncJobs?.revision).toBe(5);
    publish(snapshot({ revision: 4 }));
    expect(runtime()?.asyncJobs?.revision).toBe(5);
    // A new process replaces regardless of revision.
    publish(snapshot({ processKey: "omp-ui-proc-2", revision: 1 }));
    expect(runtime()?.asyncJobs?.processKey).toBe("omp-ui-proc-2");
  });

  it("a malformed publish leaves the last good snapshot standing", () => {
    publish(snapshot({ revision: 2 }));
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "frame-bad",
      method: "setStatus",
      statusKey: ASYNC_JOBS_STATUS_KEY,
      statusText: "{nope",
    });
    expect(runtime()?.asyncJobs?.revision).toBe(2);
  });
});

describe("killAsyncJob (issue #835)", () => {
  const cancellable = { asyncJobs: snapshot({ canCancel: true }) };

  it("sends exactly the kill prompt with no streamingBehavior", async () => {
    setTab(cancellable);
    const promise = h.useStore.getState().killAsyncJob(h.TAB, { id: "bg_1", startTime: 123 });
    const [message] = prompts();
    expect(message).toBeDefined();
    const json = JSON.parse(message.slice(`/omp-ui-async-jobs kill `.length));
    expect(json).toEqual({
      requestId: expect.any(String),
      processKey: "omp-ui-proc-1",
      jobId: "bg_1",
      startTime: 123,
    });
    const sentCmd = h.sent.find(({ cmd }) => cmd.type === "prompt")!;
    h.respond(h.TAB, sentCmd.cmd, {});
    await promise;
    // The ack alone settles nothing: the result snapshot is the answer.
    expect(runtime()?.asyncJobsKill).not.toBeNull();
  });

  it("a snapshot carrying the matching requestId settles the kill", async () => {
    setTab(cancellable);
    const promise = h.useStore.getState().killAsyncJob(h.TAB, { id: "bg_1", startTime: 1 });
    const sentCmd = h.sent.find(({ cmd }) => cmd.type === "prompt")!;
    const requestId = JSON.parse(prompts()[0]!.slice(`/omp-ui-async-jobs kill `.length)).requestId as string;
    h.respond(h.TAB, sentCmd.cmd, {});
    await promise;
    expect(runtime()?.asyncJobsKill).toEqual({ requestId, jobId: "bg_1" });
    publish(
      snapshot({
        revision: 2,
        result: { requestId, ok: true, cancelled: ["bg_1"], text: "Cancelled background job bg_1." },
      }),
    );
    expect(runtime()?.asyncJobsKill).toBeNull();
    expect(runtime()?.asyncJobsKillError).toBeNull();
  });

  it("an ok:false result shows the bridge's sentence", async () => {
    setTab(cancellable);
    const promise = h.useStore.getState().killAsyncJob(h.TAB, { id: "bg_1", startTime: 1 });
    const sentCmd = h.sent.find(({ cmd }) => cmd.type === "prompt")!;
    const requestId = JSON.parse(prompts()[0]!.slice(`/omp-ui-async-jobs kill `.length)).requestId as string;
    h.respond(h.TAB, sentCmd.cmd, {});
    await promise;
    publish(
      snapshot({
        revision: 2,
        result: { requestId, ok: false, cancelled: [], text: "No running background job with id \"bg_1\"." },
      }),
    );
    expect(runtime()?.asyncJobsKill).toBeNull();
    expect(runtime()?.asyncJobsKillError).toContain('No running background job with id "bg_1"');
  });

  it("a foreign requestId leaves the kill pending", () => {
    setTab({ ...cancellable, asyncJobsKill: { requestId: "mine", jobId: "bg_1" } });
    publish(
      snapshot({ revision: 2, result: { requestId: "someone-else", ok: true, cancelled: ["bg_1"], text: "x" } }),
    );
    expect(runtime()?.asyncJobsKill).toEqual({ requestId: "mine", jobId: "bg_1" });
  });

  it.each([
    ["no snapshot", {}],
    ["an unavailable snapshot", { asyncJobs: snapshot({ available: false, unavailable: "nope" }) }],
    ["a cancel-incapable snapshot", { asyncJobs: snapshot({ canCancel: false }) }],
  ])("sends nothing with %s", async (_name, patch) => {
    setTab(patch);
    await h.useStore.getState().killAsyncJob(h.TAB, { id: "bg_1", startTime: 1 });
    expect(h.sent).toEqual([]);
    expect(runtime()?.asyncJobsKill).toBeNull();
  });

  it("sends nothing while a kill is pending", async () => {
    setTab(cancellable);
    const first = h.useStore.getState().killAsyncJob(h.TAB, { id: "bg_1", startTime: 1 });
    await h.useStore.getState().killAsyncJob(h.TAB, null);
    expect(prompts()).toHaveLength(1);
    h.respond(h.TAB, h.sent.find(({ cmd }) => cmd.type === "prompt")!.cmd, {});
    await first;
  });
  it("an unanswered kill surfaces the no-answer line after the timeout", async () => {
    vi.useFakeTimers();
    setTab(cancellable);
    void h.useStore.getState().killAsyncJob(h.TAB, { id: "bg_1", startTime: 1 });
    h.respond(h.TAB, h.sent.find(({ cmd }) => cmd.type === "prompt")!.cmd, {});
    await h.flushMicrotasks();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(runtime()?.asyncJobsKill).not.toBeNull();
    expect(runtime()?.asyncJobsKillError).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(runtime()?.asyncJobsKill).toBeNull();
    expect(runtime()?.asyncJobsKillError).toContain("did not answer");
  });

  it("a rejected rpc settles the kill with the failure text", async () => {
    setTab(cancellable);
    const promise = h.useStore.getState().killAsyncJob(h.TAB, { id: "bg_1", startTime: 1 });
    const sentCmd = h.sent.find(({ cmd }) => cmd.type === "prompt")!;
    h.respond(h.TAB, sentCmd.cmd, "extension command failed", false);
    await promise;
    expect(runtime()?.asyncJobsKill).toBeNull();
    expect(runtime()?.asyncJobsKillError).toContain("extension command failed");
  });
});

describe("boot arm (issue #835)", () => {
  it("driveBoot arms the bridge with the bare hidden command", async () => {
    const answered = await h.driveBoot(h.TAB, {
      get_available_commands: {
        data: { commands: [{ name: ASYNC_JOBS_COMMAND, description: "", source: "extension" }] },
      },
    });
    expect(answered).toContain(`/${ASYNC_JOBS_COMMAND}`);
  });
});
