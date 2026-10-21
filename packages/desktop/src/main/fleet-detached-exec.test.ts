import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLEET_DETACHED_EXECS_RETAINED,
  FLEET_EXEC_OUTPUT_MAX,
  FLEET_EXEC_POLL_TAIL,
  type FleetDetachedExecStartOutcome,
  type FleetRequester,
} from "@omp-ui/core";
import { FleetDetachedExecs, type DetachedExecRecord } from "./fleet-detached-exec";
import type { FleetCommandSpec } from "./fleet-shell";

const posix = process.platform === "win32" ? describe.skip : describe;

const A: FleetRequester = { instanceId: "inst-a", label: "studio", kind: "agent", sourceTabId: "tab-1" };
const B: FleetRequester = { instanceId: "inst-b", label: "laptop", kind: "agent", sourceTabId: "tab-2" };

let base: string;
let live: FleetDetachedExecs[];

function owner(capMs = 3_000): { execs: FleetDetachedExecs; finished: DetachedExecRecord[] } {
  const finished: DetachedExecRecord[] = [];
  let n = 0;
  const execs = new FleetDetachedExecs({
    capMs,
    uuid: () => `exec-${(n += 1)}`,
    onFinish: (rec) => finished.push(rec),
  });
  live.push(execs);
  return { execs, finished };
}

function started(outcome: FleetDetachedExecStartOutcome): string {
  if (outcome.status !== "accepted") throw new Error(`refused: ${outcome.reason}`);
  return outcome.execId;
}

const spec = (command: string): FleetCommandSpec => ({ command, cwd: null, timeoutMs: null });

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-detached-"));
  live = [];
});

afterEach(() => {
  for (const execs of live) execs.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

posix("FleetDetachedExecs (issue #905)", () => {
  it("lets a command outlive the synchronous cap and reports its exit once finished", async () => {
    const { execs, finished } = owner(3_000);
    const id = started(execs.start(A, "full", spec("sleep 1; echo done")));
    const outcome = await execs.poll(A, id, 5_000, false);
    expect(outcome).toMatchObject({ status: "accepted", execId: id, state: "exited", exitCode: 0, stdout: "done\n", stderr: "", truncated: false });
    if (outcome.status === "accepted") expect(outcome.elapsedMs).toBeGreaterThanOrEqual(900);
    expect(finished).toEqual([expect.objectContaining({ execId: id, requester: A, rung: "full", state: "exited", exitCode: 0 })]);
  });

  it("times out at the owner cap and kills the whole process tree", async () => {
    const { execs, finished } = owner(300);
    const pidFile = path.join(base, "child.pid");
    // A grandchild sleeper: only a group kill reaches it.
    const id = started(execs.start(A, "full", spec(`echo started; sleep 30 & echo $! > ${pidFile}; wait`)));
    const outcome = await execs.poll(A, id, 5_000, false);
    expect(outcome).toMatchObject({ status: "accepted", state: "timed-out", exitCode: null, stdout: "started\n" });
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2_000 });
    expect(finished.map((r) => r.state)).toEqual(["timed-out"]);
  });

  it("keeps the last 64 KiB of a stream and marks the finished answer truncated", async () => {
    const { execs } = owner();
    const id = started(execs.start(A, "full", spec(`yes x | head -c ${FLEET_EXEC_OUTPUT_MAX * 3}; echo; echo LAST-LINE`)));
    const outcome = await execs.poll(A, id, 5_000, false);
    expect(outcome).toMatchObject({ status: "accepted", state: "exited", exitCode: 0, truncated: true });
    if (outcome.status !== "accepted") return;
    expect(outcome.stdout.endsWith("LAST-LINE\n")).toBe(true);
    expect(Buffer.byteLength(outcome.stdout)).toBe(FLEET_EXEC_OUTPUT_MAX);
  });

  it("shows only the last 4 KiB per stream while the process still runs", async () => {
    const { execs } = owner();
    const id = started(execs.start(A, "full", spec("yes a | head -c 10000; yes b | head -c 10000 >&2; sleep 30")));
    await vi.waitFor(
      async () => {
        const outcome = await execs.poll(A, id, 0, false);
        expect(outcome).toMatchObject({ status: "accepted", state: "running", exitCode: null, truncated: true });
        if (outcome.status !== "accepted") return;
        expect(Buffer.byteLength(outcome.stdout)).toBe(FLEET_EXEC_POLL_TAIL);
        expect(Buffer.byteLength(outcome.stderr)).toBe(FLEET_EXEC_POLL_TAIL);
        expect(outcome.stderr.endsWith("b\n")).toBe(true);
      },
      { timeout: 3_000 },
    );
    // A cancel answered before the process closes is final: whole retained tail, finished rule.
    expect(await execs.poll(A, id, 0, true)).toMatchObject({
      status: "accepted",
      state: "cancelled",
      stdout: "a\n".repeat(5_000),
      truncated: false,
    });
  });

  it("returns as soon as the process finishes inside waitMs, and a later cancel changes nothing", async () => {
    const { execs, finished } = owner();
    const id = started(execs.start(A, "full", spec("sleep 0.3; exit 4")));
    const before = Date.now();
    const outcome = await execs.poll(A, id, 20_000, false);
    expect(Date.now() - before).toBeLessThan(5_000);
    expect(outcome).toMatchObject({ status: "accepted", state: "exited", exitCode: 4 });
    expect(await execs.poll(A, id, 0, true)).toEqual(outcome);
    expect(finished).toHaveLength(1);
  });

  it("cancels on request with the state set before the kill", async () => {
    const { execs, finished } = owner();
    const id = started(execs.start(A, "full", spec("sleep 30")));
    expect(await execs.poll(A, id, 0, false)).toMatchObject({ status: "accepted", state: "running" });
    const outcome = await execs.poll(A, id, 5_000, true);
    expect(outcome).toMatchObject({ status: "accepted", state: "cancelled", exitCode: null });
    expect(finished.map((r) => r.state)).toEqual(["cancelled"]);
  });

  it("refuses a fifth running exec and a bad cwd", () => {
    const { execs } = owner();
    for (let i = 0; i < 4; i += 1) started(execs.start(A, "full", spec("sleep 30")));
    expect(execs.start(B, "full", spec("true"))).toEqual({
      status: "refused",
      reason: "4 detached execs are already running on this machine; poll or cancel one first",
    });
    const fresh = owner().execs;
    expect(fresh.start(A, "full", { command: "true", cwd: path.join(base, "nope"), timeoutMs: null })).toEqual({
      status: "refused",
      reason: `cwd ${path.join(base, "nope")} is not a directory on this machine`,
    });
  });

  it("refuses an id from another dispatcher with the unknown-id text", async () => {
    const { execs } = owner();
    const id = started(execs.start(A, "full", spec("sleep 30")));
    expect(await execs.poll(B, id, 0, true)).toEqual({ status: "refused", reason: `no detached exec ${id} from laptop on this machine` });
    expect(await execs.poll(B, "exec-99", 0, false)).toEqual({ status: "refused", reason: "no detached exec exec-99 from laptop on this machine" });
    // B's cancel never reached A's process.
    expect(await execs.poll(A, id, 0, false)).toMatchObject({ status: "accepted", state: "running" });
  });

  it("revokes only the execs whose starter fails the check", async () => {
    const { execs } = owner();
    const a = started(execs.start(A, "full", spec("sleep 30")));
    const b = started(execs.start(B, "full", spec("sleep 30")));
    execs.revokeWhere((id) => id === B.instanceId);
    expect(await execs.poll(A, a, 5_000, false)).toMatchObject({ status: "accepted", state: "revoked", exitCode: null });
    expect(await execs.poll(B, b, 0, false)).toMatchObject({ status: "accepted", state: "running" });
  });

  it("kills every running exec on dispose", async () => {
    const { execs, finished } = owner();
    const id = started(execs.start(A, "full", spec("sleep 30")));
    execs.dispose();
    expect(await execs.poll(A, id, 5_000, false)).toMatchObject({ status: "accepted", state: "cancelled" });
    expect(finished.map((r) => r.state)).toEqual(["cancelled"]);
  });

  it(`evicts the oldest finished exec past ${FLEET_DETACHED_EXECS_RETAINED}`, async () => {
    const { execs } = owner();
    const ids: string[] = [];
    for (let i = 0; i <= FLEET_DETACHED_EXECS_RETAINED; i += 1) {
      const id = started(execs.start(A, "full", spec("true")));
      ids.push(id);
      expect(await execs.poll(A, id, 5_000, false)).toMatchObject({ state: "exited" });
    }
    expect(await execs.poll(A, ids[0]!, 0, false)).toEqual({ status: "refused", reason: `no detached exec ${ids[0]} from studio on this machine` });
    expect(await execs.poll(A, ids[1]!, 0, false)).toMatchObject({ status: "accepted", state: "exited" });
  });
});
