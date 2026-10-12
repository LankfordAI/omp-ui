import { describe, expect, it } from "vitest";
import {
  asyncJobsArmMessage,
  asyncJobsKillMessage,
  parseAsyncJobsSnapshot,
  type AsyncJobsSnapshot,
} from "./async-jobs";

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bg_1",
    type: "bash",
    status: "running",
    label: "sleep 30",
    command: "sleep 30",
    cwd: "/tmp/scratch",
    startTime: 1_761_000_000_000,
    endTime: null,
    agentId: null,
    pids: [4242],
    exitCode: null,
    outputTail: "",
    outputTruncated: false,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    processKey: "omp-ui-mc0abcd-xyz",
    revision: 3,
    available: true,
    unavailable: null,
    canInspect: true,
    canCancel: true,
    running: [job()],
    recent: [
      job({
        id: "bg_2",
        status: "completed",
        endTime: 1_761_000_010_000,
        pids: [],
        exitCode: 0,
        outputTail: "done",
      }),
    ],
    result: null,
    ...overrides,
  };
}

function publish(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(snapshot(overrides));
}

describe("parseAsyncJobsSnapshot", () => {
  it("parses running, recent, and a kill result to an equal object", () => {
    const text = publish({
      result: { requestId: "req-1", ok: true, cancelled: ["bg_1"], text: "Cancelled background job bg_1." },
    });
    const parsed = parseAsyncJobsSnapshot(text);
    expect(parsed).not.toBeNull();
    expect(parsed as AsyncJobsSnapshot).toEqual(JSON.parse(text));
  });

  it.each([
    ["an unknown status", publish({ running: [job({ status: "paused" })] })],
    ["an empty id", publish({ running: [job({ id: "" })] })],
    ["a non-integer pid", publish({ running: [job({ pids: [1.5] })] })],
    ["revision 0", publish({ revision: 0 })],
    ["a missing canCancel", publish({ canCancel: undefined })],
    ["a result without requestId", publish({ result: { ok: true, cancelled: [], text: "x" } })],
    ["invalid JSON", "{not json"],
    ["undefined", undefined as unknown as string],
  ])("rejects %s", (_name, text) => {
    expect(parseAsyncJobsSnapshot(text)).toBeNull();
  });
});

describe("wire messages", () => {
  it("arms with the bare hidden command", () => {
    expect(asyncJobsArmMessage()).toBe("/omp-ui-async-jobs");
  });

  it("sends a kill as the command with the JSON request", () => {
    const message = asyncJobsKillMessage({
      requestId: "req-9",
      processKey: "omp-ui-a-b",
      jobId: "bg_1",
      startTime: 123,
    });
    expect(message).toBe(
      '/omp-ui-async-jobs kill {"requestId":"req-9","processKey":"omp-ui-a-b","jobId":"bg_1","startTime":123}',
    );
  });
});
