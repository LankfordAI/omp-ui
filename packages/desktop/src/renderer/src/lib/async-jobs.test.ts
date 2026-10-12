import { describe, expect, it } from "vitest";
import type { AsyncJobsSnapshot } from "@omp-ui/core/async-jobs";
import { runningJobCount } from "./async-jobs";
import type { SubagentInfo } from "./rpc-types";

function snapshot(overrides: Partial<AsyncJobsSnapshot> = {}): AsyncJobsSnapshot {
  return {
    version: 1,
    processKey: "p",
    revision: 1,
    available: true,
    unavailable: null,
    canInspect: true,
    canCancel: true,
    running: [],
    recent: [],
    result: null,
    ...overrides,
  };
}

function job(overrides: Partial<AsyncJobsSnapshot["running"][number]> = {}) {
  return {
    id: "bg_1",
    type: "bash",
    status: "running" as const,
    label: "l",
    command: null,
    cwd: null,
    startTime: 0,
    endTime: null,
    agentId: null,
    pids: [],
    exitCode: null,
    outputTail: "",
    outputTruncated: false,
    ...overrides,
  };
}

const agents = (...ids: string[]): SubagentInfo[] => ids.map((id) => ({ id }));

describe("runningJobCount", () => {
  it("excludes a task job already on the Agents roster", () => {
    expect(
      runningJobCount(
        snapshot({ running: [job({ id: "a-1", type: "task", agentId: "a-1" })] }),
        agents("a-1"),
      ),
    ).toBe(0);
  });

  it("counts an unrostered task job and a bash job", () => {
    expect(
      runningJobCount(
        snapshot({
          running: [
            job({ id: "bg_1" }),
            job({ id: "a-9", type: "task", agentId: "a-9" }),
            job({ id: "a-10", type: "task", agentId: "a-10" }),
          ],
        }),
        agents("a-9"),
      ),
    ).toBe(2);
  });

  it("counts a task job without an agentId", () => {
    expect(
      runningJobCount(snapshot({ running: [job({ id: "t", type: "task", agentId: null })] }), agents("t")),
    ).toBe(1);
  });

  it("returns zero for a null or unavailable snapshot", () => {
    expect(runningJobCount(null, agents("a"))).toBe(0);
    expect(
      runningJobCount(snapshot({ available: false, unavailable: "nope", running: [job()] }), agents()),
    ).toBe(0);
  });
});
