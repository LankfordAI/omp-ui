import { describe, expect, it, vi } from "vitest";
import { LOCAL_MACHINE_KEY, type FleetMachine, type FleetRung, type FleetToolGrantRaiseArgs, type FleetGrantRaisePrompt } from "@omp-ui/core";
import type { HostCallControl } from "./host-bridge";
import { FleetGrantRaiseRequests, type FleetGrantRaiseRequestsDeps } from "./fleet-grant-raise";
import type { CardOutcome } from "./card-request-gate";

const TAB = "tab-1";
const SECRET = "SECRET-RAISE-MARKER-42";

const machine = (key: string, nickname: string | null, grantRung: FleetRung | null = "dispatch"): FleetMachine => ({
  key,
  nickname,
  status: "ready",
  error: null,
  preference: "normal",
  report: null,
  receivedAt: 0,
  grantRung,
  address: null,
  sshReachable: null,
  maintenance: null,
});

const control = () => ({
  signal: new AbortController().signal,
  suspendWatchdog: vi.fn<() => void>(),
  rearmWatchdog: vi.fn<(ms: number) => void>(),
}) satisfies HostCallControl;

function harness(over: {
  machines?: FleetMachine[];
  eligibility?: string | null;
  answer?: CardOutcome<{ kind: "allow"; secret: string } | { kind: "deny" }>;
  requestGrant?: FleetGrantRaiseRequestsDeps["requestGrant"];
} = {}) {
  const asked: FleetGrantRaisePrompt[] = [];
  const grants: Array<{ machineKey: string; rung: FleetRung; secret: string }> = [];
  const deps: FleetGrantRaiseRequestsDeps = {
    eligibility: () => over.eligibility ?? null,
    machines: async () => over.machines ?? [machine(LOCAL_MACHINE_KEY, null, "full"), machine("remote-b", "studio", "dispatch")],
    requestGrant: over.requestGrant ?? (async (machineKey, rung, secret) => {
      grants.push({ machineKey, rung, secret });
      return { ok: true, rung };
    }),
    ask: async (_tabId, prompt) => {
      asked.push(prompt);
      return over.answer ?? { kind: "allow", secret: SECRET };
    },
  };
  return { requests: new FleetGrantRaiseRequests(deps), asked, grants };
}

const raise = (machine: string, rung: FleetToolGrantRaiseArgs["rung"] = "manage"): FleetToolGrantRaiseArgs => ({ machine, rung });

describe("FleetGrantRaiseRequests (#1393)", () => {
  it("rides the eligibility refusal through with no card", async () => {
    const h = harness({ eligibility: "private sessions do not raise fleet access" });
    expect(await h.requests.request(TAB, raise("studio"), control())).toEqual({
      ok: false,
      reason: "private sessions do not raise fleet access",
    });
    expect(h.asked).toEqual([]);
    expect(h.grants).toEqual([]);
  });

  it("refuses an unknown machine", async () => {
    const h = harness();
    expect(await h.requests.request(TAB, raise("nowhere"), control())).toEqual({
      ok: false,
      reason: 'no fleet machine is named "nowhere" (known: this computer, studio)',
    });
    expect(h.asked).toEqual([]);
  });

  it("refuses this computer with the owner-setting reason", async () => {
    const h = harness();
    expect(await h.requests.request(TAB, raise("this computer"), control())).toEqual({
      ok: false,
      reason: "the access rungs on this computer are the owner's setting (Settings → Remote instances → Fleet access)",
    });
    expect(h.asked).toEqual([]);
  });

  it("holds the card with currentRung null when the probe failed", async () => {
    const c = control();
    const h = harness({ machines: [machine("remote-b", "studio", null)], answer: { kind: "deny" } });
    expect(await h.requests.request(TAB, raise("studio"), c)).toEqual({ ok: false, reason: "the user declined" });
    expect(h.asked[0]).toMatchObject({ machine: "studio", rung: "manage", currentRung: null });
    expect(c.rearmWatchdog).not.toHaveBeenCalled();
    expect(h.grants).toEqual([]);
  });

  it("denies with the user-declined reason after holding the card", async () => {
    const c = control();
    const h = harness({ answer: { kind: "deny" } });
    expect(await h.requests.request(TAB, raise("studio"), c)).toEqual({ ok: false, reason: "the user declined" });
    expect(h.asked[0]).toMatchObject({ machine: "studio", rung: "manage", currentRung: "dispatch" });
    expect(c.suspendWatchdog).toHaveBeenCalled();
    expect(c.rearmWatchdog).not.toHaveBeenCalled();
    expect(h.grants).toEqual([]);
  });

  it("maps a cancelled card to the cancelled reason", async () => {
    const h = harness({ answer: "cancelled" });
    expect(await h.requests.request(TAB, raise("studio"), control())).toEqual({
      ok: false,
      reason: "the request was cancelled",
    });
    expect(h.grants).toEqual([]);
  });

  it("passes a gate refusal reason through", async () => {
    const h = harness({ answer: { kind: "refused", reason: "another grant raise is waiting for the user" } });
    expect(await h.requests.request(TAB, raise("studio"), control())).toEqual({
      ok: false,
      reason: "another grant raise is waiting for the user",
    });
  });

  it("on Allow rearms the watchdog and calls requestGrant with the trimmed secret", async () => {
    const c = control();
    const h = harness({ answer: { kind: "allow", secret: `  ${SECRET}  ` } });
    expect(await h.requests.request(TAB, raise("studio", "full"), c)).toEqual({ ok: true, rung: "full" });
    expect(h.grants).toEqual([{ machineKey: "remote-b", rung: "full", secret: SECRET }]);
    expect(c.suspendWatchdog).toHaveBeenCalledTimes(1);
    expect(c.rearmWatchdog).toHaveBeenCalledWith(60_000);
  });

  it("never places the secret in any refusal reason", async () => {
    const h = harness({ answer: { kind: "allow", secret: SECRET } });
    const outcomes = [
      await h.requests.request(TAB, raise("nowhere"), control()),
      await h.requests.request(TAB, raise("this computer"), control()),
      await h.requests.request(TAB, raise("studio"), { ...control(), signal: new AbortController().signal }),
    ];
    for (const outcome of outcomes) {
      if (!outcome.ok) expect(outcome.reason).not.toContain(SECRET);
    }
  });

  it("passes a member refusal reason through untouched", async () => {
    const h = harness({
      requestGrant: async () => ({ ok: false, reason: 'studio holds fleet access "dispatch" on this machine; this call needs "manage"' }),
    });
    expect(await h.requests.request(TAB, raise("studio"), control())).toEqual({
      ok: false,
      reason: 'studio holds fleet access "dispatch" on this machine; this call needs "manage"',
    });
  });

  it("resolves the machineKey before the hold so a rename cannot redirect the secret", async () => {
    let resolveAsk: (() => void) | undefined;
    const machines = [machine("remote-b", "studio", "dispatch")];
    const grants: Array<{ machineKey: string; rung: FleetRung; secret: string }> = [];
    const requests = new FleetGrantRaiseRequests({
      eligibility: () => null,
      machines: async () => machines,
      requestGrant: async (machineKey, rung, secret) => {
        grants.push({ machineKey, rung, secret });
        return { ok: true, rung };
      },
      ask: async () => {
        // The card is open; the rename lands here, before the answer.
        await new Promise<void>((resolve) => (resolveAsk = resolve));
        return { kind: "allow", secret: SECRET };
      },
    });
    const pending = requests.request(TAB, raise("studio"), control());
    await vi.waitFor(() => expect(resolveAsk).toBeDefined());
    void resolveAsk!();
    expect(await pending).toEqual({ ok: true, rung: "manage" });
    expect(grants).toEqual([{ machineKey: "remote-b", rung: "manage", secret: SECRET }]);
  });
});
