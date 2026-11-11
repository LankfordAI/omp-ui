import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { deriveTheme } from "@omp-ui/core";
import themeSources from "../renderer/src/lib/theme-sources.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactGuestBroker, artifactDocumentIdentity, artifactThemeCss, validateArtifactPatch, type ArtifactSurfaceService, type ArtifactSurfaceResolution } from "./artifact-guest-broker";

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(), partition: {} }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => electron.handlers.set(channel, handler) },
  session: { fromPartition: () => electron.partition },
}));
const SOURCE = { artifactId: "11111111-1111-4111-8111-111111111111", codeRevisionId: "22222222-2222-4222-8222-222222222222", dataSnapshotId: "33333333-3333-4333-8333-333333333333" };
const palette = deriveTheme(themeSources[0]!);
const THEME = { dark: palette.dark, tokens: palette.tokens };
class Contents extends EventEmitter {
  mainFrame = { url: "about:blank" };
  hostWebContents: Contents | undefined;
  session = electron.partition;
  url = "about:blank";
  preferences: Record<string, unknown> = {};
  sent: unknown[][] = [];
  destroyed = false;
  focused = 0;
  scripts: string[] = [];
  isDestroyed(): boolean { return this.destroyed; }
  focus(): void { this.focused++; }
  executeJavaScript(script: string): Promise<unknown> { this.scripts.push(script); return Promise.resolve(undefined); }
  getURL(): string { return this.url; }
  getType(): string { return this.hostWebContents ? "webview" : "window"; }
  send(...args: unknown[]): void { this.sent.push(args); }
  close(): void { this.destroyed = true; }
}
const active: ArtifactGuestBroker[] = [];
afterEach(async () => { for (const broker of active.splice(0)) await broker.dispose(); vi.useRealTimers(); });
async function fixture() {
  const root = new Contents();
  let invalidate: (event: { epoch: number; artifactIds?: string[]; kind: string }) => void = () => {};
  const service: ArtifactSurfaceService = {
    resolveSurface: vi.fn<ArtifactSurfaceService["resolveSurface"]>(async (source) => ({ binding: { epoch: 1, ownerInstanceId: SOURCE.artifactId, source, ...SOURCE }, html: "<p>trusted</p>", managed: true, readOnly: false, stateRevision: 0, state: { done: false }, datasets: { rows: { value: [1, 2], provenance: { source: { kind: "manual", label: "Fixture" }, method: { kind: "manual", description: "Test rows" }, recordedAt: "2026-11-09T00:00:00Z", captureSessionId: null, captureToolCallId: null, trust: "agent-reported", refresh: { kind: "none", requiredSources: [] } } } } })),
    assertBoundSurface: vi.fn<ArtifactSurfaceService["assertBoundSurface"]>(() => undefined),
    saveBoundState: vi.fn<ArtifactSurfaceService["saveBoundState"]>((_binding, patch, authorize) => { authorize(); return { stateRevision: patch.expectedStateRevision + 1, dataSnapshotId: "44444444-4444-4444-8444-444444444444" }; }),
    onSurfaceInvalidated: (listener) => { invalidate = listener; return vi.fn(); },
  };
  const broker = new ArtifactGuestBroker({ root: root as unknown as WebContents, service: () => service, preloadPath: "/packaged/preload/artifact-runtime.js" });
  active.push(broker);
  const surface = await broker.prepareSurface(SOURCE, THEME);
  const admitted = broker.admit({ src: surface.url, partition: surface.partition });
  const guest = new Contents();
  guest.hostWebContents = root;
  guest.preferences = admitted ?? {};
  guest.url = surface.url;
  guest.mainFrame.url = surface.url;
  const event = { sender: guest, senderFrame: guest.mainFrame } as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, args: unknown[] = [], from = event) => electron.handlers.get(channel)!(from, ...args);
  const ticket = admitted!.additionalArguments[0].slice("--omp-artifact-surface=".length);
  await invoke("artifact-runtime:hello", [ticket]);
  return { root, guest, broker, service, surface, invoke, event, ticket, invalidate: (kind = "changed", ids = [SOURCE.artifactId]) => invalidate({ epoch: 1, artifactIds: ids, kind }) };
}

describe("artifact guest broker authority", () => {
  it("loads only a bound guest main frame and emits postcommit receipts", async () => {
    const f = await fixture();
    expect(await f.invoke("artifact-runtime:load")).toMatchObject({ stateRevision: 0, state: { done: false }, readOnly: false });
    expect(await f.invoke("artifact-runtime:save-state", [{ expectedStateRevision: 0, set: { done: true } }])).toMatchObject({ stateRevision: 1 });
    expect(f.root.sent.filter((row) => row[0] === "artifact-host:surface-notice").map((row) => {
      const notice = row[1];
      return notice && typeof notice === "object" && "reason" in notice ? notice.reason : null;
    })).toEqual(["saving", "saved"]);
    expect(await f.invoke("artifact-runtime:load")).toMatchObject({ state: { done: true }, stateRevision: 1 });
  });
  it("refuses root, subframe, altered document and foreign host authority", async () => {
    const f = await fixture();
    await expect(f.invoke("artifact-runtime:load", [], { sender: f.root, senderFrame: f.root.mainFrame } as unknown as IpcMainInvokeEvent)).rejects.toThrow();
    await expect(f.invoke("artifact-runtime:load", [], { sender: f.guest, senderFrame: { url: f.surface.url } } as unknown as IpcMainInvokeEvent)).rejects.toThrow();
    f.guest.mainFrame.url += "#other";
    await expect(f.invoke("artifact-runtime:load")).rejects.toThrow();
    f.guest.mainFrame.url = f.surface.url;
    f.guest.hostWebContents = new Contents();
    await expect(f.invoke("artifact-runtime:load")).rejects.toThrow();
  });
  it("permits only the reserved height URL suffix", async () => {
    const f = await fixture();
    f.guest.url += "#omph423";
    f.guest.mainFrame.url = f.guest.url;
    expect(await f.invoke("artifact-runtime:load")).toMatchObject({ stateRevision: 0 });
    expect(artifactDocumentIdentity(`${f.surface.url}#arbitrary`)).not.toBe(f.surface.url);
  });
  it("consumes the attach and hello ticket once and refuses expiration", async () => {
    const f = await fixture();
    expect(f.broker.admit({ src: f.surface.url, partition: f.surface.partition })).toBeNull();
    await expect(f.invoke("artifact-runtime:hello", [f.ticket])).rejects.toThrow();
    vi.useFakeTimers();
    const pending = await f.broker.prepareSurface(SOURCE, THEME);
    vi.advanceTimersByTime(30_001);
    expect(f.broker.admit({ src: pending.url, partition: pending.partition })).toBeNull();
  });
  it("makes the second viewer read-only", async () => {
    const f = await fixture();
    expect(await f.broker.prepareSurface(SOURCE, THEME)).toMatchObject({ readOnly: true });
  });
  it("reserves one draft writer and ignores unrelated artifact mutations", async () => {
    const f = await fixture();
    const source = { draftId: "55555555-5555-4555-8555-555555555555" };
    expect(await f.broker.prepareSurface(source, THEME)).toMatchObject({ readOnly: false });
    expect(await f.broker.prepareSurface(source, THEME)).toMatchObject({ readOnly: true });
    f.invalidate("changed", []);
    expect(await f.invoke("artifact-runtime:load")).toMatchObject({ stateRevision: 0 });
  });
  it("fences outstanding preparation on root document replacement and permits crash recovery", async () => {
    const f = await fixture();
    const resolved = await f.service.resolveSurface(SOURCE);
    const gate = Promise.withResolvers<ArtifactSurfaceResolution>();
    vi.mocked(f.service.resolveSurface).mockImplementationOnce(() => gate.promise);
    const preparing = f.broker.prepareSurface(SOURCE, THEME);
    f.root.emit("did-start-navigation", {}, "file:///next.html", false, true);
    gate.resolve(resolved);
    await expect(preparing).rejects.toThrow("root");
    await expect(f.invoke("artifact-runtime:load")).rejects.toThrow();
    f.root.emit("render-process-gone", {}, {});
    expect(await f.broker.prepareSurface(SOURCE, THEME)).toMatchObject({ readOnly: false });
  });
  it("keeps main-process rate and inflight admission bounded with recovery", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    vi.mocked(f.service.assertBoundSurface).mockImplementation(() => gate.promise);
    const pending = Array.from({ length: 8 }, () => f.invoke("artifact-runtime:load"));
    await expect(f.invoke("artifact-runtime:load")).rejects.toThrow("rate limit");
    gate.resolve(); await Promise.all(pending);
    vi.advanceTimersByTime(1001);
    await expect(f.invoke("artifact-runtime:save-state", [{ expectedStateRevision: 0, set: { recovered: true } }])).resolves.toMatchObject({ stateRevision: 1 });
  });
  it("revokes external head and disabled writes without swapping visible data", async () => {
    const f = await fixture();
    f.invalidate("disabled");
    await expect(f.invoke("artifact-runtime:save-state", [{ expectedStateRevision: 0, set: { done: true } }])).rejects.toThrow();
    expect(f.service.saveBoundState).not.toHaveBeenCalled();
    expect(f.root.sent.at(-1)).toMatchObject(["artifact-host:surface-notice", { reason: "disabled", reloadRequired: true }]);
  });
  it("never announces Saved after transaction failure or a stale CAS", async () => {
    const f = await fixture();
    vi.mocked(f.service.saveBoundState).mockImplementation(() => { throw new Error("disk full"); });
    await expect(f.invoke("artifact-runtime:save-state", [{ expectedStateRevision: 0, set: { done: true } }])).rejects.toThrow("disk full");
    expect(f.root.sent.at(-1)).toMatchObject(["artifact-host:surface-notice", { reason: "not-saved" }]);
    await expect(f.invoke("artifact-runtime:save-state", [{ expectedStateRevision: 99, set: {} }])).rejects.toThrow("conflict");
    expect(await f.invoke("artifact-runtime:load")).toMatchObject({ stateRevision: 0 });
  });
  it("reclaims host WebContents focus when the guest presses Escape (#1130)", async () => {
    const f = await fixture();
    f.guest.emit("before-input-event", {}, { type: "keyDown", key: "a" });
    expect(f.root.focused).toBe(0);
    f.guest.emit("before-input-event", {}, { type: "keyUp", key: "Escape" });
    expect(f.root.focused).toBe(0);
    f.guest.emit("before-input-event", {}, { type: "keyDown", key: "Escape" });
    // Native focus lives on the host frame's focused <webview> element; the reclaim must blur it there.
    expect(f.root.scripts.join("\n")).toContain("tagName==='WEBVIEW'");
    expect(f.root.scripts.join("\n")).toContain("a.blur()");
    // Reactivation is chained after the blur: Chromium restores focus to the last-focused element, so focus only lands once the guest element released it. The fake's promise resolves immediately, so one microtask flush covers it deterministically.
    await Promise.resolve();
    expect(f.root.focused).toBe(1);
    expect(f.root.sent.at(-1)).toMatchObject(["artifact-host:surface-notice", { reason: "escape", reloadRequired: false }]);
  });
  it("updates theme in place and drains accepted writes before release", async () => {
    const f = await fixture();
    const rootEvent = { sender: f.root, senderFrame: f.root.mainFrame } as unknown as IpcMainInvokeEvent;
    await f.invoke("artifact-host:update-theme", [f.surface.surfaceId, { dark: false, tokens: {} }], rootEvent);
    expect(f.guest.getURL()).toBe(f.surface.url);
    expect(f.guest.sent.at(-1)?.[0]).toBe("artifact-runtime:theme");
    let commit: (() => void) | undefined;
    vi.mocked(f.service.saveBoundState).mockImplementation((_binding, patch, authorize) => {
      const pending = Promise.withResolvers<{ stateRevision: number; dataSnapshotId: string }>();
      commit = () => { authorize(); pending.resolve({ stateRevision: patch.expectedStateRevision + 1, dataSnapshotId: SOURCE.dataSnapshotId }); };
      return pending.promise;
    });
    const write = f.invoke("artifact-runtime:save-state", [{ expectedStateRevision: 0, set: { done: true } }]);
    await Promise.resolve(); await Promise.resolve();
    const release = f.invoke("artifact-host:release-surface", [f.surface.surfaceId], rootEvent);
    commit!();
    await write; await release;
    await expect(f.invoke("artifact-runtime:load")).rejects.toThrow();
  });
});

describe("artifact bounded inputs", () => {
  it.each([NaN, Infinity, undefined, () => 1, new Date(), { constructor: 1 }, JSON.parse('{"__proto__":1}')])("rejects non JSON and dangerous values %s", (value) => {
    expect(() => validateArtifactPatch({ expectedStateRevision: 0, set: { value } })).toThrow();
  });
  it("refuses cycles, depth, size and unsafe CSS then permits a valid patch", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => validateArtifactPatch({ expectedStateRevision: 0, set: cycle })).toThrow();
    const sparse = Array(4);
    const extended = Object.assign([1], { extra: true });
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => { throw new Error("Accessor must not execute"); } });
    for (const value of [sparse, extended, accessor]) expect(() => validateArtifactPatch({ expectedStateRevision: 0, set: { value } })).toThrow();
    expect(() => validateArtifactPatch({ expectedStateRevision: 0, set: { text: "x".repeat(1024 * 1024) } })).toThrow();
    let deep: unknown = null; for (let i = 0; i < 65; i++) deep = [deep];
    expect(() => validateArtifactPatch({ expectedStateRevision: 0, set: { deep } })).toThrow();
    expect(() => artifactThemeCss({ dark: true, tokens: { "--color-ink": "red;}body{background:url(http://evil)" } })).toThrow();
    expect(() => artifactThemeCss({ dark: true, tokens: { "--color-ink": "url(//example.invalid/image)" } })).toThrow();
    expect(() => validateArtifactPatch({ expectedStateRevision: 0, set: { done: true }, remove: ["old"] })).not.toThrow();
  });
});
