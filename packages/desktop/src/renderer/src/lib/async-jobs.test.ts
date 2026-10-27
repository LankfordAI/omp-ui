import { describe, expect, it } from "vitest";
import { ASYNC_JOBS_SNAPSHOT_VERSION, type AsyncJob, type AsyncJobWidget, type AsyncJobsSnapshot } from "@omp-ui/core/async-jobs";
import { backgroundWorkInFlight, freshestWidgetJob, jobWidgetFigure, runningJobCount } from "./async-jobs";
import type { SubagentInfo } from "./rpc-types";

function snapshot(overrides: Partial<AsyncJobsSnapshot> = {}): AsyncJobsSnapshot {
  return {
    version: ASYNC_JOBS_SNAPSHOT_VERSION,
    processKey: "p",
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

function job(overrides: Partial<AsyncJob> = {}): AsyncJob {
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
    ownerId: null,
    pids: [],
    exitCode: null,
    outputTail: "",
    outputTruncated: false,
    widget: null,
    completionPercent: null,
    stage: null,
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

describe("backgroundWorkInFlight", () => {
  it("reports true while a job is running", () => {
    expect(backgroundWorkInFlight(snapshot({ running: [job()] }))).toBe(true);
  });

  it("reports false once only settled recent rows remain", () => {
    expect(
      backgroundWorkInFlight(
        snapshot({
          recent: [job({ id: "bg_1", status: "completed", exitCode: 0 })],
        }),
      ),
    ).toBe(false);
  });

  it("reports false for a null snapshot", () => {
    expect(backgroundWorkInFlight(null)).toBe(false);
  });

  it("reports false when the bridge is unavailable even with running rows", () => {
    expect(
      backgroundWorkInFlight(
        snapshot({ available: false, unavailable: "nope", running: [job()] }),
      ),
    ).toBe(false);
  });

  it("reports false for an empty running list", () => {
    expect(backgroundWorkInFlight(snapshot())).toBe(false);
  });
});

function widget(overrides: Partial<AsyncJobWidget> = {}): AsyncJobWidget {
  return { title: "w", headline: null, stage: null, blocks: [], updatedAt: 1, ...overrides };
}

const spark = {
  kind: "spark" as const,
  label: "rate",
  values: [1, 2],
  min: 0,
  max: 3,
  last: "2/s",
  marks: [],
  tone: null,
};
const meter = { kind: "meter" as const, label: "done", value: 0.5, text: "50%", tone: null };

describe("jobWidgetFigure", () => {
  it("prefers the headline", () => {
    const headline = { text: "412", label: "files", trend: null };
    expect(jobWidgetFigure(widget({ headline, blocks: [spark, meter] }))).toBe(headline);
  });

  it("falls back to the first spark's last value, then the first meter's text", () => {
    expect(jobWidgetFigure(widget({ blocks: [meter, spark] }))).toEqual({ text: "50%", label: "done", trend: null });
    expect(jobWidgetFigure(widget({ blocks: [spark, meter] }))).toEqual({ text: "2/s", label: "rate", trend: null });
  });

  it("returns null when the widget has no figure", () => {
    expect(jobWidgetFigure(widget({ stage: "s", blocks: [{ kind: "text", text: "hi" }] }))).toBeNull();
  });
});

describe("freshestWidgetJob", () => {
  it("picks the running job whose widget updated last", () => {
    const fresh = job({ id: "bg_2", widget: widget({ updatedAt: 9 }) });
    const result = freshestWidgetJob(
      snapshot({ running: [job({ id: "bg_1", widget: widget({ updatedAt: 5 }) }), fresh, job({ id: "bg_3" })] }),
    );
    expect(result).toBe(fresh);
  });

  it("returns null when no running job has a widget", () => {
    expect(freshestWidgetJob(snapshot({ running: [job()] }))).toBeNull();
    expect(freshestWidgetJob(null)).toBeNull();
  });

  it("returns null for an unavailable snapshot", () => {
    expect(
      freshestWidgetJob(snapshot({ available: false, unavailable: "nope", running: [job({ widget: widget() })] })),
    ).toBeNull();
  });
});
