import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAN_PREFLIGHT_RESULT_PREFIX,
  PLAN_REVIEW_SENTINEL,
  parsePlanPreflightReply,
} from "@omp-ui/core";
import type { PlanRenderResult, RpcFrame } from "@omp-ui/core";
import { PlanPreflightController } from "./plan-preflight";
import { readConfinedPlanFile } from "./plan-file";
import type { RpcLiveEntry } from "./live-entry";

/**
 * Controller-level units for the invariants the manager wiring cannot see:
 * generation replacement aborts, stale completions, snapshot lifecycle, and
 * the exact shape of the enriched delivery. The end-to-end gate behavior is
 * covered in session-manager.test.ts ("html plan preflight").
 */

const TAB = "tab-1";
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const dirs: string[] = [];

interface Harness {
  root: string; // the sessions root; the lineage dir lives under it
  controller: PlanPreflightController;
  sent: RpcFrame[];
  delivered: { tabId: string; frame: RpcFrame }[];
  released: string[];
  sessions: { tabId: string }[];
  setVerify(
    fn: (html: string, themeId: string, signal: AbortSignal) => Promise<PlanRenderResult>,
  ): void;
}

function harness(): Harness {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, "omp-ui-preflight-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, LINEAGE), { recursive: true });

  const sent: RpcFrame[] = [];
  const delivered: { tabId: string; frame: RpcFrame }[] = [];
  const released: string[] = [];
  const sessions: { tabId: string }[] = [{ tabId: TAB }];
  let verify: (html: string, themeId: string, signal: AbortSignal) => Promise<PlanRenderResult> =
    async () => ({ status: "passed" as const, diagnostics: [] });
  const controller = new PlanPreflightController({
    registry: { sessions } as never,
    getSessionsRoot: () => root,
    readPlanFile: readConfinedPlanFile,
    verify: (html, themeId, signal) => verify(html, themeId, signal),
    getThemeId: () => "theme-under-test",
    sendToLive: (_entry, frame) => sent.push(frame),
    deliver: (tabId, frame) => delivered.push({ tabId, frame }),
    onHoldReleased: (tabId) => released.push(tabId),
  });
  return {
    root,
    controller,
    sent,
    delivered,
    released,
    sessions,
    setVerify: (fn) => (verify = fn),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const hashOf = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

function entry(): RpcLiveEntry {
  return {
    kind: "rpc-ui",
    record: { tabId: TAB, lineageDir: LINEAGE } as never,
    rpc: { send: () => {} },
  } as unknown as RpcLiveEntry;
}

function htmlFrame(id: string, planFilePath: string, planAbsPath: string, title = "the plan"): RpcFrame {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title: `${PLAN_REVIEW_SENTINEL}${JSON.stringify({ title, planFilePath, planAbsPath })}`,
  } as RpcFrame;
}

/** Writes the artifact under the harness lineage dir; returns its path. */
function artifact(h: Harness, name = "auth-plan.html", text = "<p>plan</p>"): string {
  const abs = path.join(h.root, LINEAGE, name);
  fs.writeFileSync(abs, text, "utf8");
  return abs;
}

const replies = (sent: RpcFrame[]): unknown[] =>
  sent
    .map((f) => (f as Record<string, unknown>).value)
    .filter((v) => typeof v === "string" && v.startsWith(PLAN_PREFLIGHT_RESULT_PREFIX))
    .map((v) => parsePlanPreflightReply(v as string)?.result);

describe("PlanPreflightController", () => {
  it("does not claim markdown, non-plan, or non-select frames", () => {
    const h = harness();
    const e = entry();

    expect(h.controller.claimFrame(TAB, htmlFrame("m1", "local://auth-plan.md", path.join(h.root, LINEAGE, "auth-plan.md")), e)).toBe(false);
    expect(h.controller.claimFrame(TAB, { type: "agent_start" } as RpcFrame, e)).toBe(false);
    expect(
      h.controller.claimFrame(
        TAB,
        { type: "extension_ui_request", id: "s1", method: "select", title: "Pick an option" } as RpcFrame,
        e,
      ),
    ).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.controller.isHeld(TAB)).toBe(false);
  });

  it("fails a malformed plan sentinel closed, never as a generic dialog", () => {
    const h = harness();

    const claimed = h.controller.claimFrame(
      TAB,
      {
        type: "extension_ui_request",
        id: "bad1",
        method: "select",
        title: `${PLAN_REVIEW_SENTINEL}this is not json`,
      } as RpcFrame,
      entry(),
    );

    expect(claimed).toBe(true);
    expect(h.controller.isHeld(TAB)).toBe(false); // answered, not held
    const reply = replies(h.sent)[0];
    expect(reply).toMatchObject({ status: "unavailable" });
    expect((reply as { diagnostics: { code: string; repair: string }[] }).diagnostics[0]).toMatchObject({
      code: "RENDER_INVARIANT",
      repair: "application",
    });
    expect(h.delivered).toEqual([]);
  });

  it("delivers the original frame with only the title's JSON enriched by main's hash", async () => {
    const h = harness();
    const text = "<!doctype html><p>ship it</p>";
    const abs = artifact(h, "ship-plan.html", text);

    expect(h.controller.claimFrame(TAB, htmlFrame("p1", "local://ship-plan.html", abs), entry())).toBe(true);
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1));

    const frame = h.delivered[0]!.frame as Record<string, unknown>;
    expect(frame.id).toBe("p1");
    expect(frame.method).toBe("select");
    expect(frame.type).toBe("extension_ui_request");
    const title = (frame.title as string).slice(PLAN_REVIEW_SENTINEL.length);
    expect(JSON.parse(title)).toEqual({
      title: "the plan",
      planFilePath: "local://ship-plan.html",
      planAbsPath: abs,
      sourceHash: hashOf(text),
    });
    expect(h.controller.snapshotFor(TAB, abs)).toMatchObject({ text, sourceHash: hashOf(text) });
    expect(h.released).toEqual([TAB]);
  });

  it("a replacing generation aborts the old verification and stale completions die", async () => {
    const h = harness();
    const abs = artifact(h);

    const signals: AbortSignal[] = [];
    const resolvers: ((r: PlanRenderResult) => void)[] = [];
    h.setVerify(
      (_html, _theme, signal) =>
        new Promise<PlanRenderResult>((res) => {
          signals.push(signal);
          resolvers.push(res);
        }),
    );

    expect(h.controller.claimFrame(TAB, htmlFrame("p1", "local://auth-plan.html", abs), entry())).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    // A new generation replaces the hold and aborts the running verification.
    expect(h.controller.claimFrame(TAB, htmlFrame("p2", "local://auth-plan.html", abs), entry())).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);

    resolvers[0]!({ status: "passed", diagnostics: [] });
    resolvers[1]!({ status: "passed", diagnostics: [] });
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1));
    expect((h.delivered[0]!.frame as Record<string, unknown>).id).toBe("p2");
  });

  it("drops a completion once the session left the registry", async () => {
    const h = harness();
    const abs = artifact(h);
    let resolve!: (r: PlanRenderResult) => void;
    const verifySpy = vi.fn(() => new Promise<PlanRenderResult>((res) => (resolve = res)));
    h.setVerify(verifySpy);

    expect(h.controller.claimFrame(TAB, htmlFrame("p1", "local://auth-plan.html", abs), entry())).toBe(true);
    await vi.waitFor(() => expect(verifySpy).toHaveBeenCalled());
    h.sessions.length = 0; // the session is being deleted
    // The continuation from the resolved verification to the stale check is a
    // single synchronous hop; one microtask yield flushes it deterministically.
    resolve({ status: "passed", diagnostics: [] });
    await Promise.resolve();
    expect(h.delivered).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("clear() cancels the hold; the old completion cannot revive it", async () => {
    const h = harness();
    const abs = artifact(h);
    let resolve!: (r: PlanRenderResult) => void;
    let signal!: AbortSignal;
    h.setVerify(
      (_html, _theme, sig) =>
        new Promise<PlanRenderResult>((res) => {
          signal = sig;
          resolve = res;
        }),
    );

    expect(h.controller.claimFrame(TAB, htmlFrame("p1", "local://auth-plan.html", abs), entry())).toBe(true);
    await vi.waitFor(() => expect(signal).toBeDefined());
    h.controller.clear(TAB);
    expect(h.controller.isHeld(TAB)).toBe(false);
    // resolve() → the process continuation → the isStale return is one hop.
    resolve({ status: "passed", diagnostics: [] });
    await Promise.resolve();
    expect(h.delivered).toEqual([]);
    // The release fired once for the cancel itself, not twice.
    expect(h.released).toEqual([TAB]);
  });

  it("a slug/path name mismatch is an application defect, never a verification", async () => {
    const h = harness();
    const abs = artifact(h);
    const verifySpy = vi.fn(
      async (): Promise<PlanRenderResult> => ({ status: "passed", diagnostics: [] }),
    );
    h.setVerify(verifySpy);

    expect(
      h.controller.claimFrame(TAB, htmlFrame("p1", "local://other-plan.html", abs), entry()),
    ).toBe(true);
    await vi.waitFor(() => expect(replies(h.sent)).toHaveLength(1));

    expect(verifySpy).not.toHaveBeenCalled();
    const reply = replies(h.sent)[0] as { status: string; diagnostics: { code: string; repair: string }[] };
    expect(reply.status).toBe("failed");
    expect(reply.diagnostics[0]).toMatchObject({ code: "PLAN_READ_FAILED", repair: "application" });
  });

  it("a new claim erases the previous cycle's snapshot", async () => {
    const h = harness();
    const abs = artifact(h);

    expect(h.controller.claimFrame(TAB, htmlFrame("p1", "local://auth-plan.html", abs), entry())).toBe(true);
    await vi.waitFor(() => expect(h.controller.snapshotFor(TAB, abs)).not.toBeNull());

    let resolve2!: (r: PlanRenderResult) => void;
    const verify2 = vi.fn(() => new Promise<PlanRenderResult>((res) => (resolve2 = res)));
    h.setVerify(verify2);
    fs.writeFileSync(abs, "<p>v2</p>", "utf8");
    expect(h.controller.claimFrame(TAB, htmlFrame("p2", "local://auth-plan.html", abs), entry())).toBe(true);
    // verify2 belongs to the second claim only; the first used the default.
    await vi.waitFor(() => expect(verify2).toHaveBeenCalledTimes(1));
    // Mid-flight there is no gate and no stale snapshot to read.
    expect(h.controller.snapshotFor(TAB, abs)).toBeNull();
    resolve2({ status: "failed", diagnostics: [] });
    await vi.waitFor(() => expect(h.controller.isHeld(TAB)).toBe(false));
    // A failed validation leaves no snapshot behind either.
    expect(h.controller.snapshotFor(TAB, abs)).toBeNull();
  });
});
