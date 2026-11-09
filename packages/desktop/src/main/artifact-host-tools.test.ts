import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactHostTools } from "./artifact-host-tools";
import { createRpcLiveEntry, type RpcLiveEntry } from "./live-entry";
import { ownedSessionRecord } from "./test/fixtures";
import { fleetToolAccess, type RpcFrame } from "@omp-ui/core";

const controllers: ArtifactHostTools[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.close(); vi.useRealTimers(); });

function fixture() {
  let enabled = true;
  const entry = createRpcLiveEntry(ownedSessionRecord(), fleetToolAccess({chat: false, agentDispatchEnabled: true, requestedByKind: null}));
  let current: RpcLiveEntry | null = entry;
  const sent: RpcFrame[] = [];
  const errors: string[] = [];
  entry.rpc = {send: (command: RpcFrame) => sent.push(command)} as never;
  const controller = new ArtifactHostTools({enabled: () => enabled, current: () => current, error: (_tab, message) => errors.push(message)});
  controllers.push(controller);
  const initial = controller.initial(entry, {vault: true, fleet: true, device: true, artifacts: true}) as RpcFrame;
  const ack = (command: RpcFrame, success = true) => controller.observe(entry, {type: "response", id: command.id, command: "set_host_tools", success, ...(!success ? {error: "runtime refused roster"} : {})});
  return {entry, sent, errors, controller, initial, ack, enable: (value: boolean) => {enabled = value; return controller.sync(value);}, replace: () => { current = null; }};
}

describe("artifact host roster admission", () => {
  it("keeps pending authoring unavailable and sends no hot commands before ready", async () => {
    const f = fixture();
    const off = f.enable(false);
    f.ack(f.initial);
    await Promise.resolve();
    expect(f.sent).toEqual([]);
    expect(f.entry.artifactHostToolsEpoch).toBe(-1);
    f.controller.ready(f.entry);
    await Promise.resolve();
    expect(f.sent[0]).toMatchObject({type: "set_host_tools"});
    f.ack(f.sent[0]!);
    await off;
    expect(f.entry.hostToolOptions).toEqual({vault: true, fleet: true, device: true, artifacts: false});
    expect(f.entry.artifactHostToolsEpoch).toBe(f.controller.currentEpoch);
  });

  it("coalesces rapid desires without allowing an old acknowledgement to enable authoring", async () => {
    const f = fixture();
    f.controller.ready(f.entry);
    const off = f.enable(false);
    const on = f.enable(true);
    const offAgain = f.enable(false);
    f.ack(f.initial);
    expect(f.entry.artifactHostToolsEpoch).toBe(-1);
    await Promise.resolve();
    expect(f.sent).toHaveLength(1);
    f.ack(f.sent[0]!);
    await Promise.all([off, on, offAgain]);
    expect(f.entry.hostToolOptions?.artifacts).toBe(false);
    expect(f.entry.hostToolOptions?.vault).toBe(true);
    expect(f.entry.hostToolOptions?.fleet).toBe(true);
    expect(f.entry.hostToolOptions?.device).toBe(true);
    expect(f.entry.artifactAuthoringError).toBeNull();
  });

  it("reports rejection and timeout without marking a successor ready or hanging gate reconciliation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.controller.ready(f.entry);
    f.ack(f.initial, false);
    expect(f.entry.artifactAuthoringError).toBe("runtime refused roster");
    const pending = f.enable(false);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(f.entry.artifactAuthoringError).toContain("timed out");
    expect(f.errors).toEqual(["runtime refused roster", expect.stringContaining("timed out")]);
    const next = f.enable(true);
    await Promise.resolve();
    f.replace();
    f.controller.forget(f.entry);
    f.ack(f.sent.at(-1)!);
    await next;
    expect(f.entry.artifactAuthoringError).not.toBeNull();
  });
});
