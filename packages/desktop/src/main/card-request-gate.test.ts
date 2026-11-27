import { describe, expect, it, vi } from "vitest";
import type { FleetGrantRaisePrompt } from "@omp-ui/core";
import { CardRequestGate } from "./card-request-gate";

const TAB = "tab-1";
const prompt = (promptId: string): FleetGrantRaisePrompt => ({
  promptId,
  machine: "studio",
  rung: "manage",
  currentRung: "dispatch",
  requestedAt: "2026-11-27T00:00:00.000Z",
});
type Decision = { kind: "allow"; secret: string } | { kind: "deny" };

function gate() {
  const onSettled = vi.fn<(tabId: string) => void>();
  const onRaised = vi.fn<(tabId: string) => void>();
  const onSettleAttention = vi.fn<(tabId: string) => void>();
  const g = new CardRequestGate<FleetGrantRaisePrompt, Decision>(
    { broadcast: async () => {}, onSettled, onRaised, onSettleAttention, perRun: 2 },
    "grant raise",
  );
  return { g, onSettled, onRaised, onSettleAttention };
}
const live = () => new AbortController().signal;

describe("CardRequestGate grant raises (#1393)", () => {
  it("resolves allow with the secret, and deny; pending only while open", async () => {
    const { g, onSettled, onRaised, onSettleAttention } = gate();
    const allowed = g.request(TAB, prompt("g1"), live());
    expect(g.pending(TAB)).toBe(true);
    expect(g.prompt(TAB)?.promptId).toBe("g1");
    expect(onRaised).toHaveBeenCalledWith(TAB);
    expect(g.answer(TAB, "g1", { kind: "allow", secret: " s3cret " })).toEqual({ ok: true });
    expect(await allowed).toEqual({ kind: "allow", secret: " s3cret " });
    expect(g.pending(TAB)).toBe(false);
    expect(g.prompt(TAB)).toBeNull();
    expect(onSettled).toHaveBeenCalledWith(TAB);
    expect(onSettleAttention).toHaveBeenCalledWith(TAB);

    const denied = g.request(TAB, prompt("g2"), live());
    g.answer(TAB, "g2", { kind: "deny" });
    expect(await denied).toEqual({ kind: "deny" });
  });

  it("resolves cancelled on abort and on exit, and clears the run count", async () => {
    const { g } = gate();
    const controller = new AbortController();
    const aborted = g.request(TAB, prompt("g1"), controller.signal);
    controller.abort();
    expect(await aborted).toBe("cancelled");
    expect(g.pending(TAB)).toBe(false);

    const exited = g.request(TAB, prompt("g2"), live());
    g.onExit(TAB);
    expect(await exited).toBe("cancelled");
    expect(g.pending(TAB)).toBe(false);
  });

  it("refuses a second open card with the grant raise kind", async () => {
    const { g } = gate();
    const first = g.request(TAB, prompt("g1"), live());
    expect(await g.request(TAB, prompt("g2"), live())).toEqual({
      kind: "refused",
      reason: "another grant raise is waiting for the user",
    });
    expect(g.prompt(TAB)?.promptId).toBe("g1");
    g.answer(TAB, "g1", { kind: "deny" });
    await first;
  });

  it("refuses past the per-run cap with the grant raise kind, and agent_start resets", async () => {
    const { g } = gate();
    for (const id of ["g1", "g2"]) {
      const pending = g.request(TAB, prompt(id), live());
      g.answer(TAB, id, { kind: "deny" });
      await pending;
    }
    expect(await g.request(TAB, prompt("g3"), live())).toEqual({
      kind: "refused",
      reason: "too many grant raises in this run",
    });
    expect(g.pending(TAB)).toBe(false);
    g.onFrame(TAB, { type: "agent_start" });
    const fresh = g.request(TAB, prompt("g4"), live());
    expect(g.pending(TAB)).toBe(true);
    g.answer(TAB, "g4", { kind: "deny" });
    await fresh;
  });

  it("answers a stale or duplicate promptId with no longer pending", async () => {
    const { g } = gate();
    const pending = g.request(TAB, prompt("g1"), live());
    expect(g.answer(TAB, "stale", { kind: "deny" })).toEqual({ ok: false, reason: "this request is no longer pending" });
    expect(g.answer(TAB, "g1", { kind: "deny" })).toEqual({ ok: true });
    expect(g.answer(TAB, "g1", { kind: "deny" })).toEqual({ ok: false, reason: "this request is no longer pending" });
    await pending;
  });
});
