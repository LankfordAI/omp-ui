import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLEET_MAINTENANCE_RETAINED, type FleetRequester } from "@omp-ui/core";
import {
  FleetMaintenance,
  type FleetMaintenanceContext,
  type FleetMaintenanceRecord,
  type FleetMaintenanceStartOutcome,
} from "./fleet-maintenance";
const A: FleetRequester = { instanceId: "inst-a", label: "studio", kind: "user", sourceTabId: null };
const B: FleetRequester = { instanceId: "inst-b", label: "laptop", kind: "agent", sourceTabId: "tab-9" };

let live: FleetMaintenance[];

function make(capMs = 600_000) {
  const finished: FleetMaintenanceRecord[] = [];
  let broadcasts = 0;
  const maint = new FleetMaintenance({
    capMs,
    broadcast: () => {
      broadcasts += 1;
    },
    onFinish: (rec) => finished.push(rec),
  });
  live.push(maint);
  return { maint, finished, broadcastCount: () => broadcasts };
}

/** A runner whose completion the test controls; ctx arrives with the call. */
function deferred() {
  const { promise, resolve, reject } = Promise.withResolvers<{ detail: string }>();
  let ctxRef: FleetMaintenanceContext | undefined;
  const run = (ctx: FleetMaintenanceContext) => {
    ctxRef = ctx;
    return promise;
  };
  const settle = (result: { detail: string } | Error): void => {
    if (result instanceof Error) reject(result);
    else resolve(result);
  };
  return { run, settle, ctx: () => ctxRef! };
}

function started(outcome: FleetMaintenanceStartOutcome): string {
  if (outcome.status !== "accepted") throw new Error(`refused: ${outcome.reason}`);
  return outcome.jobId;
}

beforeEach(() => {
  vi.useFakeTimers();
  live = [];
});

afterEach(() => {
  for (const maint of live) maint.dispose();
  vi.useRealTimers();
});

describe("FleetMaintenance", () => {
  it("refuses a second running job with the one-job message", () => {
    const { maint } = make();
    expect(started(maint.start(A, "full", "omp", deferred().run))).toBeTruthy();
    expect(maint.start(B, "full", "omp", deferred().run)).toEqual({
      status: "refused",
      reason: "a Fleet update is already running on this machine; wait for it to finish",
    });
  });

  it("accepts the next job once the previous one finished", async () => {
    const { maint } = make();
    const first = deferred();
    const jobId = started(maint.start(A, "full", "omp", first.run));
    first.settle({ detail: "omp 1.0.0 → 1.1.0 at /bin/omp" });
    await vi.waitFor(async () => {
      const p = await maint.poll(A, jobId, 0);
      if (p.status !== "accepted" || p.state !== "succeeded") throw new Error("not settled yet");
    });
    expect(maint.start(B, "full", "app", deferred().run).status).toBe("accepted");
  });

  it("answers a foreign instanceId with the not-found refusal shape", async () => {
    const { maint } = make();
    const jobId = started(maint.start(A, "full", "omp", deferred().run));
    expect(await maint.poll(B, jobId, 0)).toEqual({
      status: "refused",
      reason: `no Fleet update job ${jobId} from laptop on this machine`,
    });
    expect((await maint.poll(A, jobId, 0)).status).toBe("accepted");
  });

  it("settles the cap as failed with the timeout message", async () => {
    const { maint, finished } = make(1_000);
    const jobId = started(maint.start(A, "full", "omp", deferred().run));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await maint.poll(A, jobId, 0)).toMatchObject({
      status: "accepted",
      state: "failed",
      detail: "timed out after 1 s",
    });
    expect(finished).toEqual([expect.objectContaining({ jobId, state: "failed", kind: "omp" })]);
  });

  it("evicts finished jobs FIFO past the retained count", async () => {
    const { maint } = make();
    const ids: string[] = [];
    for (let i = 0; i <= FLEET_MAINTENANCE_RETAINED; i += 1) {
      const job = deferred();
      ids.push(started(maint.start(A, "full", "omp", job.run)));
      job.settle({ detail: `done ${i}` });
      await vi.waitFor(async () => {
        const p = await maint.poll(A, ids[ids.length - 1]!, 0);
        if (p.status !== "accepted" || p.state !== "succeeded") throw new Error("still running");
      });
    }
    // The oldest finished job is gone; the newest FLEET_MAINTENANCE_RETAINED remain.
    expect((await maint.poll(A, ids[0]!, 0)).status).toBe("refused");
    expect((await maint.poll(A, ids[ids.length - 1]!, 0)).status).toBe("accepted");
  });

  it("revokes running jobs whose requester no longer passes", async () => {
    const { maint, finished } = make();
    const job = deferred();
    const jobId = started(maint.start(A, "full", "omp", job.run));
    job.ctx().report({ percent: 42, phase: "downloading" });
    expect(await maint.poll(A, jobId, 0)).toMatchObject({ state: "running", progress: { percent: 42 } });
    maint.revokeWhere((id) => id !== "inst-a");
    expect(await maint.poll(A, jobId, 0)).toMatchObject({ status: "accepted", state: "revoked" });
    expect(finished.map((f) => f.state)).toEqual(["revoked"]);
  });

  it("answers shouldCommit while running and throws after the job is no longer running", async () => {
    const { maint } = make();
    const job = deferred();
    const jobId = started(maint.start(A, "full", "omp", job.run));
    expect(() => job.ctx().shouldCommit()).not.toThrow();
    // The late commit attempt is refused: the promise's eventual success is
    // swallowed by the registry and shouldCommit throws for the rename guard.
    job.settle(new Error("disk full"));
    await vi.waitFor(async () => {
      const p = await maint.poll(A, jobId, 0);
      if (p.status !== "accepted" || p.state !== "failed") throw new Error("not failed yet");
      expect(p.detail).toBe("disk full");
    });
    expect(() => job.ctx().shouldCommit()).toThrow(/failed/);
  });

  it("swallows a late success after revoke — the job stays revoked", async () => {
    const { maint } = make();
    const job = deferred();
    const jobId = started(maint.start(A, "full", "omp", job.run));
    maint.revokeWhere(() => false);
    expect(() => job.ctx().shouldCommit()).toThrow(/revoked/);
    job.settle({ detail: "too late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await maint.poll(A, jobId, 0)).toMatchObject({ state: "revoked", detail: "revoked by this machine's owner" });
  });

  it("marks running jobs revoked on dispose without letting a late install succeed", () => {
    const { maint, finished } = make();
    const job = deferred();
    started(maint.start(A, "full", "omp", job.run));
    maint.dispose();
    expect(finished).toEqual([expect.objectContaining({ state: "revoked" })]);
    expect(() => job.ctx().shouldCommit()).toThrow(/revoked/);
  });

  it("long-polls until the job settles, then answers the final state", async () => {
    const { maint } = make();
    const job = deferred();
    const jobId = started(maint.start(A, "full", "omp", job.run));
    const polling = maint.poll(A, jobId, 5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    job.settle({ detail: "omp → 2.0.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await polling).toMatchObject({ status: "accepted", state: "succeeded", detail: "omp → 2.0.0" });
  });

  it("broadcasts on progress reports and state transitions", async () => {
    const { maint, broadcastCount } = make();
    const job = deferred();
    started(maint.start(A, "full", "omp", job.run));
    const before = broadcastCount();
    job.ctx().report({ percent: 10, phase: "downloading" });
    expect(broadcastCount()).toBe(before + 1);
    const afterProgress = broadcastCount();
    job.settle({ detail: "done" });
    await vi.waitFor(() => expect(broadcastCount()).toBeGreaterThan(afterProgress));
  });
});
