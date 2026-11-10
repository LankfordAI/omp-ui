import { scanSecrets } from "./vault-secret-shapes";

/** Artifact library wire contracts. This module deliberately has no Node imports. */
export type ArtifactJson = null | boolean | number | string | ArtifactJson[] | { [key: string]: ArtifactJson };
export type ArtifactJsonObject = { [key: string]: ArtifactJson };
export type ArtifactErrorCode = "disabled" | "unavailable" | "conflict" | "unsupported-contract" | "over-limit" | "busy" | "source-missing";
export class ArtifactError extends Error {
  constructor(public readonly code: ArtifactErrorCode, message: string) { super(message); this.name = "ArtifactError"; }
}
export interface ArtifactFailure {ok: false; error: ArtifactErrorCode; message: string}
export type ArtifactResult<T> = { ok: true; value: T } | ArtifactFailure;
const failurePrefix = "OMP_UI_ARTIFACT_FAILURE_V1:";
const artifactErrorCodes: readonly ArtifactErrorCode[] = ["disabled", "unavailable", "conflict", "unsupported-contract", "over-limit", "busy", "source-missing"];

/** JSON rejection reasons survive contextBridge; custom Error properties do not. */
export function artifactFailure(error: unknown): ArtifactFailure | null {
  if (error instanceof ArtifactError) return {ok: false, error: error.code, message: error.message};
  let value: unknown = error;
  if (error instanceof Error || typeof error === "string") {
    const message = typeof error === "string" ? error : error.message;
    const at = message.indexOf(failurePrefix);
    if (at < 0) return null;
    try { value = JSON.parse(message.slice(at + failurePrefix.length)); } catch { return null; }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("ok" in value) || value.ok !== false ||
      !("error" in value) || !("message" in value) || typeof value.message !== "string") return null;
  const code = artifactErrorCodes.find(code => code === value.error);
  return code === undefined ? null : {ok: false, error: code, message: value.message};
}

/** Electron invoke serializes only the message; reconstruct a JSON status in clients. */
export function serializeArtifactFailure(error: unknown, fallback: ArtifactErrorCode = "unavailable"): Error {
  const failure = artifactFailure(error) ?? {ok: false, error: fallback, message: error instanceof Error ? error.message : String(error)};
  return new Error(failurePrefix + JSON.stringify(failure), {cause: error});
}
export const ARTIFACT_LIMITS = Object.freeze({ htmlBytes: 512 * 1024, titleChars: 200, stateBytes: 1024 * 1024, datasets: 32, datasetBytes: 8 * 1024 * 1024, activeDatasetBytes: 32 * 1024 * 1024, provenanceBytes: 16 * 1024, envelopeBytes: 40 * 1024 * 1024, depth: 64, artifactBytes: 256 * 1024 * 1024, libraryBytes: 1024 * 1024 * 1024 });
export interface ArtifactSource {
  ownerInstanceId: string; lineageDir: string; sessionId: string | null; runtimeKey: string | null; toolCallId: string | null; sourceHash: string; createdAt: string;
}
export interface ArtifactProvenance {
  source: { kind: "file" | "url" | "database" | "manual" | "derived"; label: string; locator?: string };
  method: { kind: "import" | "query" | "extract" | "manual" | "derive"; description: string; parameters?: ArtifactJsonObject };
  capturedAt?: string; recordedAt: string; captureSessionId: string | null; captureToolCallId: string | null;
  trust: "agent-reported" | "user-entered";
  refresh: { kind: "session" | "manual" | "none"; instructions?: string; requiredSources: string[] };
}
export interface ArtifactDatasetInput { id: string; title: string; schema: string; value: ArtifactJson; provenance: ArtifactProvenance }
export type ArtifactDatasetAuthoringInput = Omit<ArtifactDatasetInput, "value"> & (
  | { value: ArtifactJson; valueFile?: never }
  | { value?: never; valueFile: string }
);
export interface ManagedArtifactSpec { protocolVersion: 1; stateSchema: string; initialState: ArtifactJsonObject; datasets: ArtifactDatasetInput[]; basedOn?: { referenceId: string } }
export type ManagedArtifactAuthoringSpec = Omit<ManagedArtifactSpec, "datasets"> & { datasets: ArtifactDatasetAuthoringInput[] };
export interface ArtifactDatasetDefinition { id: string; title: string; schema: string }
export interface ArtifactDefinition { protocolVersion: 1; stateSchema: string; datasets: ArtifactDatasetDefinition[] }
export type ArtifactOriginContext = { kind: "project"; label: string; path: string } | { kind: "chat" };
export interface ArtifactDraft { draftId: string; title: string; source: ArtifactSource; originContext: ArtifactOriginContext; managed: boolean; basedOnReferenceId: string | null; createdAt: string; artifactId: string | null; stateRevision: number; draftStateId: string; previewDataSnapshotId: string | null }
export interface ArtifactRecord { artifactId: string; ownerInstanceId: string; title: string; managed: boolean; currentCodeRevisionId: string; currentDataSnapshotId: string; generation: number; keptAt: string; createdAt: string; updatedAt: string; origin: ArtifactSource; originContext: ArtifactOriginContext; sourceDraftId: string }
export interface ArtifactCodeRevision { codeRevisionId: string; artifactId: string; revisionNumber: number; baseRevisionId: string | null; html: string; definition: ArtifactDefinition | null; source: ArtifactSource; createdAt: string }
export interface ArtifactDatasetSnapshot extends ArtifactDatasetInput { head: string }
export interface ArtifactDataSnapshot { dataSnapshotId: string; artifactId: string; userState: ArtifactJsonObject; stateRevision: number; cause: "initial" | "user-edit" | "refresh"; datasets: ArtifactDatasetSnapshot[]; createdAt: string }
export interface ArtifactReference { version: 1; referenceId: string; ownerInstanceId: string; artifactId: string; codeRevisionId: string; dataSnapshotId: string; title: string; snapshotAt: string; includeData: boolean; machine: string; manifestUri: string; definitionUri: string; dataUri?: string; createdAt?: string }
export type DraftArtifactReference = ArtifactReference & { instanceId: string | null };
export interface ArtifactRefreshRequest { refreshRequestId: string; referenceId: string; artifactId: string; codeRevisionId: string; dataSnapshotId: string; datasetIds: string[]; expectedDatasetHeads: Record<string, string>; targetTabId: string; bound: boolean; lineageDir: string | null; runtimeKey: string | null; sessionId: string | null; createdAt: string; status: "awaiting" | "captured" | "failed" | "interrupted" | "applied"; failure?: {message: string; source: ArtifactSource; recordedAt: string} }
/** A refresh request riding the prompt wire as a leading block (ADR-0092). */
export interface ArtifactRefreshEntry { version: 1; refreshRequestId: string; artifactId: string; title: string; datasetIds: string[] }
export interface ArtifactCaptureDraft { captureId: string; refreshRequestId: string; artifactId: string; codeRevisionId: string; datasets: ArtifactDatasetInput[]; expectedDatasetHeads: Record<string, string>; source: ArtifactSource; createdAt: string }
export type ArtifactCaptureOutcome = (ArtifactCaptureDraft & {status: "captured"}) | {status: "failed"; refreshRequestId: string; artifactId: string; message: string};
export interface ArtifactListRequest { cursor?: string; limit?: number; query?: string }
export interface ArtifactListResult { artifacts: ArtifactRecord[]; nextCursor: string | null }
export interface ArtifactDescribeRequest { artifactId: string; codeRevisionId?: string; dataSnapshotId?: string }
export interface ArtifactCaptureDescription extends Omit<ArtifactCaptureDraft, "datasets"> { appliedDataSnapshotId: string | null; datasets: Array<ArtifactDatasetDefinition & { provenance: ArtifactProvenance; valueBytes: number; currentValueBytes: number }> }
export interface ArtifactCandidateDescription {draft: ArtifactDraft; definition: ArtifactDefinition | null; compatible: boolean; stale: boolean; expectedCodeRevisionId: string; sourceTarget?: {tabId: string; sessionId: string | null; toolCallId: string | null} | null}
export interface ArtifactDescription { artifact: ArtifactRecord; code: Omit<ArtifactCodeRevision, "html">; snapshot: Omit<ArtifactDataSnapshot, "userState" | "datasets"> & { datasets: Array<ArtifactDatasetDefinition & { head: string; provenance: ArtifactProvenance }> }; revisions: Array<Omit<ArtifactCodeRevision, "html" | "definition">>; snapshots: Array<Pick<ArtifactDataSnapshot, "dataSnapshotId" | "createdAt">>; references: ArtifactReference[]; captures: ArtifactCaptureDescription[]; refreshRequests: ArtifactRefreshRequest[]; candidates: ArtifactCandidateDescription[]; sourceTarget?: { tabId: string; sessionId: string | null; toolCallId: string | null } | null }
export interface ArtifactStageDocumentRequest { title: string; html: string; source: ArtifactSource; originContext: ArtifactOriginContext; managed?: ManagedArtifactSpec }
export type ArtifactSourceLookup = { status: "draft"; draft: ArtifactDraft; candidate?: { expectedCodeRevisionId: string; compatible: boolean; stale: boolean; definition: ArtifactDefinition | null } } | { status: "kept"; artifact: ArtifactRecord } | { status: "deleted"; artifactId: string } | { status: "missing" };
export interface ArtifactKeepRequest { draftId: string; title: string }
export interface ArtifactAcceptRevisionRequest { draftId: string; expectedCodeRevisionId: string }
export interface ArtifactReadRequest { artifactId: string; codeRevisionId: string; dataSnapshotId: string; part: "definition" | "state" | "dataset"; datasetId?: string; captureId?: string; offset?: number; limit?: number }
export interface ArtifactPatchUserStateRequest { artifactId: string; expectedCodeRevisionId: string; expectedDataSnapshotId: string; expectedStateRevision: number; set: ArtifactJsonObject; remove?: string[] }
export interface ArtifactPatchDraftStateRequest { draftId: string; expectedStateRevision: number; set: ArtifactJsonObject; remove?: string[] }
export interface ArtifactCreateReferenceRequest { artifactId: string; codeRevisionId: string; dataSnapshotId: string; includeData: boolean }
export interface ArtifactReferencePartRequest { referenceId: string; part: "manifest" | "definition" | "state" | "dataset" | "provenance"; datasetId?: string; offset?: number; limit?: number }
export interface ArtifactPartResult { version: 1; referenceId: string; part: ArtifactReferencePartRequest["part"]; datasetId?: string; offset: number; nextOffset: number | null; totalBytes: number; encoding: "utf-8"; text: string }
export interface ArtifactPrepareRefreshRequest extends Omit<ArtifactCreateReferenceRequest, "includeData"> { targetTabId: string; includeData?: boolean; datasetIds: string[] }
export interface ArtifactStageCaptureRequest { refreshRequestId: string; targetTabId: string; lineageDir: string; runtimeKey: string | null; sessionId: string | null; source: ArtifactSource; datasets: ArtifactDatasetInput[] }
export interface ArtifactApplyCaptureRequest { captureId: string; expectedCodeRevisionId: string; expectedDatasetHeads: Record<string, string> }
export interface ArtifactDeleteRequest { artifactId: string; expectedGeneration: number }
export interface ArtifactLibraryChanged { epoch: number; artifactIds: string[]; kind: "changed" | "deleted" | "disabled" }
export interface ArtifactResolveSourceRequest { tabId: string; sessionId: string | null; toolCallId: string | null; sourceHash: string; draftId?: string }
export interface ArtifactReferenceRequest extends ArtifactCreateReferenceRequest { targetTabId: string }

const encoder = new TextEncoder();
export function artifactUtf8Bytes(value: string): number { return encoder.encode(value).byteLength; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function assertArtifactUuid(value: unknown, label = "id"): asserts value is string { if (typeof value !== "string" || !UUID.test(value)) throw new ArtifactError("unsupported-contract", `${label} must be a UUID`); }
export function assertArtifactKey(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) throw new ArtifactError("unsupported-contract", "Invalid dataset key"); }
function fail(message: string): never { throw new ArtifactError("unsupported-contract", message); }
export function validateArtifactJson(value: unknown, maxBytes = ARTIFACT_LIMITS.envelopeBytes): asserts value is ArtifactJson {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > ARTIFACT_LIMITS.depth) throw new ArtifactError("over-limit", "JSON exceeds maximum depth");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) fail("JSON numbers must be finite"); return; }
    if (typeof item !== "object") fail("Only JSON values are accepted");
    if (seen.has(item)) fail("Cyclic JSON is not accepted");
    seen.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) fail("Only plain arrays are accepted");
      if (Reflect.ownKeys(item).length !== item.length + 1) fail("Array properties are not JSON");
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, i);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("Sparse arrays and accessors are not JSON");
        visit(descriptor.value, depth + 1);
      }
    }
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail("Only plain JSON objects are accepted");
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) fail("Unsafe JSON key");
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !("value" in descriptor)) fail("JSON accessors are not accepted");
        visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (artifactUtf8Bytes(JSON.stringify(value)) > maxBytes) throw new ArtifactError("over-limit", "JSON exceeds byte limit");
}
function object(value: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  validateArtifactJson(value);
  if (value === null || Array.isArray(value) || typeof value !== "object") fail("Expected an object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`Unknown field: ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`Missing field: ${key}`);
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 4096): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > max) fail("Invalid text field"); }
function date(value: unknown): void { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail("Invalid timestamp"); }
export function validateArtifactSource(value: unknown): asserts value is ArtifactSource {
  const v = object(value, ["ownerInstanceId", "lineageDir", "sessionId", "runtimeKey", "toolCallId", "sourceHash", "createdAt"]);
  assertArtifactUuid(v.ownerInstanceId); string(v.lineageDir); date(v.createdAt);
  for (const key of ["sessionId", "runtimeKey"]) if (v[key] !== null) assertArtifactUuid(v[key], key);
  if (v.sessionId === null && v.runtimeKey === null) fail("A source requires a session or runtime identity");
  if (v.toolCallId !== null) string(v.toolCallId, 512);
  if (typeof v.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(v.sourceHash)) fail("sourceHash must be SHA256");
}
const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|headers?)/i;
export function validateArtifactProvenance(value: unknown): asserts value is ArtifactProvenance {
  validateArtifactJson(value, ARTIFACT_LIMITS.provenanceBytes);
  const v = object(value, ["source", "method", "capturedAt", "recordedAt", "captureSessionId", "captureToolCallId", "trust", "refresh"], ["source", "method", "recordedAt", "captureSessionId", "captureToolCallId", "trust", "refresh"]);
  const s = object(v.source, ["kind", "label", "locator"], ["kind", "label"]);
  if (!["file", "url", "database", "manual", "derived"].includes(s.kind as string)) fail("Invalid provenance source"); string(s.label);
  if (s.locator !== undefined) string(s.locator);
  const m = object(v.method, ["kind", "description", "parameters"], ["kind", "description"]);
  if (!["import", "query", "extract", "manual", "derive"].includes(m.kind as string)) fail("Invalid provenance method"); string(m.description);
  if (m.parameters !== undefined && (m.parameters === null || typeof m.parameters !== "object" || Array.isArray(m.parameters))) fail("Parameters must be an object");
  const r = object(v.refresh, ["kind", "instructions", "requiredSources"], ["kind", "requiredSources"]);
  if (!["session", "manual", "none"].includes(r.kind as string)) fail("Invalid refresh kind");
  if (r.instructions !== undefined) string(r.instructions);
  if (!Array.isArray(r.requiredSources) || r.requiredSources.length > 32) fail("Invalid required sources");
  for (const source of r.requiredSources) string(source);
  if (v.capturedAt !== undefined) date(v.capturedAt); date(v.recordedAt);
  if (v.captureSessionId !== null) assertArtifactUuid(v.captureSessionId, "captureSessionId");
  if (v.captureToolCallId !== null) string(v.captureToolCallId, 512);
  if (v.trust !== "agent-reported" && v.trust !== "user-entered") fail("Invalid provenance trust");
  const scan = (item: ArtifactJson): void => {
    if (typeof item === "string") {
      if (scanSecrets(item)) fail("Provenance contains credentials");
      for (const match of item.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi)) {
        let url: URL; try { url = new URL(match[0]); } catch { fail("Invalid provenance URL"); }
        const fragment = url.hash.slice(1);
        const fragmentParameters = new URLSearchParams(fragment.includes("?") ? fragment.slice(fragment.indexOf("?") + 1) : fragment);
        if (url.username || url.password || [...url.searchParams.keys(), ...fragmentParameters.keys()].some(key => SECRET_KEY.test(key))) fail("Credential-bearing provenance URL");
      }
    } else if (Array.isArray(item)) item.forEach(scan);
    else if (item !== null && typeof item === "object") for (const [key, child] of Object.entries(item)) { if (SECRET_KEY.test(key)) fail("Secret-shaped provenance field"); scan(child); }
  };
  scan(value as ArtifactJson);
}
export function validateArtifactDatasets(value: unknown): asserts value is ArtifactDatasetInput[] {
  validateArtifactJson(value);
  if (!Array.isArray(value)) fail("Invalid datasets");
  if (value.length > ARTIFACT_LIMITS.datasets) throw new ArtifactError("over-limit", "Too many datasets");
  const ids = new Set<string>(); let total = 0;
  for (const raw of value) {
    const d = object(raw, ["id", "title", "schema", "value", "provenance"]); assertArtifactKey(d.id); string(d.title, ARTIFACT_LIMITS.titleChars);
    if (ids.has(d.id)) fail("Duplicate dataset id"); ids.add(d.id);
    string(d.schema, 200); validateArtifactJson(d.value, ARTIFACT_LIMITS.datasetBytes); validateArtifactProvenance(d.provenance);
    total += artifactUtf8Bytes(JSON.stringify(d.value));
  }
  if (total > ARTIFACT_LIMITS.activeDatasetBytes) throw new ArtifactError("over-limit", "Dataset total exceeds limit");
}
/** A literal local:// relative path. Resolution and filesystem confinement belong to main. */
export function validateArtifactValueFile(value: unknown): asserts value is string {
  string(value);
  const prefix = "local://";
  const path = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || value.includes("\\") || value.includes("\0") || value.includes("?") || value.includes("#") || path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) fail("valueFile must be a nonempty local:// relative path");
}
function validateArtifactAuthoringProvenance(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("Expected provenance object");
  validateArtifactProvenance({ ...value as Record<string, unknown>, recordedAt: "1970-01-01T00:00:00.000Z", captureSessionId: null, captureToolCallId: null, trust: "agent-reported" });
}
function validateArtifactAuthoringDatasets(value: unknown): asserts value is ArtifactDatasetAuthoringInput[] {
  validateArtifactJson(value);
  if (!Array.isArray(value)) fail("Invalid datasets");
  if (value.length > ARTIFACT_LIMITS.datasets) throw new ArtifactError("over-limit", "Too many datasets");
  const ids = new Set<string>(); let total = 0;
  for (const raw of value) {
    const d = object(raw, ["id", "title", "schema", "value", "valueFile", "provenance"], ["id", "title", "schema", "provenance"]);
    assertArtifactKey(d.id); string(d.title, ARTIFACT_LIMITS.titleChars); string(d.schema, 200);
    if (ids.has(d.id)) fail("Duplicate dataset id"); ids.add(d.id);
    const hasValue = Object.hasOwn(d, "value"); const hasValueFile = Object.hasOwn(d, "valueFile");
    if (hasValue === hasValueFile) fail("Dataset requires exactly one of value or valueFile");
    if (hasValue) { validateArtifactJson(d.value, ARTIFACT_LIMITS.datasetBytes); total += artifactUtf8Bytes(JSON.stringify(d.value)); }
    else validateArtifactValueFile(d.valueFile);
    validateArtifactAuthoringProvenance(d.provenance);
  }
  if (total > ARTIFACT_LIMITS.activeDatasetBytes) throw new ArtifactError("over-limit", "Dataset total exceeds limit");
}
export function validateArtifactAuthoringSpec(value: unknown): asserts value is ManagedArtifactAuthoringSpec {
  validateArtifactJson(value);
  const v = object(value, ["protocolVersion", "stateSchema", "initialState", "datasets", "basedOn"], ["protocolVersion", "stateSchema", "initialState", "datasets"]);
  if (v.protocolVersion !== 1) fail("Unsupported managed artifact protocol");
  string(v.stateSchema, 200); validateArtifactJson(v.initialState, ARTIFACT_LIMITS.stateBytes);
  if (v.initialState === null || typeof v.initialState !== "object" || Array.isArray(v.initialState)) fail("initialState must be a JSON object");
  for (const key of Object.keys(v.initialState)) assertArtifactKey(key);
  validateArtifactAuthoringDatasets(v.datasets);
  if (v.basedOn !== undefined) { const b = object(v.basedOn, ["referenceId"]); assertArtifactUuid(b.referenceId); }
}
export function validateManagedArtifactSpec(value: unknown): asserts value is ManagedArtifactSpec {
  validateArtifactJson(value);
  const v = object(value, ["protocolVersion", "stateSchema", "initialState", "datasets", "basedOn"], ["protocolVersion", "stateSchema", "initialState", "datasets"]);
  if (v.protocolVersion !== 1) fail("Unsupported managed artifact protocol");
  string(v.stateSchema, 200); validateArtifactJson(v.initialState, ARTIFACT_LIMITS.stateBytes);
  if (v.initialState === null || typeof v.initialState !== "object" || Array.isArray(v.initialState)) fail("initialState must be a JSON object");
  for (const key of Object.keys(v.initialState)) assertArtifactKey(key);
  validateArtifactDatasets(v.datasets);
  if (v.basedOn !== undefined) { const b = object(v.basedOn, ["referenceId"]); assertArtifactUuid(b.referenceId); }
}
export function validateArtifactDocument(value: ArtifactStageDocumentRequest): void {
  validateArtifactJson(value); const v = object(value, ["title", "html", "source", "originContext", "managed"], ["title", "html", "source", "originContext"]);
  string(v.title, ARTIFACT_LIMITS.titleChars); string(v.html, Number.MAX_SAFE_INTEGER);
  if (artifactUtf8Bytes(v.html) > ARTIFACT_LIMITS.htmlBytes) throw new ArtifactError("over-limit", "HTML exceeds byte limit");
  validateArtifactSource(v.source); if (v.managed !== undefined) validateManagedArtifactSpec(v.managed);
  const origin = object(v.originContext, ["kind", "label", "path"], ["kind"]);
  if (origin.kind === "project") { string(origin.label, 200); string(origin.path); }
  else if (origin.kind !== "chat" || Object.keys(origin).length !== 1) fail("Invalid retained origin context");
}
export function artifactDefinition(spec: ManagedArtifactSpec): ArtifactDefinition { return { protocolVersion: 1, stateSchema: spec.stateSchema, datasets: spec.datasets.map(({ id, title, schema }) => ({ id, title, schema })) }; }
/** Canonical ordering makes schema compatibility independent of object insertion order. */
export function artifactCanonicalJson(value: ArtifactJson): string {
  if (Array.isArray(value)) return `[${value.map(artifactCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${artifactCanonicalJson(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function artifactDefinitionsCompatible(left: ArtifactDefinition | null, right: ArtifactDefinition | null): boolean {
  if (!left || !right) return left === right;
  return left.protocolVersion === right.protocolVersion && artifactCanonicalJson(left.stateSchema) === artifactCanonicalJson(right.stateSchema) && left.datasets.length === right.datasets.length && left.datasets.every(a => right.datasets.some(b => a.id === b.id && artifactCanonicalJson(a.schema) === artifactCanonicalJson(b.schema)));
}
export function pageArtifactText(text: string, request: ArtifactReferencePartRequest): ArtifactPartResult {
  assertArtifactUuid(request.referenceId, "referenceId");
  const offset = request.offset ?? 0; const limit = request.limit ?? 16384; const bytes = encoder.encode(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || !Number.isSafeInteger(limit) || limit < 4 || limit > 65536) fail("Invalid UTF-8 page bounds");
  if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) fail("Offset is not a UTF-8 boundary");
  let end = Math.min(bytes.length, offset + limit); while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { version: 1, referenceId: request.referenceId, part: request.part, ...(request.datasetId ? { datasetId: request.datasetId } : {}), offset, nextOffset: end === bytes.length ? null : end, totalBytes: bytes.length, encoding: "utf-8", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)) };
}

/** Stamps host-owned facts before validating an agent's managed authoring envelope. */
export function normalizeArtifactAuthoringSpec(value: unknown, host: { recordedAt: string; captureSessionId: string | null; captureToolCallId: string | null }): ManagedArtifactSpec {
  validateArtifactJson(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("Expected managed authoring object");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.datasets)) fail("Expected managed datasets");
  const result = { ...raw, datasets: raw.datasets.map(dataset => {
    if (dataset === null || typeof dataset !== "object" || Array.isArray(dataset)) fail("Expected dataset object");
    const input = dataset as Record<string, unknown>;
    if (input.provenance === null || typeof input.provenance !== "object" || Array.isArray(input.provenance)) fail("Expected provenance object");
    if (Object.hasOwn(input, "valueFile")) fail("Unresolved valueFile cannot be persisted");
    return { ...input, provenance: { ...input.provenance, ...host, trust: "agent-reported" } };
  }) };
  validateManagedArtifactSpec(result);
  return result;
}
