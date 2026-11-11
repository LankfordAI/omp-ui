import { createHash, randomUUID } from "node:crypto";
import { ipcMain, session, type IpcMainInvokeEvent, type WebContents } from "electron";
import { composeHtmlArtifactDocument, HTML_ARTIFACT_PARTITION, htmlArtifactDataUrl, htmlArtifactThemeCss } from "@omp-ui/core";
import type { ArtifactPreparedSurface, ArtifactRuntimeDataset, ArtifactRuntimeJson, ArtifactRuntimeSnapshot, ArtifactStatePatch, ArtifactStateReceipt, ArtifactSurfaceNotice, ArtifactSurfaceSource, ArtifactSurfaceTheme } from "../artifact-runtime-protocol";
import type { ArtifactSurfaceBinding } from "./artifact-service";

export interface ArtifactSurfaceResolution {
  binding: ArtifactSurfaceBinding;
  html: string;
  managed: boolean;
  readOnly: boolean;
  scripts?: boolean;
  codeRevisionId?: string | null;
  dataSnapshotId?: string | null;
  stateRevision: number;
  state: Record<string, ArtifactRuntimeJson>;
  datasets: Record<string, ArtifactRuntimeDataset>;
}
export interface ArtifactSurfaceService {
  resolveSurface(source: ArtifactSurfaceSource): ArtifactSurfaceResolution | Promise<ArtifactSurfaceResolution>;
  assertBoundSurface(binding: ArtifactSurfaceBinding): unknown;
  saveBoundState(binding: ArtifactSurfaceBinding, patch: ArtifactStatePatch, authorize: () => void): Promise<ArtifactStateReceipt> | ArtifactStateReceipt;
  onSurfaceInvalidated(listener: (event: { epoch: number; artifactIds?: string[]; kind: string }) => void): () => void;
}
interface Surface {
  id: string;
  ticket: string;
  url: string;
  createdAt: number;
  rootEpoch: number;
  writerKey: string;
  consumed: boolean;
  binding: ArtifactSurfaceBinding;
  snapshot: ArtifactRuntimeSnapshot;
  managed: boolean;
  guest?: WebContents;
  hello: boolean;
  revoked: boolean;
  revokedReason?: "changed" | "disabled" | "released" | "crashed";
  closing: boolean;
  calls: number;
  rateAt: number;
  inFlight: number;
  writes: Set<Promise<unknown>>;
  themeCss: string;
  removeGuestListeners?: () => void;
}
const brokers = new Set<ArtifactGuestBroker>();
let ipcInstalled = false;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const forbidden = ["__proto__", "prototype", "constructor"];
const stateBytes = 1024 * 1024;
const patchBytes = 2 * stateBytes;

export function validateArtifactPatch(input: unknown): asserts input is ArtifactStatePatch {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (++nodes > patchBytes || depth > 64) throw new Error("Artifact JSON exceeds structural bounds");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      if (bytes > patchBytes) throw new Error("Artifact patch exceeds bounds");
      return;
    }
    if (!value || typeof value !== "object") throw new Error("Artifact state must be finite JSON");
    if (ancestors.has(value)) throw new Error("Artifact state cannot contain cycles");
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new Error("Artifact state must contain plain JSON objects");
    if (Array.isArray(value) && (proto !== Array.prototype || value.length > stateBytes || Reflect.ownKeys(value).length !== value.length + 1)) throw new Error("Artifact JSON cannot contain sparse or extended arrays");
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || forbidden.includes(key)) throw new Error("Artifact JSON contains a forbidden key");
      if (Array.isArray(value) && key === "length") continue;
      if (Array.isArray(value) && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new Error("Artifact JSON cannot contain extended arrays");
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !("value" in property) || !property.enumerable) throw new Error("Artifact JSON cannot contain accessors");
      if (!Array.isArray(value)) bytes += Buffer.byteLength(key);
      if (bytes > patchBytes) throw new Error("Artifact patch exceeds bounds");
      visit(property.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(input, 0);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid artifact patch");
  const patch = input as ArtifactStatePatch;
  if (Object.keys(input).some((key) => !["expectedStateRevision", "set", "remove"].includes(key)) ||
      !Number.isSafeInteger(patch.expectedStateRevision) || patch.expectedStateRevision < 0 ||
      !patch.set || typeof patch.set !== "object" || Array.isArray(patch.set) ||
      Object.keys(patch.set).some((key) => !keyPattern.test(key)) ||
      (patch.remove !== undefined && (!Array.isArray(patch.remove) || patch.remove.length > 4096 || patch.remove.some((key) => typeof key !== "string" || !keyPattern.test(key) || forbidden.includes(key))))) throw new Error("Invalid artifact patch");
  if (Buffer.byteLength(JSON.stringify(patch.set)) > stateBytes) throw new Error("Artifact state exceeds 1 MiB");
  if (Buffer.byteLength(JSON.stringify(input)) > patchBytes) throw new Error("Artifact patch exceeds bounds");
}

export function artifactDocumentIdentity(url: string): string {
  // Only the reserved auto-height suffix may differ. Arbitrary fragments are not authority.
  return url.replace(/#omph\d+$/, "");
}
function sourceArgument(input: unknown): ArtifactSurfaceSource {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid artifact source");
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "draftId" && keys !== "artifactId,codeRevisionId,dataSnapshotId") throw new Error("Invalid artifact source");
  if (Object.values(record).some((value) => typeof value !== "string" || !uuid.test(value))) throw new Error("Invalid artifact source ID");
  return input as ArtifactSurfaceSource;
}
export function artifactThemeCss(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid artifact theme");
  const theme = input as ArtifactSurfaceTheme;
  if (typeof theme.dark !== "boolean" || !theme.tokens || typeof theme.tokens !== "object" || Array.isArray(theme.tokens) || Object.keys(theme.tokens).length > 128 || Object.keys(input).some((key) => key !== "dark" && key !== "tokens")) throw new Error("Invalid artifact theme");
  for (const [name, value] of Object.entries(theme.tokens)) {
    if (!/^--[a-z][a-z0-9-]{0,63}$/.test(name) || typeof value !== "string" || value.length > 128 || !/^[#(),.%\s\dA-Za-z+/-]+$/.test(value) || /\burl\s*\(/i.test(value)) throw new Error("Invalid artifact theme token");
  }
  const css = htmlArtifactThemeCss(theme.tokens, theme.dark);
  if (Buffer.byteLength(css) > 16_384) throw new Error("Artifact theme exceeds bounds");
  return css;
}

/** Main-owned authority. Neither the source bytes nor a caller-supplied webContents ID is trusted. */
export class ArtifactGuestBroker {
  private readonly surfaces = new Map<string, Surface>();
  private readonly knownDocuments = new Set<string>();
  private readonly root: WebContents;
  readonly preloadPath: string;
  private readonly service: () => ArtifactSurfaceService;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  private draining = false;
  private rootEpoch = 0;
  private readonly timer: NodeJS.Timeout;
  private rootCalls = 0;
  private rootRateAt = 0;
  private readonly rootGone = (): void => { void this.dispose(); };
  private readonly rootCrashed = (): void => {
    this.rootEpoch++;
    for (const surface of this.surfaces.values()) {
      this.revoke(surface, "crashed");
      void this.release(surface.id);
    }
  };
  private readonly rootNavigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
    if (!mainFrame || inPlace) return;
    this.rootEpoch++;
    for (const surface of this.surfaces.values()) {
      this.revoke(surface, "released");
      void this.release(surface.id);
    }
  };
  constructor(options: { root: WebContents; service: () => ArtifactSurfaceService; preloadPath: string }) {
    this.root = options.root;
    this.service = options.service;
    this.preloadPath = options.preloadPath;
    brokers.add(this);
    this.root.on("destroyed", this.rootGone);
    this.root.on("render-process-gone", this.rootCrashed);
    this.root.on("did-start-navigation", this.rootNavigation);
    this.unsubscribe = this.service().onSurfaceInvalidated((event) => {
      for (const surface of this.surfaces.values()) {
        const sourceId = "draftId" in surface.binding.source ? surface.binding.source.draftId : surface.binding.artifactId;
        if (event.epoch !== surface.binding.epoch || (sourceId && event.artifactIds?.includes(sourceId))) {
          this.revoke(surface, event.kind === "disabled" ? "disabled" : "changed");
        }
      }
    });
    this.timer = setInterval(() => {
      for (const surface of this.surfaces.values()) {
        if (!surface.consumed && Date.now() - surface.createdAt > 30_000) void this.release(surface.id);
      }
    }, 5000);
    this.timer.unref();
    if (!ipcInstalled) {
      ipcInstalled = true;
      for (const channel of ["artifact-host:prepare-surface", "artifact-host:update-theme", "artifact-host:release-surface", "artifact-runtime:hello", "artifact-runtime:load", "artifact-runtime:save-state"]) {
        ipcMain.handle(channel, async (event, ...args: unknown[]) => {
          const broker = [...brokers].find((candidate) => candidate.owns(event.sender) ||
            (channel === "artifact-runtime:hello" && candidate.helloSurface(event, args) !== undefined));
          if (!broker) throw new Error("Artifact IPC sender is not authorized");
          return broker.dispatch(channel, event, args);
        });
      }
    }
  }
  private owns(sender: WebContents): boolean {
    return sender === this.root || [...this.surfaces.values()].some((surface) => surface.guest === sender);
  }
  private helloSurface(event: IpcMainInvokeEvent, args: unknown[]): Surface | undefined {
    const guest = event.sender;
    if (args.length !== 1 || typeof args[0] !== "string" || this.disposed || this.draining ||
        this.root.isDestroyed() || guest.isDestroyed() || guest.getType() !== "webview" ||
        !event.senderFrame || event.senderFrame !== guest.mainFrame || guest.hostWebContents !== this.root ||
        guest.session !== session.fromPartition(HTML_ARTIFACT_PARTITION)) return;
    return [...this.surfaces.values()].find(surface => surface.id === args[0] && surface.consumed &&
      !surface.guest && !surface.hello && !surface.revoked && !surface.closing &&
      surface.rootEpoch === this.rootEpoch && Date.now() - surface.createdAt <= 30_000 &&
      artifactDocumentIdentity(event.senderFrame!.url) === surface.url && artifactDocumentIdentity(guest.getURL()) === surface.url);
  }
  private assertRoot(event: IpcMainInvokeEvent): void {
    if (this.disposed || this.draining || this.root.isDestroyed() || event.sender !== this.root || !event.senderFrame || event.senderFrame !== this.root.mainFrame) throw new Error("Artifact host requires its root main frame");
  }
  private async dispatch(channel: string, event: IpcMainInvokeEvent, args: unknown[]): Promise<unknown> {
    if (channel.startsWith("artifact-host:")) {
      this.assertRoot(event);
      if (Date.now() - this.rootRateAt >= 1000) { this.rootRateAt = Date.now(); this.rootCalls = 0; }
      if (++this.rootCalls > 20) throw new Error("Artifact host rate limit exceeded");
      if (channel === "artifact-host:prepare-surface" && args.length === 2) return this.prepareSurface(sourceArgument(args[0]), args[1]);
      if (typeof args[0] !== "string" || !uuid.test(args[0])) throw new Error("Invalid artifact surface ID");
      if (channel === "artifact-host:update-theme" && args.length === 2) {
        const surface = this.surfaces.get(args[0]);
        if (!surface || surface.closing || surface.guest?.isDestroyed() || (surface.revoked && surface.revokedReason !== "changed")) throw new Error("Artifact surface is no longer active");
        surface.themeCss = artifactThemeCss(args[1]);
        surface.guest?.send("artifact-runtime:theme", surface.themeCss);
        return;
      }
      if (channel === "artifact-host:release-surface" && args.length === 1) return this.release(args[0]);
      throw new Error("Invalid artifact host request");
    }
    let surface = [...this.surfaces.values()].find((entry) => entry.guest === event.sender);
    if (surface === undefined && channel === "artifact-runtime:hello") {
      surface = this.helloSurface(event, args);
      if (surface !== undefined) this.bindGuest(surface, event.sender);
    }
    if (!surface) throw new Error("Artifact guest has no ticket binding");
    this.assertGuest(surface, event);
    if (Date.now() - surface.rateAt >= 1000) { surface.rateAt = Date.now(); surface.calls = 0; }
    if (++surface.calls > 20 || surface.inFlight >= 8) throw new Error("Artifact runtime rate limit exceeded");
    if (channel === "artifact-runtime:hello") {
      if (args.length !== 1 || args[0] !== surface.id || surface.hello || Date.now() - surface.createdAt > 30_000) throw new Error("Invalid or consumed artifact ticket");
      surface.hello = true;
      await this.service().assertBoundSurface(surface.binding);
      this.assertGuest(surface, event);
      return;
    }
    if (!surface.hello || !surface.managed) throw new Error("Artifact runtime is unavailable");
    surface.inFlight++;
    try {
      await this.service().assertBoundSurface(surface.binding);
      this.assertGuest(surface, event);
      if (channel === "artifact-runtime:load" && args.length === 0) return surface.snapshot;
      if (channel !== "artifact-runtime:save-state" || args.length !== 1) throw new Error("Invalid artifact runtime request");
      validateArtifactPatch(args[0]);
      if (surface.snapshot.readOnly) throw new Error("Artifact viewer is read-only");
      if (args[0].expectedStateRevision !== surface.snapshot.stateRevision) throw new Error("Artifact state revision conflict; reload required");
      this.notice(surface, { surfaceId: surface.id, reason: "saving", reloadRequired: false });
      const patch = args[0];
      const write = Promise.resolve().then(() => this.service().saveBoundState(surface.binding, patch, () => this.assertGuest(surface, event, true)));
      surface.writes.add(write);
      try {
        const receipt = await write;
        // Receipts are emitted only after the service's durable COMMIT succeeded.
        surface.snapshot.stateRevision = receipt.stateRevision;
        surface.snapshot.dataSnapshotId = receipt.dataSnapshotId;
        surface.binding.dataSnapshotId = receipt.dataSnapshotId;
        const state = { ...surface.snapshot.state };
        for (const key of patch.remove ?? []) delete state[key];
        Object.assign(state, patch.set);
        surface.snapshot.state = state;
        this.notice(surface, { surfaceId: surface.id, reason: "saved", reloadRequired: false, ...receipt });
        for (const broker of brokers) {
          for (const other of broker.surfaces.values()) {
            if (other !== surface && other.writerKey === surface.writerKey) broker.revoke(other, "changed");
          }
        }
        return receipt;
      } finally { surface.writes.delete(write); }
    } catch (error) {
      if (channel === "artifact-runtime:save-state" && !surface.revoked) this.notice(surface, { surfaceId: surface.id, reason: "not-saved", reloadRequired: false });
      if (error && typeof error === "object" && "code" in error && error.code === "conflict") this.revoke(surface, "changed");
      throw error;
    } finally { surface.inFlight--; }
  }
  private assertGuest(surface: Surface, event: IpcMainInvokeEvent, allowClosing = false): void {
    const guest = surface.guest;
    if (this.disposed || surface.revoked || surface.rootEpoch !== this.rootEpoch || (!allowClosing && surface.closing) || !guest || guest.isDestroyed() || this.root.isDestroyed() || event.sender !== guest || event.senderFrame !== guest.mainFrame || guest.hostWebContents !== this.root || guest.session !== session.fromPartition(HTML_ARTIFACT_PARTITION) || artifactDocumentIdentity(event.senderFrame.url) !== surface.url || artifactDocumentIdentity(guest.getURL()) !== surface.url || !surface.consumed) throw new Error("Artifact guest authority has been revoked");
  }
  async prepareSurface(source: ArtifactSurfaceSource, theme: unknown): Promise<ArtifactPreparedSurface> {
    if (this.disposed || this.draining || this.surfaces.size >= 32) throw new Error("Artifact surface limit exceeded");
    const rootEpoch = this.rootEpoch;
    const themeCss = artifactThemeCss(theme);
    const resolved = await this.service().resolveSurface(sourceArgument(source));
    if (!resolved.managed || resolved.scripts === false) throw new Error("Only script-enabled managed documents admit the artifact runtime");
    await this.service().assertBoundSurface(resolved.binding);
    if (this.disposed || this.draining || rootEpoch !== this.rootEpoch || this.surfaces.size >= 32) throw new Error("Artifact root is no longer active");
    if (Buffer.byteLength(resolved.html) > 512 * 1024) throw new Error("Artifact HTML exceeds bounds");
    const id = randomUUID();
    const ticket = randomUUID();
    const url = htmlArtifactDataUrl(composeHtmlArtifactDocument(`<meta name="omp-artifact-document" content="${ticket}">${resolved.html}`, themeCss, true));
    const writerKey = JSON.stringify([resolved.binding.ownerInstanceId, "draftId" in source ? "draft" : "artifact", "draftId" in source ? source.draftId : source.artifactId]);
    const writer = [...brokers].some((broker) => [...broker.surfaces.values()].some((surface) => surface.writerKey === writerKey && !surface.revoked && !surface.snapshot.readOnly));
    const snapshot: ArtifactRuntimeSnapshot = {
      codeRevisionId: resolved.codeRevisionId ?? resolved.binding.codeRevisionId ?? null,
      dataSnapshotId: resolved.dataSnapshotId ?? resolved.binding.dataSnapshotId ?? null,
      stateRevision: resolved.stateRevision,
      state: resolved.state,
      datasets: resolved.datasets,
      readOnly: resolved.readOnly || !resolved.managed || !!writer,
    };
    this.knownDocuments.add(createHash("sha256").update(url).digest("hex"));
    this.surfaces.set(id, { id, ticket, url, rootEpoch, writerKey, createdAt: Date.now(), consumed: false, binding: resolved.binding, snapshot, managed: true, hello: false, revoked: false, closing: false, calls: 0, rateAt: Date.now(), inFlight: 0, writes: new Set(), themeCss });
    return { surfaceId: id, url, partition: HTML_ARTIFACT_PARTITION, managed: resolved.managed, readOnly: snapshot.readOnly };
  }
  isSurfaceDocument(url: string): boolean {
    return this.knownDocuments.has(createHash("sha256").update(artifactDocumentIdentity(url)).digest("hex"));
  }
  /** Called only from the trusted host's will-attach-webview, after partition lockdown. */
  admit(params: Record<string, string>): { preload: string; additionalArguments: string[] } | null {
    const surface = [...this.surfaces.values()].find((entry) => entry.url === params.src);
    if (!surface || surface.consumed || surface.revoked || surface.closing || surface.rootEpoch !== this.rootEpoch || this.disposed || this.draining || Date.now() - surface.createdAt > 30_000 || params.partition !== HTML_ARTIFACT_PARTITION) return null;
    surface.consumed = true;
    return { preload: this.preloadPath, additionalArguments: [`--omp-artifact-surface=${surface.id}`] };
  }
  private bindGuest(surface: Surface, guest: WebContents): void {
    surface.guest = guest;
    const gone = (): void => { this.revoke(surface, "crashed"); surface.removeGuestListeners?.(); };
    let documentLoaded = false;
    const loaded = (): void => {
      documentLoaded = true;
      if (!surface.revoked) guest.send("artifact-runtime:theme", surface.themeCss);
    };
    const navigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
      if (documentLoaded && mainFrame && !inPlace) this.revoke(surface, "changed");
    };
    const onInput = (_event: unknown, input: {type: string; key: string}): void => {
      if (input.type === "keyDown" && input.key === "Escape") {
        this.notice(surface, {surfaceId: surface.id, reason: "escape", reloadRequired: false});
        // An out-of-process guest keeps native WebContents keyboard focus even
        // after the renderer collapses its overlay; only refocusing the host
        // root takes it back (#1130). `before-input-event` sees real user
        // input only, so guest JavaScript cannot fabricate this.
        if (!this.root.isDestroyed()) this.root.focus();
      }
    };
    guest.on("destroyed", gone);
    guest.on("render-process-gone", gone);
    guest.on("dom-ready", loaded);
    guest.on("did-start-navigation", navigated);
    guest.on("before-input-event", onInput);
    surface.removeGuestListeners = () => { guest.removeListener("destroyed", gone); guest.removeListener("render-process-gone", gone); guest.removeListener("dom-ready", loaded); guest.removeListener("did-start-navigation", navigated); guest.removeListener("before-input-event", onInput); };
  }
  private notice(_surface: Surface, notice: ArtifactSurfaceNotice): void {
    if (!this.root.isDestroyed()) this.root.send("artifact-host:surface-notice", notice);
  }
  private revoke(surface: Surface, reason: "changed" | "disabled" | "released" | "crashed"): void {
    if (surface.revoked && (reason !== "disabled" || surface.revokedReason === "disabled")) return;
    surface.revoked = true;
    surface.revokedReason = reason;
    surface.snapshot.readOnly = true;
    this.notice(surface, { surfaceId: surface.id, reason, reloadRequired: true });
  }
  private async release(id: string): Promise<void> {
    const surface = this.surfaces.get(id);
    if (!surface) return;
    surface.closing = true;
    await Promise.allSettled([...surface.writes]);
    this.revoke(surface, "released");
    surface.removeGuestListeners?.();
    this.surfaces.delete(id);
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.draining = true;
    // Drain already-admitted writes before invalidating authority and dropping bindings.
    for (const surface of this.surfaces.values()) surface.closing = true;
    await Promise.allSettled([...this.surfaces.values()].map((surface) => this.release(surface.id)));
    this.disposed = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root.removeListener("destroyed", this.rootGone);
    this.root.removeListener("render-process-gone", this.rootCrashed);
    this.root.removeListener("did-start-navigation", this.rootNavigation);
    brokers.delete(this);
  }
}
