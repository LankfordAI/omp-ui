import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState, PendingPlan, RemoteInstanceSummary, SessionSummary } from "@omp-ui/core";
import { FleetWakeCoordinator, type FleetWakeCoordinatorDeps } from "./fleet-wake";

const INSTANCE = "inst-a";
const PARENT = "parent-1";

let dir: string;
let parents: Set<string>;

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wake-")), "fleet-wake");
  parents = new Set([PARENT]);
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

function deps(patch: Partial<FleetWakeCoordinatorDeps> = {}): FleetWakeCoordinatorDeps {
  return {
    dir,
    instanceId: () => INSTANCE,
    hasSession: (tabId) => parents.has(tabId),
    summaryText: vi.fn(async () => "did the thing"),
    flush: vi.fn(),
    log: vi.fn(),
    ...patch,
  };
}

function child(dispatchId: string, patch: Partial<SessionSummary> = {}, requester: { instanceId?: string; sourceTabId?: string } = {}): SessionSummary {
  return {
    tabId: `child-${dispatchId}`,
    sessionId: `sid-${dispatchId}`,
    title: `Child ${dispatchId}`,
    status: "pending",
    live: "live",
    turnRunning: true,
    pendingPlan: null,
    awaitingHumanAnswer: false,
    fleet: {
      dispatchId,
      batchId: null,
      dispatchedAt: "2026-10-28T00:00:00.000Z",
      requestedBy: {
        instanceId: requester.instanceId ?? INSTANCE,
        label: "host",
        kind: "agent",
        sourceTabId: requester.sourceTabId ?? PARENT,
      },
    },
    ...patch,
  } as SessionSummary;
}

const idleComplete: Partial<SessionSummary> = { status: "complete", turnRunning: false };

function state(local: SessionSummary[], remote: RemoteInstanceSummary[] = []): BackendState {
  return {
    projects: [{ project: {} as never, sessions: local }],
    remoteInstances: remote,
  } as unknown as BackendState;
}

function remoteInstance(id: string, nickname: string, sessions: SessionSummary[]): RemoteInstanceSummary {
  return { id, nickname, projects: [{ project: {} as never, sessions }] } as unknown as RemoteInstanceSummary;
}

function plan(frameId: string): PendingPlan {
  return { title: `Plan ${frameId}`, frameId } as PendingPlan;
}

async function observe(c: FleetWakeCoordinator, s: BackendState): Promise<void> {
  c.observe(s);
  await c.settled();
}

describe("FleetWakeCoordinator", () => {
  it("stages exactly one result when a watched child goes working → idle-complete", async () => {
    const d = deps();
    const c = new FleetWakeCoordinator(d);
    c.watch(PARENT, [{ dispatchId: "d1", machineKey: "local" }]);

    await observe(c, state([child("d1")]));
    expect(c.staged(PARENT)).toEqual([]);
    expect(d.flush).not.toHaveBeenCalled();

    await observe(c, state([child("d1", idleComplete)]));
    await observe(c, state([child("d1", idleComplete)]));
    const staged = c.staged(PARENT);
    expect(staged).toHaveLength(1);
    expect(staged[0].card).toMatchObject({ wakeId: "d1.result", dispatchId: "d1", kind: "result", childTabId: "child-d1", outcome: "complete" });
    expect(d.summaryText).toHaveBeenCalledTimes(1);
    expect(d.summaryText).toHaveBeenCalledWith("local", "child-d1");
    expect(d.flush).toHaveBeenCalledWith(PARENT);
  });

  it("never stages for a child that is not watched", async () => {
    const d = deps();
    const c = new FleetWakeCoordinator(d);
    await observe(c, state([child("d1", idleComplete)]));
    expect(c.staged(PARENT)).toEqual([]);
    expect(d.flush).not.toHaveBeenCalled();
  });

  it("ignores a child dispatched by another instance or another parent", async () => {
    const d = deps();
    const c = new FleetWakeCoordinator(d);
    c.watch(PARENT, [
      { dispatchId: "d1", machineKey: "local" },
      { dispatchId: "d2", machineKey: "local" },
    ]);
    await observe(c, state([
      child("d1", idleComplete, { instanceId: "inst-other" }),
      child("d2", idleComplete, { sourceTabId: "parent-other" }),
    ]));
    expect(c.staged(PARENT)).toEqual([]);
    expect(d.summaryText).not.toHaveBeenCalled();
  });

  it("stages a question per new key, not for a repeated key, and stops at the cap", async () => {
    const c = new FleetWakeCoordinator(deps());
    c.watch(PARENT, [{ dispatchId: "d1", machineKey: "local" }]);
    const waiting = (frameId: string): BackendState =>
      state([child("d1", { turnRunning: false, pendingPlan: plan(frameId) })]);

    await observe(c, waiting("f1"));
    await observe(c, waiting("f1"));
    expect(c.staged(PARENT).map((m) => m.card.wakeId)).toEqual(["d1.q0"]);
    expect(c.staged(PARENT)[0].card).toMatchObject({ kind: "question", outcome: "plan review" });

    await observe(c, waiting("f2"));
    await observe(c, waiting("f3"));
    await observe(c, waiting("f4"));
    expect(c.staged(PARENT).map((m) => m.card.wakeId)).toEqual(["d1.q0", "d1.q1", "d1.q2"]);
  });

  it("asks a remote child's summary with the remote machineKey", async () => {
    const d = deps();
    const c = new FleetWakeCoordinator(d);
    c.watch(PARENT, [{ dispatchId: "d1", machineKey: "remote-1" }]);
    await observe(c, state([], [remoteInstance("remote-1", "box-a", [child("d1", idleComplete)])]));
    expect(d.summaryText).toHaveBeenCalledWith("remote-1", "child-d1");
    expect(c.staged(PARENT)[0].card.machine).toBe("box-a");
  });

  it("removes a delivered entry, persists, and reloads watches and staged entries", async () => {
    const c = new FleetWakeCoordinator(deps());
    c.watch(PARENT, [{ dispatchId: "d1", machineKey: "local" }, { dispatchId: "d2", machineKey: "local" }]);
    await observe(c, state([child("d1", idleComplete), child("d2", idleComplete)]));
    expect(c.staged(PARENT)).toHaveLength(2);

    c.delivered(PARENT, "d1.result");
    c.delivered(PARENT, "unknown");
    c.delivered("no-such-tab", "d2.result");
    expect(c.staged(PARENT).map((m) => m.card.wakeId)).toEqual(["d2.result"]);

    const d = deps();
    const reloaded = new FleetWakeCoordinator(d);
    expect(reloaded.staged(PARENT)).toEqual(c.staged(PARENT));
    // Reloaded watches remember the staged result: no second stage.
    await observe(reloaded, state([child("d1", idleComplete), child("d2", idleComplete)]));
    expect(d.summaryText).not.toHaveBeenCalled();
    expect(reloaded.staged(PARENT).map((m) => m.card.wakeId)).toEqual(["d2.result"]);
  });

  it("deletes the file of a parent missing from the registry", async () => {
    const c = new FleetWakeCoordinator(deps());
    c.watch(PARENT, [{ dispatchId: "d1", machineKey: "local" }]);
    const file = path.join(dir, `${PARENT}.json`);
    expect(fs.existsSync(file)).toBe(true);
    parents.delete(PARENT);
    await observe(c, state([child("d1", idleComplete)]));
    expect(fs.existsSync(file)).toBe(false);
    expect(c.staged(PARENT)).toEqual([]);
  });

  it("ignores a corrupt file without deleting it", () => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${PARENT}.json`);
    fs.writeFileSync(file, "{not json");
    const d = deps();
    const c = new FleetWakeCoordinator(d);
    expect(c.staged(PARENT)).toEqual([]);
    expect(d.log).toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(true);
  });
});
