import { describe, expect, it, vi } from "vitest";
import type { ProjectRequestPrompt } from "@omp-ui/core";
import { ProjectRequestGate } from "./project-request-gate";

const TAB = "tab-1";
const prompt = (promptId: string, verb: "register" | "clone" = "register"): ProjectRequestPrompt => ({
  promptId,
  verb,
  source: verb === "clone" ? "https://github.com/acme/app" : "/srv/repos/app",
  name: verb === "clone" ? "app" : null,
  defaultParent: verb === "clone" ? "/srv/repos" : null,
  origin: null,
  executableConfig: [],
  requestedAt: "2026-11-18T00:00:00.000Z",
});

function gate() {
  const onSettled = vi.fn<(tabId: string) => void>();
  const g = new ProjectRequestGate({ broadcast: async () => {}, onSettled });
  return { g, onSettled };
}
const live = () => new AbortController().signal;

describe("ProjectRequestGate (#1228)", () => {
  it("resolves allow and deny, and is pending only while open", async () => {
    const { g, onSettled } = gate();
    const allowed = g.request(TAB, prompt("p1", "clone"), live());
    expect(g.pending(TAB)).toBe(true);
    expect(g.prompt(TAB)?.promptId).toBe("p1");
    expect(g.answer(TAB, "p1", { kind: "allow", parent: "/elsewhere" })).toEqual({ ok: true });
    expect(await allowed).toEqual({ kind: "allow", parent: "/elsewhere" });
    expect(g.pending(TAB)).toBe(false);
    expect(g.prompt(TAB)).toBeNull();
    expect(onSettled).toHaveBeenCalledWith(TAB);

    const denied = g.request(TAB, prompt("p2"), live());
    g.answer(TAB, "p2", { kind: "deny" });
    expect(await denied).toEqual({ kind: "deny" });
  });

  it("ignores a parent on a register allow", async () => {
    const { g } = gate();
    const pending = g.request(TAB, prompt("p1"), live());
    g.answer(TAB, "p1", { kind: "allow", parent: "/elsewhere" });
    expect(await pending).toEqual({ kind: "allow", parent: null });
  });

  it("resolves cancelled and clears on abort and on exit", async () => {
    const { g } = gate();
    const controller = new AbortController();
    const aborted = g.request(TAB, prompt("p1"), controller.signal);
    controller.abort();
    expect(await aborted).toBe("cancelled");
    expect(g.pending(TAB)).toBe(false);

    const exited = g.request(TAB, prompt("p2"), live());
    g.onExit(TAB);
    expect(await exited).toBe("cancelled");
    expect(g.pending(TAB)).toBe(false);
  });

  it("refuses a second open request without replacing the first", async () => {
    const { g } = gate();
    const first = g.request(TAB, prompt("p1"), live());
    expect(await g.request(TAB, prompt("p2"), live())).toEqual({
      kind: "refused",
      reason: "another project request is waiting for the user",
    });
    expect(g.prompt(TAB)?.promptId).toBe("p1");
    g.answer(TAB, "p1", { kind: "deny" });
    await first;
  });

  it("refuses the fourth request in a run, and agent_start resets the count", async () => {
    const { g } = gate();
    for (const id of ["p1", "p2", "p3"]) {
      const pending = g.request(TAB, prompt(id), live());
      g.answer(TAB, id, { kind: "deny" });
      await pending;
    }
    expect(await g.request(TAB, prompt("p4"), live())).toEqual({ kind: "refused", reason: "too many project requests in this run" });
    expect(g.pending(TAB)).toBe(false);
    g.onFrame(TAB, { type: "agent_start" });
    const fresh = g.request(TAB, prompt("p5"), live());
    expect(g.pending(TAB)).toBe(true);
    g.answer(TAB, "p5", { kind: "deny" });
    await fresh;
  });

  it("answers a stale or duplicate promptId with no longer pending", async () => {
    const { g } = gate();
    expect(g.answer(TAB, "p1", { kind: "deny" })).toEqual({ ok: false, reason: "this request is no longer pending" });
    const pending = g.request(TAB, prompt("p1"), live());
    expect(g.answer(TAB, "other", { kind: "allow", parent: null })).toEqual({ ok: false, reason: "this request is no longer pending" });
    expect(g.pending(TAB)).toBe(true);
    expect(g.answer(TAB, "p1", { kind: "deny" })).toEqual({ ok: true });
    expect(g.answer(TAB, "p1", { kind: "allow", parent: null })).toEqual({ ok: false, reason: "this request is no longer pending" });
    expect(await pending).toEqual({ kind: "deny" });
  });
});
