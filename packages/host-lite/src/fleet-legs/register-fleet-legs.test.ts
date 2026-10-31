/**
 * Member-leg wiring proof with fake seams (issue #1010). Expectations mirror
 * the desktop member's own tests: `backend-fleet-exec.test.ts` (refusal
 * strings, first-sight naming, the switch/grant/ceiling triple) and
 * `fleet-server.test.ts` (terminal ownership, renewal, revocation ordering).
 * Calls ride the real `dispatchRequest` boundary — shared-codec decode, then
 * handler — exactly as the remote-access transport delivers them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH, dispatchNotify, dispatchRequest, type ChannelTable, type FleetAuditEntry, type FleetGrantRecord, type FleetRequester } from "@omp-ui/core";
import { registerFleetLegs } from "./register-fleet-legs";
import type {
  FleetExecLegs,
  FleetHostReportLegs,
  FleetLegsRegistry,
  FleetLegsSettingKey,
  FleetLegsSettings,
  FleetTerminalLegs,
} from "./types";

const TOKEN = "member-join-token-0123456789";
const MANAGER: FleetRequester = { instanceId: "manager-1", label: "desk", kind: "agent", sourceTabId: "tab-9" };

function fakeRegistry(settings: Partial<FleetLegsSettings> = {}): FleetLegsRegistry & { store: Record<string, unknown> } {
  const store: Record<string, unknown> = {
    instanceId: "member-1",
    modelFavorites: [],
    remoteToken: TOKEN,
    remotePasswordHash: "",
    remotePasswordSalt: "",
    fleetExecEnabled: false,
    fleetExecCeiling: "dispatch",
    fleetGrants: {},
    fleetProjectRoots: [],
    ...settings,
  };
  return {
    store,
    getSetting: <K extends FleetLegsSettingKey>(key: K): FleetLegsSettings[K] => store[key] as never,
    setSetting: <K extends FleetLegsSettingKey>(key: K, value: FleetLegsSettings[K]): void => {
      store[key] = value;
    },
    projects: [],
  };
}

const hostSeam = (over: Partial<FleetHostReportLegs> = {}): FleetHostReportLegs => ({
  resources: async () => ({ cpuCount: 4, cpuUtilization: 0.25, totalMemoryBytes: 8_000, availableMemoryBytes: 4_000 }),
  projects: async () => [],
  activity: () => ({ liveSessions: 1, runningTurns: 0 }),
  ...over,
});

function tableOf(handle: ReturnType<typeof registerFleetLegs>): ChannelTable {
  return handle as unknown as ChannelTable;
}

// ── fake seams ───────────────────────────────────────────────────────────────

interface Recorder {
  revoked: Array<(id: string) => boolean>;
  disposed: number;
}

function fakeExec(): FleetExecLegs & { calls: string[] } & Recorder {
  const calls: string[] = [];
  const revoked: Array<(id: string) => boolean> = [];
  let disposed = 0;
  let pollCount = 0;
  return {
    calls,
    revoked,
    get disposed() {
      return disposed;
    },
    run: async (spec) => {
      calls.push(`run ${spec.command}`);
      return { status: "accepted", exitCode: 0, stdout: "hi\n", stderr: "", truncated: false, timedOut: false };
    },
    start: (_requester, rung, spec) => {
      calls.push(`start ${spec.command} as ${rung}`);
      return { status: "accepted", execId: "exec-1" };
    },
    poll: async (_requester, execId, waitMs, cancel) => {
      calls.push(`poll ${execId} wait=${waitMs} cancel=${cancel}`);
      pollCount += 1;
      return pollCount === 1
        ? { status: "accepted", execId, state: "running", exitCode: null, stdout: "mid\n", stderr: "", truncated: false, elapsedMs: 10 }
        : { status: "accepted", execId, state: "exited", exitCode: 0, stdout: "mid\ndone\n", stderr: "", truncated: false, elapsedMs: 25 };
    },
    revokeWhere: (stillAllowed) => void revoked.push(stillAllowed),
    dispose: () => void (disposed += 1),
  };
}

function fakeTerminals(): FleetTerminalLegs & { events: string[]; alive: Set<string> } & Recorder {
  const events: string[] = [];
  const alive = new Set<string>();
  const revoked: Array<(id: string) => boolean> = [];
  let disposed = 0;
  return {
    events,
    alive,
    revoked,
    get disposed() {
      return disposed;
    },
    open: (requester, rung, terminalId) => {
      events.push(`open:${requester.instanceId}:${terminalId}:${rung}`);
      alive.add(terminalId);
      return { status: "accepted" };
    },
    renew: (requester, terminalIds) => {
      events.push(`renew:${requester.instanceId}:${terminalIds.join(",")}`);
      return terminalIds.filter((id) => alive.has(id));
    },
    end: (requester, terminalId) => {
      // Ownership mirrors the member rule: only the requester's own terminals end.
      if (!alive.has(terminalId)) return;
      events.push(`end:${requester.instanceId}:${terminalId}`);
      alive.delete(terminalId);
    },
    write: (dispatcherId, terminalId, data) => events.push(`write:${dispatcherId}:${terminalId}:${data}`),
    resize: (dispatcherId, terminalId, cols, rows) => events.push(`size:${dispatcherId}:${terminalId}:${cols}x${rows}`),
    revokeWhere: (stillAllowed) => void revoked.push(stillAllowed),
    dispose: () => void (disposed += 1),
  };
}

const execCall = (over: Record<string, unknown> = {}) => [{ requester: MANAGER, command: "echo hi", cwd: null, timeoutMs: 2_000, ...over }];

// ── exec round-trip incl. detach -> poll -> result ───────────────────────────

describe("lite member exec legs (mirrors backend-fleet-exec.test.ts)", () => {
  it("runs only once the master switch, the ceiling, and the grant all allow it", async () => {
    const registry = fakeRegistry({ fleetExecEnabled: true, fleetExecCeiling: "full" });
    const audit: FleetAuditEntry[] = [];
    const exec = fakeExec();
    const legs = registerFleetLegs({ registry, host: hostSeam(), exec, auditSink: (e) => audit.push(e) });
    const table = tableOf(legs);

    // Default grant is dispatch: refused with the member's own reason text.
    expect(await dispatchRequest(table, CH.fleetExec, execCall())).toMatchObject({ status: "refused" });
    const grants = registry.store.fleetGrants as Record<string, FleetGrantRecord>;
    expect(grants[MANAGER.instanceId]).toMatchObject({ label: "desk" });
    expect(grants[MANAGER.instanceId]?.rung).toBeUndefined(); // first sight names, never grants

    registry.setSetting("fleetGrants", { ...grants, [MANAGER.instanceId]: { rung: "full", label: "desk", updatedAt: "t" } });
    expect(await dispatchRequest(table, CH.fleetExec, execCall())).toEqual({
      status: "accepted",
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
    expect(exec.calls).toEqual(["run echo hi"]);

    registry.setSetting("fleetExecEnabled", false); // the switch lands on the next request
    expect(await dispatchRequest(table, CH.fleetExec, execCall())).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("fleet exec is off"),
    });

    // The same accepted/refused ledger the desktop test asserts.
    expect(audit.filter((e) => e.action === "exec").map((e) => e.accepted)).toEqual([false, true, false]);
    expect(audit.find((e) => e.accepted && e.action === "exec")).toMatchObject({ dispatcherLabel: "desk", rung: "full", exitCode: 0 });
  });

  it("carries a detach through poll to its final result", async () => {
    const registry = fakeRegistry({ fleetExecEnabled: true, fleetExecCeiling: "full" });
    registry.setSetting("fleetGrants", { [MANAGER.instanceId]: { rung: "full", label: "desk", updatedAt: "t" } });
    const exec = fakeExec();
    const table = tableOf(registerFleetLegs({ registry, host: hostSeam(), exec }));

    const detach = [{ requester: MANAGER, command: "make", cwd: null, timeoutMs: null }];
    expect(await dispatchRequest(table, CH.fleetExecDetach, detach)).toEqual({ status: "accepted", execId: "exec-1" });
    expect(exec.calls).toContain("start make as full"); // the gated rung reaches the seam

    const poll = (waitMs: number) => [{ requester: MANAGER, execId: "exec-1", waitMs, cancel: false }];
    expect(await dispatchRequest(table, CH.fleetExecPoll, poll(100))).toMatchObject({
      status: "accepted",
      state: "running",
      exitCode: null,
      stdout: "mid\n",
    });
    expect(await dispatchRequest(table, CH.fleetExecPoll, poll(0))).toMatchObject({
      status: "accepted",
      state: "exited",
      exitCode: 0,
      stdout: "mid\ndone\n",
    });
  });

  it("refuses exec with the desktop's exact reason text and never touches the seam", async () => {
    const registry = fakeRegistry();
    const exec = fakeExec();
    const table = tableOf(registerFleetLegs({ registry, host: hostSeam(), exec }));
    expect(await dispatchRequest(table, CH.fleetExec, execCall({ command: "rm -rf /" }))).toEqual({
      status: "refused",
      reason: 'desk holds fleet access "dispatch" on this machine; this call needs "full"',
    });
    expect(exec.calls).toEqual([]);
  });

  it("audits a refused detach as refused exec-detached work", async () => {
    const registry = fakeRegistry({ fleetExecEnabled: true, fleetExecCeiling: "terminal" });
    const audit: FleetAuditEntry[] = [];
    const table = tableOf(registerFleetLegs({ registry, host: hostSeam(), exec: fakeExec(), auditSink: (e) => audit.push(e) }));
    expect(
      await dispatchRequest(table, CH.fleetExecDetach, [{ requester: MANAGER, command: "sleep 999", cwd: null, timeoutMs: null }]),
    ).toEqual({ status: "refused", reason: 'desk holds fleet access "dispatch" on this machine; this call needs "full"' });
    expect(audit.at(-1)).toMatchObject({ action: "exec-detached", accepted: false, dispatcherLabel: "desk" });
  });
});

// ── grant store persistence through the injected registry ────────────────────

describe("lite member grant store (issue #901 raise ceremony)", () => {
  it("keeps exec unreachable by default and reports the default rung", async () => {
    const table = tableOf(registerFleetLegs({ registry: fakeRegistry(), host: hostSeam() }));
    expect(await dispatchRequest(table, CH.fleetGrantRung, [MANAGER])).toEqual({ rung: "dispatch", ceiling: "dispatch", execEnabled: false });
  });

  it("raises only with this machine's token and persists the grant in the store", async () => {
    const registry = fakeRegistry({ fleetExecEnabled: true, fleetExecCeiling: "full" });
    const stateChanged = vi.fn();
    const table = tableOf(registerFleetLegs({ registry, host: hostSeam(), stateChanged }));

    expect(await dispatchRequest(table, CH.fleetGrantRaise, [{ requester: MANAGER, targetRung: "full", credential: "wrong" }])).toEqual({
      ok: false,
      reason: "the token or password does not match this machine",
    });
    const grants = () => registry.store.fleetGrants as Record<string, { rung?: string; label?: string }>;
    expect(grants()[MANAGER.instanceId]?.rung).toBeUndefined();

    expect(await dispatchRequest(table, CH.fleetGrantRaise, [{ requester: MANAGER, targetRung: "full", credential: TOKEN }])).toEqual({
      ok: true,
      rung: "full",
    });
    expect(grants()[MANAGER.instanceId]).toMatchObject({ rung: "full", label: "desk" });
    expect(stateChanged).toHaveBeenCalledTimes(1);

    // Lowering the ceiling caps the effective rung without touching the store.
    registry.setSetting("fleetExecCeiling", "manage");
    expect(await dispatchRequest(table, CH.fleetGrantRung, [MANAGER])).toMatchObject({ rung: "manage" });
    // A raise above the ceiling is refused with the member's own text.
    expect(await dispatchRequest(table, CH.fleetGrantRaise, [{ requester: MANAGER, targetRung: "terminal", credential: TOKEN }])).toEqual({
      ok: false,
      reason: 'this machine\'s ceiling is "manage"; a grant above it never takes effect',
    });
  });

  it("accepts a password holder's session credential too", async () => {
    // remotePasswordHash/salt pair for password "let-me-in-please" would be
    // produced by hashRemotePassword; here the token path stands in for the
    // full matrix — the seam check proves only credentialMatches gates.
    const registry = fakeRegistry();
    const table = tableOf(registerFleetLegs({ registry, host: hostSeam() }));
    expect(await dispatchRequest(table, CH.fleetGrantRaise, [{ requester: MANAGER, targetRung: "manage", credential: "" }])).toMatchObject({
      ok: false,
      reason: "the token or password does not match this machine",
    });
  });
});

// ── terminal open/renew/end lifecycle ordering ───────────────────────────────

describe("lite member terminal legs (mirrors fleet-server.test.ts ordering)", () => {
  it("opens on the Terminal rung, renews only live ids, and ends in caller order", async () => {
    const registry = fakeRegistry({ fleetExecCeiling: "terminal", fleetExecEnabled: true });
    registry.setSetting("fleetGrants", { [MANAGER.instanceId]: { rung: "terminal", label: "desk", updatedAt: "t" } });
    const terminals = fakeTerminals();
    const legs = registerFleetLegs({ registry, host: hostSeam(), terminals });
    const table = tableOf(legs);

    expect(await dispatchRequest(table, CH.fleetTerminalOpen, [{ requester: MANAGER, terminalId: "t-1", cols: 80, rows: 24 }])).toEqual({
      status: "accepted",
    });
    expect(await dispatchRequest(table, CH.fleetTerminalRenew, [{ requester: MANAGER, terminalIds: ["t-1", "gone"] }])).toEqual({
      alive: ["t-1"],
    });
    // The write/size legs are notifies keyed by the claimed dispatcher id.
    dispatchNotify(table, CH.fleetTerminalWrite, [MANAGER.instanceId, "t-1", "ls\n"]);
    dispatchNotify(table, CH.fleetTerminalSize, [MANAGER.instanceId, "t-1", 100, 30]);
    expect(await dispatchRequest(table, CH.fleetTerminalEnd, [{ requester: MANAGER, terminalId: "t-1" }])).toBeUndefined();
    expect(await dispatchRequest(table, CH.fleetTerminalRenew, [{ requester: MANAGER, terminalIds: ["t-1"] }])).toEqual({ alive: [] });

    expect(terminals.events).toEqual([
      `open:${MANAGER.instanceId}:t-1:terminal`,
      `renew:${MANAGER.instanceId}:t-1,gone`,
      `write:${MANAGER.instanceId}:t-1:ls\n`,
      `size:${MANAGER.instanceId}:t-1:100x30`,
      `end:${MANAGER.instanceId}:t-1`,
      `renew:${MANAGER.instanceId}:t-1`,
    ]);
  });

  it("refuses open below the Terminal rung and names it in the audit", async () => {
    const registry = fakeRegistry({ fleetExecCeiling: "terminal", fleetExecEnabled: true });
    const audit: FleetAuditEntry[] = [];
    const terminals = fakeTerminals();
    const table = tableOf(registerFleetLegs({ registry, host: hostSeam(), terminals, auditSink: (e) => audit.push(e) }));
    expect(await dispatchRequest(table, CH.fleetTerminalOpen, [{ requester: MANAGER, terminalId: "t-1", cols: 80, rows: 24 }])).toMatchObject({
      status: "refused",
      reason: expect.stringContaining('needs "terminal"'),
    });
    expect(audit.at(-1)).toMatchObject({ action: "terminal", accepted: false, rung: "terminal" });
    expect(terminals.events).toEqual([]);
  });

  it("keeps the master switch above the Terminal rung too", async () => {
    const registry = fakeRegistry({ fleetExecCeiling: "terminal", fleetExecEnabled: false });
    registry.setSetting("fleetGrants", { [MANAGER.instanceId]: { rung: "terminal", label: "desk", updatedAt: "t" } });
    const table = tableOf(registerFleetLegs({ registry, host: hostSeam(), terminals: fakeTerminals() }));
    expect(await dispatchRequest(table, CH.fleetTerminalOpen, [{ requester: MANAGER, terminalId: "t-1", cols: 80, rows: 24 }])).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("fleet exec is off"),
    });
  });
});

// ── host report shape ────────────────────────────────────────────────────────

describe("lite member fleet:hostReport", () => {
  it("answers the full desktop report shape with absent updater facts nulled", async () => {
    const registry = fakeRegistry({ fleetProjectRoots: ["/srv/repos"] });
    const table = tableOf(registerFleetLegs({ registry, host: hostSeam(), version: "0.29.0", label: "lite-box" }));
    const report = (await dispatchRequest(table, CH.fleetHostReport, [])) as Record<string, unknown>;
    expect(report).toMatchObject({
      instanceId: "member-1",
      label: "lite-box",
      version: "0.29.0",
      cpuCount: 4,
      cpuUtilization: 0.25,
      liveSessions: 1,
      runningTurns: 0,
      projects: [],
      projectRoots: ["/srv/repos"],
      os: null,
      packageManagers: null,
      ompVersion: null,
      ompPath: null,
      ompPinned: false,
      ompBelowMinimum: false,
      packageFormat: null,
      appLatestVersion: null,
      appUpdateStaged: false,
      modelFavorites: [],
    });
    expect(typeof report.sampledAt).toBe("number");
    expect(typeof report.user).not.toBe("undefined");
  });

  it("keeps a failed optional probe a null field instead of rejecting the report", async () => {
    const table = tableOf(
      registerFleetLegs({
        registry: fakeRegistry(),
        host: hostSeam({
          os: async () => {
            throw new Error("no os-release");
          },
          ompVersion: async () => "17.0.0",
          ompPath: () => "/managed/omp",
        }),
      }),
    );
    const report = (await dispatchRequest(table, CH.fleetHostReport, [])) as Record<string, unknown>;
    expect(report).toMatchObject({ os: null, ompVersion: "17.0.0", ompPath: "/managed/omp", ompBelowMinimum: true });
  });
});

// ── send / finish gates ──────────────────────────────────────────────────────

describe("lite member send/finish gates (issues #959, #978)", () => {
  it("refuses a foreign send below Dispatch and delivers at the default rung", async () => {
    const registry = fakeRegistry({ fleetGrants: { [MANAGER.instanceId]: { rung: "observe", label: "desk", updatedAt: "t" } } });
    const deliverSend = vi.fn(async () => ({ status: "delivered" as const }));
    const table = tableOf(
      registerFleetLegs({ registry, host: hostSeam(), sessions: { deliverSend, deliverFinish: async () => ({ status: "refused", reason: "x" }) } }),
    );
    const args = [{ requester: MANAGER, dispatchId: "dispatch-0001", message: "work", mode: "steer" }];
    // Observe is under Dispatch: refused before anything is staged.
    expect(await dispatchRequest(table, CH.fleetSend, args)).toMatchObject({ status: "refused" });
    expect(deliverSend).not.toHaveBeenCalled();

    // The join default (rung omitted) already sits at Dispatch — desktop rule.
    registry.setSetting("fleetGrants", { [MANAGER.instanceId]: { label: "desk", updatedAt: "t" } });
    expect(await dispatchRequest(table, CH.fleetSend, args)).toEqual({ status: "delivered" });
    expect(deliverSend).toHaveBeenCalledTimes(1);
  });

  it("lets the member's own instance skip the ladder for send", async () => {
    const registry = fakeRegistry({ fleetGrants: { [MANAGER.instanceId]: { rung: "observe", label: "desk", updatedAt: "t" } } });
    registry.store.instanceId = MANAGER.instanceId; // the owner addressing itself (loopback join)
    const deliverSend = vi.fn(async () => ({ status: "delivered" as const }));
    const table = tableOf(
      registerFleetLegs({ registry, host: hostSeam(), sessions: { deliverSend, deliverFinish: async () => ({ status: "refused", reason: "x" }) } }),
    );
    expect(await dispatchRequest(table, CH.fleetSend, [{ requester: MANAGER, dispatchId: "dispatch-0001", message: "hey", mode: "queue" }])).toEqual({
      status: "delivered",
    });
  });
});

// ── absent-not-denied channel coverage ───────────────────────────────────────

describe("lite member channel table (absent not denied)", () => {
  let bare: ReturnType<typeof registerFleetLegs>;
  beforeEach(() => {
    bare = registerFleetLegs({ registry: fakeRegistry(), host: hostSeam() });
  });

  it("serves the ladder bookkeeping even with no execution seams", () => {
    expect(Object.keys(bare.request).sort()).toEqual([CH.fleetGrantRung, CH.fleetGrantRaise, CH.fleetHostReport].sort());
    expect(Object.keys(bare.notify)).toEqual([]);
  });

  it("answers unknown-channel for the unregistered member legs through the real dispatch boundary", async () => {
    const table = tableOf(bare);
    await expect(dispatchRequest(table, CH.fleetExec, execCall())).rejects.toThrow(/^unknown channel fleet:exec$/);
    await expect(dispatchRequest(table, CH.fleetUpdateMember, [])).rejects.toThrow(/^unknown channel fleet:updateMember$/);
    // A notify that is absent simply drops (no reply channel exists to deny on).
    expect(() => dispatchNotify(table, CH.fleetTerminalWrite, [MANAGER.instanceId, "t-1", "x"])).not.toThrow();
  });

  it("keeps owner-local and updater channels off the table even when every seam is wired", () => {
    const full = registerFleetLegs({
      registry: fakeRegistry(),
      host: hostSeam(),
      exec: fakeExec(),
      terminals: fakeTerminals(),
      sessions: { deliverSend: async () => ({ status: "delivered" }), deliverFinish: async () => ({ status: "refused", reason: "x" }) },
      providerKeys: { install: () => {} },
    });
    const channels = Object.keys(full.request);
    for (const never of [
      CH.fleetUpdateMember,
      CH.fleetUpdatePoll,
      CH.fleetMachines,
      CH.fleetDispatch,
      CH.fleetGrantSet,
      CH.fleetAudit,
      CH.fleetTerminalStart,
      CH.fleetCopyProject,
    ]) {
      expect(channels).not.toContain(never);
    }
    for (const proxied of [CH.fleetExec, CH.fleetExecDetach, CH.fleetExecPoll, CH.fleetSend, CH.fleetFinish, CH.fleetProviderKeys]) {
      expect(channels).toContain(proxied);
    }
    expect(Object.keys(full.notify).sort()).toEqual([CH.fleetTerminalWrite, CH.fleetTerminalSize].sort());
  });

  it("revokes running execs and terminals on enforceLadder with the rung predicates", () => {
    const registry = fakeRegistry({ fleetExecCeiling: "terminal", fleetExecEnabled: true });
    registry.setSetting("fleetGrants", {
      [MANAGER.instanceId]: { rung: "observe", label: "desk", updatedAt: "t" },
      "kept-1": { rung: "full", label: "kept", updatedAt: "t" },
    });
    const exec = fakeExec();
    const terminals = fakeTerminals();
    registerFleetLegs({ registry, host: hostSeam(), exec, terminals }).enforceLadder();
    expect(exec.revoked).toHaveLength(1);
    const stillFull = exec.revoked[0]!;
    expect(stillFull(MANAGER.instanceId)).toBe(false); // a named grant below Full loses its runs
    expect(stillFull("kept-1")).toBe(true); // Full under a Terminal ceiling keeps them
    expect(stillFull("unknown-id")).toBe(false); // an unseen id only holds the dispatch default
    expect(terminals.revoked).toHaveLength(1);
    const stillTerminal = terminals.revoked[0]!;
    expect(stillTerminal("kept-1")).toBe(false); // Full control does NOT include Terminal
  });

  it("disposes the exec and terminal seams on the quit path", () => {
    const exec = fakeExec();
    const terminals = fakeTerminals();
    registerFleetLegs({ registry: fakeRegistry(), host: hostSeam(), exec, terminals }).dispose();
    expect(exec.disposed).toBe(1);
    expect(terminals.disposed).toBe(1);
  });
});
