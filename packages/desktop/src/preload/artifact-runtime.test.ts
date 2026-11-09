import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactGuestBridge } from "../artifact-runtime-protocol";

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: electron.expose }, ipcRenderer: { invoke: electron.invoke, on: electron.on } }));
beforeEach(() => {
  vi.resetModules();
  electron.expose.mockReset(); electron.invoke.mockReset(); electron.on.mockReset();
  electron.invoke.mockResolvedValue({ stateRevision: 0 });
  vi.stubGlobal("process", { ...process, argv: ["electron", "--omp-artifact-surface=11111111-1111-4111-8111-111111111111"], isMainFrame: true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
async function bridge(): Promise<ArtifactGuestBridge> {
  // Each test intentionally reloads the preload entry to exercise its module-load
  // frame/ticket boundary; a static import would run before the isolated globals.
  await import("./artifact-runtime");
  return electron.expose.mock.calls[0][1] as ArtifactGuestBridge;
}
describe("sandbox artifact preload", () => {
  it("exposes only load/saveState and hides ticket/raw IPC", async () => {
    const api = await bridge();
    expect(electron.expose.mock.calls[0][0]).toBe("ompArtifact");
    expect(Object.keys(api).sort()).toEqual(["load", "saveState"]);
  });
  it("never exposes capabilities in a subframe or without a main-issued argument", async () => {
    vi.stubGlobal("process", { ...process, argv: [], isMainFrame: false });
    await import("./artifact-runtime");
    expect(electron.expose).not.toHaveBeenCalled();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
  it("refuses oversized, cyclic, prototype and nonfinite patches before IPC, then succeeds", async () => {
    const api = await bridge();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const invalid = [
      { expectedStateRevision: 0, set: { text: "x".repeat(1024 * 1024) } },
      { expectedStateRevision: 0, set: cycle },
      { expectedStateRevision: 0, set: JSON.parse('{"__proto__":{}}') },
      { expectedStateRevision: 0, set: { number: NaN } },
      { expectedStateRevision: 0, set: { sparse: Array(4) } },
      { expectedStateRevision: 0, set: { extended: Object.assign([1], { extra: true }) } },
    ];
    for (const patch of invalid) await expect(api.saveState(patch as Parameters<ArtifactGuestBridge["saveState"]>[0])).rejects.toThrow();
    expect(electron.invoke.mock.calls.some(row => row[0] === "artifact-runtime:save-state")).toBe(false);
    await api.saveState({ expectedStateRevision: 0, set: { done: true } });
    expect(electron.invoke.mock.calls.at(-1)?.[0]).toBe("artifact-runtime:save-state");
  });
  it("enforces eight inflight and twenty calls per second with recovery", async () => {
    vi.useFakeTimers();
    const api = await bridge();
    const gate = Promise.withResolvers<void>();
    electron.invoke.mockImplementation((channel) => channel === "artifact-runtime:hello" ? Promise.resolve() : gate.promise);
    const pending = Array.from({ length: 8 }, () => api.load());
    await expect(api.load()).rejects.toThrow("rate limit");
    gate.resolve(); await Promise.all(pending);
    electron.invoke.mockResolvedValue({});
    for (let i = 0; i < 11; i++) await api.load();
    await expect(api.load()).rejects.toThrow("rate limit");
    vi.advanceTimersByTime(1001);
    await expect(api.saveState({ expectedStateRevision: 0, set: { recovered: true } })).resolves.toBeDefined();
  });
  it("does not accept a forged caller-provided runtime channel", async () => {
    const api = await bridge();
    await api.saveState({ expectedStateRevision: 0, set: { channel: "settings:enable", args: [true] } });
    expect(electron.invoke.mock.calls.at(-1)?.[0]).toBe("artifact-runtime:save-state");
  });
});
