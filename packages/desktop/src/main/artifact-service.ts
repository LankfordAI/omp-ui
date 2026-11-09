import * as path from "node:path";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import {
  ArtifactError, ArtifactStore, ARTIFACT_LIMITS, assertArtifactUuid,
  parseHtmlArtifactArgs, validateArtifactJson, normalizeArtifactAuthoringSpec, validateArtifactDatasets,
  type ArtifactJson, type ArtifactJsonObject, type ArtifactSource, type ArtifactDatasetInput, type ArtifactProvenance,
  type ManagedArtifactSpec, type ArtifactListRequest, type ArtifactDescribeRequest, type ArtifactOriginContext,
  type ArtifactReadRequest, type ArtifactKeepRequest, type ArtifactAcceptRevisionRequest,
  type ArtifactReferenceRequest, type ArtifactPrepareRefreshRequest, type ArtifactApplyCaptureRequest,
  type ArtifactDeleteRequest, type ArtifactResolveSourceRequest, type ArtifactLibraryChanged,
} from "@omp-ui/core";
import { parseArtifactReferenceUri, parseArtifactPromptReferences } from "@omp-ui/core";
import { artifactSourceHash, readHistoricalArtifactSource } from "./artifact-source";

import type { ArtifactCaptureOutcome } from "@omp-ui/core/artifacts";
export interface ArtifactTarget {
  ownerInstanceId: string; lineageDir: string; sessionId: string | null; runtimeKey: string | null; originContext?: ArtifactOriginContext;
  machine?: string; native?: boolean; artifactsAvailable?: boolean; artifactError?: string | null; archiveLineageDir?: string;
}
export interface ArtifactServiceOptions {
  registryFile: string; artifactsRoot?: string; ownerInstanceId(): string; enabled(): boolean;
  resolveTarget(tabId: string): ArtifactTarget | null;
  sourcePath(tabId: string): Promise<string | null>;
  scriptsEnabled?(): boolean;
  sourceTarget?(source: ArtifactSource): { tabId: string; sessionId: string | null; toolCallId: string | null } | null;
  sources?(): readonly { lineageDir: string; sessionId?: string | null }[];
  onChanged?(event: ArtifactLibraryChanged): void;
}
export type ArtifactSurfaceSource = { draftId: string } | { artifactId: string; codeRevisionId: string; dataSnapshotId: string };
export interface ArtifactSurfaceBinding {
  epoch: number; ownerInstanceId: string; source: ArtifactSurfaceSource;
  artifactId: string | null; codeRevisionId: string | null; dataSnapshotId: string | null;
}
export interface ArtifactSurfaceData {
  codeRevisionId: string | null; dataSnapshotId: string | null; stateRevision: number;
  state: ArtifactJsonObject; datasets: Record<string, { value: ArtifactJson; provenance: ArtifactProvenance }>;
}
export interface ArtifactResolvedSurface extends ArtifactSurfaceData {
  binding: ArtifactSurfaceBinding; html: string; managed: boolean; readOnly: boolean;
  scripts: boolean;
}
export interface ArtifactStatePatch { expectedStateRevision: number; set: ArtifactJsonObject; remove?: string[] }

/** The only owner of artifact persistence and grants. A disabled service never creates storage. */
export class ArtifactService {
  private store: ArtifactStore | null = null;
  private storeOwner: string | null = null;
  private gate: boolean;
  private revision = 0;
  private activeAuthorization: (() => void) | null = null;
  private cleaningSource = false;
  private closed = false;
  private readonly listeners = new Set<(event: ArtifactLibraryChanged) => void>();
  private readonly sourceReads = new Set<AbortController>();
  private readonly root: string;
  constructor(private readonly options: ArtifactServiceOptions) {
    this.gate = options.enabled();
    this.root = options.artifactsRoot ?? path.join(path.dirname(options.registryFile), "artifacts");
  }
  get epoch(): number { this.syncGate(); return this.revision; }
  get enabled(): boolean { this.syncGate(); return this.gate; }
  setEnabled(on: boolean): void {
    if (this.gate === on) return;
    this.gate = on; this.revision++;
    if (!on) { for (const read of this.sourceReads) read.abort(); this.sourceReads.clear(); }
    this.publish([], on ? "changed" : "disabled");
    if (!on && this.activeAuthorization === null && !this.cleaningSource) {
      this.store?.close(); this.store = null; this.storeOwner = null;
    }
  }
  private syncGate(): void { if (!this.closed) this.setEnabled(this.options.enabled()); }
  private assertEnabled(): void {
    if (this.closed) throw new ArtifactError("unavailable", "Artifact service is closed");
    this.syncGate();
    if (!this.gate) throw new ArtifactError("disabled", "Artifact library is disabled");
    if (this.storeOwner !== null && this.storeOwner !== this.options.ownerInstanceId()) {
      this.close(); throw new ArtifactError("unavailable", "Artifact owner changed");
    }
  }
  private storage(): ArtifactStore {
    this.assertEnabled();
    if (this.store === null) {
      this.storeOwner = this.options.ownerInstanceId();
      this.store = new ArtifactStore({ root: this.root, ownerInstanceId: this.storeOwner, authorize: () => {
        if (!this.cleaningSource) this.assertEnabled();
        if (this.options.ownerInstanceId() !== this.storeOwner) throw new ArtifactError("unavailable", "Artifact owner changed");
        this.activeAuthorization?.();
      } });
      if (this.options.sources !== undefined) {
        try { this.run(() => this.assertEnabled(), () => this.store!.reconcileSources({ lineageDirs: this.options.sources!().map(source => source.lineageDir) })); }
        catch (error) { this.store?.close(); this.store = null; this.storeOwner = null; throw error; }
      }
    }
    return this.store;
  }
  private target(tabId: string): ArtifactTarget {
    this.assertEnabled();
    const target = this.options.resolveTarget(tabId);
    if (target === null) throw new ArtifactError("unavailable", "An ordinary native session is required");
    if (target.ownerInstanceId !== this.options.ownerInstanceId()) throw new ArtifactError("unavailable", `Artifacts are unavailable on this machine${target.machine ? ` (${target.machine})` : ""}; select a session on the owning machine`);
    if (target.native !== true) throw new ArtifactError("unavailable", "An ordinary native session is required");
    return target;
  }
  private targetKey(target: ArtifactTarget): string {
    return JSON.stringify([target.ownerInstanceId, target.lineageDir, target.sessionId, target.runtimeKey]);
  }
  private authorizer(tabId: string, target: ArtifactTarget, epoch: number): () => void {
    const key = this.targetKey(target);
    return () => {
      this.assertEnabled();
      if (this.revision !== epoch || this.targetKey(this.target(tabId)) !== key) throw new ArtifactError("conflict", "Artifact source session changed");
    };
  }
  private run<T>(authorize: () => void, action: () => T): T {
    authorize();
    const previous = this.activeAuthorization; this.activeAuthorization = authorize;
    try { return action(); } finally {
      this.activeAuthorization = previous;
      if (!this.gate && previous === null && !this.cleaningSource) { this.store?.close(); this.store = null; this.storeOwner = null; }
    }
  }
  private humanMutation<T>(action: (store: ArtifactStore) => T): T {
    const store = this.storage(); const epoch = this.revision; const owner = this.options.ownerInstanceId();
    return this.run(() => {
      this.assertEnabled();
      if (this.revision !== epoch || this.options.ownerInstanceId() !== owner) throw new ArtifactError("conflict", "Artifact authority changed");
    }, () => action(store));
  }
  private source(target: ArtifactTarget, toolCallId: string | null, args: unknown, createdAt = new Date().toISOString()): ArtifactSource {
    return { ownerInstanceId: target.ownerInstanceId, lineageDir: target.lineageDir, sessionId: target.sessionId,
      runtimeKey: target.runtimeKey, toolCallId, sourceHash: artifactSourceHash(args), createdAt };
  }
  private datasets(raw: unknown, source: ArtifactSource): ArtifactDatasetInput[] {
    validateArtifactJson(raw);
    if (!Array.isArray(raw)) throw new ArtifactError("unsupported-contract", "datasets must be an array");
    const datasets = raw.map((entry) => {
      if (entry === null || Array.isArray(entry) || typeof entry !== "object") throw new ArtifactError("unsupported-contract", "Invalid dataset");
      const provenance = entry.provenance;
      if (provenance === null || Array.isArray(provenance) || typeof provenance !== "object") throw new ArtifactError("unsupported-contract", "Dataset provenance is required");
      return { ...entry, provenance: { ...provenance, recordedAt: source.createdAt, captureSessionId: source.sessionId,
        captureToolCallId: source.toolCallId, trust: "agent-reported" } };
    });
    validateArtifactDatasets(datasets);
    return datasets;
  }
  stageRender(request: { tabId: string; toolCallId: string | null; args: unknown }) {
    const target = this.target(request.tabId); const epoch = this.epoch;
    if (target.artifactsAvailable === false && request.args !== null && typeof request.args === "object" && "artifact" in request.args) throw new ArtifactError("unavailable", target.artifactError ?? "Artifact host tool registration is unavailable");
    const parsed = parseHtmlArtifactArgs(request.args);
    if (!parsed.ok) throw new ArtifactError("unsupported-contract", parsed.reason);
    const source = this.source(target, request.toolCallId, request.args);
    return this.stageDocument(request.tabId, target, epoch, request.args, source);
  }
  private stageDocument(tabId: string, target: ArtifactTarget, epoch: number, args: unknown, source: ArtifactSource) {
    const originContext = target.originContext;
    if (originContext === undefined) throw new ArtifactError("source-missing", "Owning session origin is unavailable");
    const parsed = parseHtmlArtifactArgs(args);
    if (!parsed.ok) throw new ArtifactError("unsupported-contract", parsed.reason);
    const raw = args as Record<string, unknown>;
    for (const key of Object.keys(raw)) if (!["title", "html", "height", "artifact"].includes(key)) throw new ArtifactError("unsupported-contract", `Unknown render field: ${key}`);
    let managed: ManagedArtifactSpec | undefined;
    if (raw.artifact !== undefined) {
      managed = normalizeArtifactAuthoringSpec(raw.artifact, { recordedAt: source.createdAt,
        captureSessionId: source.sessionId, captureToolCallId: source.toolCallId });
      if (managed.basedOn !== undefined) this.requireGrant(target, managed.basedOn.referenceId);
    }
    if (target.sessionId !== null && target.runtimeKey !== null) this.run(this.authorizer(tabId, target, epoch), () => this.storage().adoptSourceSession({ lineageDir: target.lineageDir, runtimeKey: target.runtimeKey!, sessionId: target.sessionId! }));
    const draft = this.run(this.authorizer(tabId, target, epoch), () => this.storage().stageDocument({ title: parsed.args.title, html: parsed.args.html, source, originContext, ...(managed ? { managed } : {}) }));
    this.publish([], "changed");
    return draft;
  }
  stageCapture(request: { tabId: string; toolCallId: string | null; args: unknown }): ArtifactCaptureOutcome {
    const target = this.target(request.tabId); const epoch = this.epoch;
    if (target.artifactsAvailable === false || target.runtimeKey === null) throw new ArtifactError("unavailable", target.artifactError ?? "Artifact host tool registration is unavailable");
    validateArtifactJson(request.args);
    if (request.args === null || Array.isArray(request.args) || typeof request.args !== "object") throw new ArtifactError("unsupported-contract", "Invalid capture");
    const args = request.args;
    if (args.status !== "captured" && args.status !== "failed") throw new ArtifactError("unsupported-contract", "Capture status must be captured or failed");
    const keys = args.status === "captured" ? ["refreshRequestId", "status", "datasets"] : ["refreshRequestId", "status", "message"];
    if (Object.keys(args).some(key => !keys.includes(key))) throw new ArtifactError("unsupported-contract", "Unexpected capture field");
    const refreshRequestId = args.refreshRequestId;
    assertArtifactUuid(refreshRequestId, "refreshRequestId");
    const refresh = this.storage().readRefresh({ refreshRequestId });
    this.requireGrant(target, refresh.referenceId);
    const source = this.source(target, request.toolCallId, args);
    const destination = {refreshRequestId, targetTabId: request.tabId, sessionId: target.sessionId, lineageDir: target.lineageDir, runtimeKey: target.runtimeKey, source};
    if (args.status === "failed") {
      if (typeof args.message !== "string") throw new ArtifactError("unsupported-contract", "Capture failure requires a message");
      const message = args.message;
      const failed = this.run(this.authorizer(request.tabId, target, epoch), () => this.storage().failRefresh({...destination, message}));
      this.options.onChanged?.({epoch: this.revision, artifactIds: [failed.artifactId], kind: "changed"});
      return {status: "failed", refreshRequestId, artifactId: failed.artifactId, message};
    }
    const capture = this.run(this.authorizer(request.tabId, target, epoch), () => this.storage().stageCapture({...destination, datasets: this.datasets(args.datasets, source)}));
    this.options.onChanged?.({ epoch: this.revision, artifactIds: [capture.artifactId], kind: "changed" });
    return {...capture, status: "captured"};
  }
  async resolveSource(request: ArtifactResolveSourceRequest) {
    const target = this.target(request.tabId); const epoch = this.epoch;
    const authorize = this.authorizer(request.tabId, target, epoch);
    if (request.sessionId !== target.sessionId && !(request.sessionId === null && request.draftId !== undefined && target.runtimeKey !== null)) throw new ArtifactError("source-missing", "Source session does not match the owning tab");
    if (target.sessionId !== null && target.runtimeKey !== null) this.run(authorize, () => this.storage().adoptSourceSession({ lineageDir: target.lineageDir, runtimeKey: target.runtimeKey!, sessionId: target.sessionId! }));
    const source = { ...this.source(target, request.toolCallId, {}), sourceHash: request.sourceHash };
    if (request.draftId !== undefined) {
      const actual = this.storage().readSource({ draftId: request.draftId });
      if (request.sessionId === null && actual.runtimeKey !== target.runtimeKey) throw new ArtifactError("source-missing", "Draft runtime identity changed");
      if (actual.ownerInstanceId !== source.ownerInstanceId || actual.lineageDir !== source.lineageDir || actual.sessionId !== source.sessionId
        || (actual.sessionId === null && actual.runtimeKey !== source.runtimeKey) || (actual.toolCallId !== null && actual.toolCallId !== source.toolCallId) || actual.sourceHash !== source.sourceHash) {
        throw new ArtifactError("source-missing", "Draft identity does not match the native source");
      }
      authorize(); return this.storage().lookupSource({source: actual, draftId: request.draftId});
    }
    const known = this.storage().lookupSource({ source });
    if (known.status !== "missing") return known;
    if (target.sessionId === null || request.toolCallId === null) throw new ArtifactError("source-missing", "Historical source requires the native session and tool call IDs");
    const file = await this.options.sourcePath(request.tabId); authorize();
    if (file === null) throw new ArtifactError("source-missing", "Saved source session is unavailable");
    const resolvedFile = await realpath(file).catch(() => { throw new ArtifactError("source-missing", "Saved source session is unavailable"); });
    const roots = [target.lineageDir, target.archiveLineageDir].filter((root): root is string => root !== undefined);
    let confined = false;
    for (const root of roots) {
      try {
        const resolvedRoot = await realpath(root);
        const relative = path.relative(resolvedRoot, resolvedFile);
        if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) confined = true;
      } catch { /* An inactive lineage may exist only in the archive. */ }
    }
    if (!confined) throw new ArtifactError("source-missing", "Saved source escaped its owning lineage");
    authorize();
    const cancellation = new AbortController(); this.sourceReads.add(cancellation);
    let historical: { args: unknown; timestamp: string | null };
    try {
      historical = await readHistoricalArtifactSource({ file, sessionId: target.sessionId, toolCallId: request.toolCallId, sourceHash: request.sourceHash, signal: cancellation.signal });
    } catch (error) {
      authorize();
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError("source-missing", "Saved artifact source could not be read");
    } finally { this.sourceReads.delete(cancellation); }
    authorize();
    const draft = this.stageDocument(request.tabId, target, epoch, historical.args, { ...source, createdAt: historical.timestamp ?? source.createdAt });
    return this.storage().lookupSource({ source: draft.source });
  }
  list(request: ArtifactListRequest = {}) { return this.storage().list(request); }
  describe(request: ArtifactDescribeRequest) {
    const description = this.storage().describe(request);
    return {...description, sourceTarget: this.options.sourceTarget?.(description.code.source) ?? null,
      candidates: description.candidates.map(candidate => ({...candidate, sourceTarget: this.options.sourceTarget?.(candidate.draft.source) ?? null}))};
  }
  readPart(request: ArtifactReadRequest) {
    return this.storage().readPart(request);
  }
  keep(request: ArtifactKeepRequest) { const value = this.humanMutation(store => store.keepDraft(request)); this.publish([value.artifactId, request.draftId], "changed"); return value; }
  acceptRevision(request: ArtifactAcceptRevisionRequest) { const value = this.humanMutation(store => store.acceptRevision(request)); this.publish([value.artifactId, request.draftId], "changed"); return value; }
  reference(request: ArtifactReferenceRequest) { this.target(request.targetTabId); return this.humanMutation(store => store.createReference(request)); }
  prepareRefresh(request: Omit<ArtifactPrepareRefreshRequest, "sessionId" | "includeData">) {
    this.target(request.targetTabId);
    const refresh = this.humanMutation(store => store.prepareRefresh({ ...request, includeData: true }));
    const reference = this.storage().readReference({ referenceId: refresh.referenceId });
    const text = `Refresh the requested datasets for this accepted artifact in this ordinary session. Read the reference manifest and exact provenance first; collect only datasets ${refresh.datasetIds.join(", ")} using their recorded recipes and report exact credential-free provenance. Stage results with omp-ui_artifact_capture; never apply or change code.\n\n<artifact refresh>\nrefresh-request: ${refresh.refreshRequestId}\n</artifact refresh>`;
    return { request: refresh, reference, text };
  }
  applyCapture(request: ArtifactApplyCaptureRequest) { const value = this.humanMutation(store => store.applyCapture(request)); this.publish([value.artifactId], "changed"); return value; }
  discardDraft(request: { draftId: string }) { this.humanMutation(store => store.discardDraft(request)); this.publish([request.draftId], "changed"); }
  delete(request: ArtifactDeleteRequest) { this.humanMutation(store => store.deleteArtifact(request)); this.publish([request.artifactId], "deleted"); }
  private requireGrant(target: ArtifactTarget, referenceId: string): void {
    const reference = this.storage().readReference({ referenceId });
    if (reference.ownerInstanceId !== target.ownerInstanceId) throw new ArtifactError("unavailable", "Foreign artifact reference");
  }
  /** Preflight never binds a dormant destination; only actual send rails do. */
  admitPrompt(request: { tabId: string; text: string; bindRefresh?: boolean }): void {
    const references = parseArtifactPromptReferences(request.text);
    if (references.length === 0) return;
    const target = this.target(request.tabId); const epoch = this.epoch;
    const store = this.storage();
    const ids: string[] = [];
    for (const descriptor of references) {
      const actual = store.readReference({ referenceId: descriptor.referenceId });
      if (actual.ownerInstanceId !== target.ownerInstanceId || actual.ownerInstanceId !== descriptor.ownerInstanceId || actual.artifactId !== descriptor.artifactId
        || actual.codeRevisionId !== descriptor.codeRevisionId || actual.dataSnapshotId !== descriptor.dataSnapshotId
        || actual.includeData !== descriptor.includeData || actual.snapshotAt !== descriptor.snapshotAt
        || (actual.title.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").trim() || "Artifact") !== descriptor.title
        || (actual.machine.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").trim() || "Unknown machine") !== descriptor.machine) {
        throw new ArtifactError("unavailable", "Artifact reference descriptor does not match its immutable grant");
      }
      ids.push(actual.referenceId);
    }
    const refreshIds = [...request.text.matchAll(/(?:^|\n)<artifact refresh>\nrefresh-request: ([0-9a-f-]+)\n<\/artifact refresh>(?=\n|$)/g)].map(match => match[1]!);
    this.run(this.authorizer(request.tabId, target, epoch), () => {
      for (const refreshRequestId of refreshIds) {
        assertArtifactUuid(refreshRequestId);
        const refresh = store.readRefresh({ refreshRequestId });
        if (!ids.includes(refresh.referenceId) || refresh.targetTabId !== request.tabId ||
            (refresh.bound && (refresh.lineageDir !== target.lineageDir ||
              (refresh.sessionId !== null && refresh.sessionId !== target.sessionId))))
          throw new ArtifactError("unavailable", "Refresh must carry its exact data reference and destination");
        if (request.bindRefresh !== false) {
          if (target.runtimeKey === null) throw new ArtifactError("unavailable", "Refresh delivery requires its owning native runtime");
          store.bindRefresh({ refreshRequestId, targetTabId: request.tabId, lineageDir: target.lineageDir, runtimeKey: target.runtimeKey, sessionId: target.sessionId });
        }
      }
    });
  }
  readHostUri(request: { tabId: string; url: string }): string {
    const target = this.target(request.tabId); const parsed = parseArtifactReferenceUri(request.url);
    if (parsed === null) throw new ArtifactError("unsupported-contract", "Invalid artifact reference URI");
    this.requireGrant(target, parsed.referenceId);
    return JSON.stringify(this.storage().readReferencePart(parsed));
  }
  resolveSurface(source: ArtifactSurfaceSource): ArtifactResolvedSurface {
    const store = this.storage();
    const binding: ArtifactSurfaceBinding = { epoch: this.epoch, ownerInstanceId: this.options.ownerInstanceId(), source: { ...source },
      artifactId: "artifactId" in source ? source.artifactId : null, codeRevisionId: "codeRevisionId" in source ? source.codeRevisionId : null,
      dataSnapshotId: "dataSnapshotId" in source ? source.dataSnapshotId : null };
    if ("draftId" in source) {
      const draft = store.readDraft(source);
      binding.dataSnapshotId = draft.draft.draftStateId;
      return { binding, html: draft.html, scripts: this.options.scriptsEnabled?.() ?? false, managed: draft.managed !== undefined,
        readOnly: draft.managed === undefined || !(this.options.scriptsEnabled?.() ?? false), codeRevisionId: null, dataSnapshotId: draft.draft.draftStateId,
        stateRevision: draft.draft.stateRevision, state: draft.managed?.initialState ?? {}, datasets: Object.fromEntries((draft.managed?.datasets ?? []).map(item => [item.id, { value: item.value, provenance: item.provenance }])) };
    }
    const code = store.readCode(source); const record = store.describe({ artifactId: source.artifactId }).artifact;
    return { binding, html: code.html, scripts: this.options.scriptsEnabled?.() ?? false, managed: code.definition !== null,
      readOnly: !(this.options.scriptsEnabled?.() ?? false) || code.definition === null || record.currentCodeRevisionId !== source.codeRevisionId || record.currentDataSnapshotId !== source.dataSnapshotId,
      ...this.readBoundSurface(binding) };
  }
  private checkBinding(binding: ArtifactSurfaceBinding): void {
    this.assertEnabled();
    if (binding.epoch !== this.revision || binding.ownerInstanceId !== this.options.ownerInstanceId()) throw new ArtifactError("conflict", "Artifact surface was revoked");
  }
  assertBoundSurface(binding: ArtifactSurfaceBinding): void {
    this.checkBinding(binding);
    this.storage().assertSurface("draftId" in binding.source ? binding.source : {
      artifactId: binding.artifactId!, codeRevisionId: binding.codeRevisionId!, dataSnapshotId: binding.dataSnapshotId!,
    });
  }
  readBoundSurface(binding: ArtifactSurfaceBinding): ArtifactSurfaceData {
    this.checkBinding(binding); const store = this.storage();
    if ("draftId" in binding.source) {
      const draft = store.readDraft(binding.source);
      if (binding.dataSnapshotId !== draft.draft.draftStateId) throw new ArtifactError("conflict", "Draft state changed; reload required");
      return { codeRevisionId: null, dataSnapshotId: draft.draft.draftStateId, stateRevision: draft.draft.stateRevision, state: draft.managed?.initialState ?? {}, datasets: Object.fromEntries((draft.managed?.datasets ?? []).map(item => [item.id, { value: item.value, provenance: item.provenance }])) };
    }
    const artifactId = binding.artifactId!; store.readCode({ artifactId, codeRevisionId: binding.codeRevisionId! });
    const snapshot = store.readSnapshot({ artifactId, dataSnapshotId: binding.dataSnapshotId! });
    return { codeRevisionId: binding.codeRevisionId, dataSnapshotId: snapshot.dataSnapshotId, stateRevision: snapshot.stateRevision,
      state: snapshot.userState, datasets: Object.fromEntries(snapshot.datasets.map(item => [item.id, { value: item.value, provenance: item.provenance }])) };
  }
  saveBoundState(binding: ArtifactSurfaceBinding, patch: ArtifactStatePatch, authorize: () => void) {
    this.checkBinding(binding);
    if (!(this.options.scriptsEnabled?.() ?? false)) throw new ArtifactError("unavailable", "Artifact scripts are disabled");
    const rawPatch: unknown = patch;
    validateArtifactJson(rawPatch, 2 * ARTIFACT_LIMITS.stateBytes);
    for (const key of Object.keys(patch)) if (!["expectedStateRevision", "set", "remove"].includes(key)) throw new ArtifactError("unsupported-contract", "Unknown state patch field");
    if ("draftId" in binding.source) {
      const draftId = binding.source.draftId;
      const draft = this.run(() => { this.checkBinding(binding); authorize(); this.checkBinding(binding); }, () => this.storage().patchDraftState({ draftId, ...patch }));
      binding.dataSnapshotId = draft.draftStateId;
      this.options.onChanged?.({ epoch: this.revision, artifactIds: [], kind: "changed" });
      return { stateRevision: draft.stateRevision, dataSnapshotId: draft.draftStateId };
    }
    if (binding.artifactId === null || binding.codeRevisionId === null || binding.dataSnapshotId === null) throw new ArtifactError("unavailable", "Invalid accepted artifact binding");
    const value = this.run(() => { this.checkBinding(binding); authorize(); this.checkBinding(binding); }, () => this.storage().patchUserState({ artifactId: binding.artifactId!,
      expectedCodeRevisionId: binding.codeRevisionId!, expectedDataSnapshotId: binding.dataSnapshotId!, ...patch }));
    binding.dataSnapshotId = value.currentDataSnapshotId;
    // Broker revokes its other views; do not revoke the writer's own successful save.
    this.options.onChanged?.({ epoch: this.revision, artifactIds: [value.artifactId], kind: "changed" });
    return { stateRevision: patch.expectedStateRevision + 1, dataSnapshotId: value.currentDataSnapshotId };
  }
  onSurfaceInvalidated(listener: (event: ArtifactLibraryChanged) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  sourceExited(request: {lineageDir: string; runtimeKey: string}): void {
    if (!this.enabled || !existsSync(path.join(this.root, "library.sqlite"))) return;
    this.humanMutation(store => store.interruptRefreshes(request));
    this.options.onChanged?.({epoch: this.revision, artifactIds: [], kind: "changed"});
  }
  /** Only main's observed native session header may materialize a runtime-only source. */
  observeSource(request: { lineageDir: string; runtimeKey: string; sessionId: string }): void {
    if (!this.enabled || (this.store === null && !existsSync(path.join(this.root, "library.sqlite")))) return;
    this.humanMutation(store => store.adoptSourceSession(request));
    this.publish([], "changed");
  }

  private publish(artifactIds: string[], kind: ArtifactLibraryChanged["kind"]): void {
    const event = { epoch: this.revision, artifactIds, kind };
    this.options.onChanged?.(event); for (const listener of this.listeners) listener(event);
  }
  /** Must complete before deleting source records; failures deliberately propagate. */
  dropDraftsForLineage(lineageDir: string): void {
    if (this.store === null && !existsSync(path.join(this.root, "library.sqlite"))) return;
    const oldGate = this.gate;
    let removed: string[];
    this.cleaningSource = true;
    try {
      if (this.store === null) {
        this.storeOwner = this.options.ownerInstanceId();
        this.store = new ArtifactStore({root: this.root, ownerInstanceId: this.storeOwner, create: false, authorize: () => {
          if (!this.cleaningSource) this.assertEnabled();
          if (this.options.ownerInstanceId() !== this.storeOwner) throw new ArtifactError("unavailable", "Artifact owner changed");
          this.activeAuthorization?.();
        }});
      }
      removed = this.store.dropDraftsForLineage({lineageDir});
    } finally {
      this.cleaningSource = false;
      if (!this.gate) { this.store?.close(); this.store = null; this.storeOwner = null; }
    }
    if (oldGate) this.publish(removed, "changed");
  }
  close(): void {
    if (this.closed) return;
    for (const read of this.sourceReads) read.abort(); this.sourceReads.clear();
    this.closed = true; this.gate = false; this.revision++; this.publish([], "disabled");
    if (this.activeAuthorization === null && !this.cleaningSource) { this.store?.close(); this.store = null; this.storeOwner = null; }
  }
}
