import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store";
import { ARTIFACT_LIMITS, ArtifactError, type ArtifactRecord, type ArtifactSource, type ManagedArtifactSpec, type ArtifactProvenance } from "./artifacts";

const ownerInstanceId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000001";
const runtimeKey = "30000000-0000-4000-8000-000000000001";
const refreshSessionId = "20000000-0000-4000-8000-000000000002";
const pendingRuntimeKey = "30000000-0000-4000-8000-000000000002";
const materializedSessionId = "20000000-0000-4000-8000-000000000003";
const createdAt = "2026-11-09T00:00:00.000Z";
const roots: string[] = []; const stores: ArtifactStore[] = []; const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => { for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } } for (const store of stores.splice(0)) { try { store.close(); } catch { /* A lease-revocation test intentionally invalidates its writer. */ } } for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "omp-artifact-store-")); roots.push(value); return value; }
function open(directory = root(), authorize?: () => void): ArtifactStore { const store = new ArtifactStore({ root: directory, ownerInstanceId, authorize }); stores.push(store); return store; }
function source(label: string = randomUUID(), overrides: Partial<ArtifactSource> = {}): ArtifactSource { return { ownerInstanceId, lineageDir: "/trusted/project", sessionId, runtimeKey, toolCallId: label, sourceHash: createHash("sha256").update(label).digest("hex"), createdAt, ...overrides }; }
function provenance(): ArtifactProvenance { return { source: { kind: "file", label: "Public CSV", locator: "/public/data.csv" }, method: { kind: "import", description: "Read public CSV", parameters: { delimiter: "," } }, recordedAt: createdAt, captureSessionId: sessionId, captureToolCallId: "read-a", trust: "agent-reported", refresh: { kind: "session", instructions: "Read the current CSV", requiredSources: ["/public/data.csv"] } }; }
function managed(): ManagedArtifactSpec { return { protocolVersion: 1, stateSchema: "view-v1", initialState: { filter: "all", untouched: { n: 1 } }, datasets: [{ id: "rows", title: "Rows", schema: "rows-v1", value: [{ n: 1 }], provenance: provenance() }, { id: "notes", title: "Notes", schema: "notes-v1", value: ["original"], provenance: provenance() }] }; }
function keep(store: ArtifactStore, spec = managed(), s = source()): ArtifactRecord { const draft = store.stageDocument({ title: "Chart", html: "<p>Chart</p>", source: s, originContext: { kind: "chat" }, managed: spec }); return store.keepDraft({ draftId: draft.draftId, title: "Chart" }); }
function snapshot(store: ArtifactStore, record: ArtifactRecord) { return store.readSnapshot({ artifactId: record.artifactId, dataSnapshotId: record.currentDataSnapshotId }); }
async function childLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  let output = "";
  child.once("error", error => child.stdout.destroy(error));
  for await (const chunk of child.stdout) { output += String(chunk); if (output.includes("\n")) return output.trim(); }
  throw new Error(`Child exited without a result: ${output}`);
}

describe("ArtifactStore durable graph", () => {
  it("keeps idempotently across reopen/runtime restart and survives source deletion", () => {
    const directory = root(); let store = open(directory); const s = source("render-a"); const draft = store.stageDocument({ title: "Chart", html: "<p>Chart</p>", source: s, originContext: { kind: "project", label: "Retained project", path: "/removed/project" }, managed: managed() });
    const record = store.keepDraft({ draftId: draft.draftId, title: "Chart" }); expect(store.keepDraft({ draftId: draft.draftId, title: "ignored retry" })).toEqual(record);
    store.close(); store = open(directory);
    expect(store.lookupSource({ source: { ...s, runtimeKey: randomUUID(), createdAt: "2026-11-10T00:00:00.000Z" } })).toEqual({ status: "kept", artifact: record });
    expect(store.readSource({ draftId: draft.draftId })).toEqual(s);
    store.dropDraftsForLineage({ lineageDir: s.lineageDir }); expect(snapshot(store, record).datasets[0]!.value).toEqual(["original"]);
    expect(store.describe({ artifactId: record.artifactId }).artifact.originContext).toEqual({ kind: "project", label: "Retained project", path: "/removed/project" });
    expect(store.readCode({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId }).html).toBe("<p>Chart</p>");
  });
  it("clones consented compatible previews, isolates draft edits, and keeps acknowledged state", () => {
    const store = open(); const record = keep(store); const reference = store.createReference({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, includeData: true });
    const candidate = managed(); candidate.initialState = { filter: "candidate-default" }; candidate.datasets[0]!.value = [999]; candidate.basedOn = { referenceId: reference.referenceId };
    const draft = store.stageDocument({ title: "Candidate", html: "<p>next</p>", source: source(), originContext: { kind: "chat" }, managed: candidate }); expect(draft.previewDataSnapshotId).toBe(record.currentDataSnapshotId);
    const acknowledged = store.patchDraftState({ draftId: draft.draftId, expectedStateRevision: 0, set: { filter: "human-choice" }, remove: ["untouched"] });
    expect(acknowledged.draftStateId).not.toBe(draft.draftStateId);
    expect(() => store.patchDraftState({ draftId: draft.draftId, expectedStateRevision: 0, set: {} })).toThrow(/changed/);
    expect(snapshot(store, record).userState.filter).toBe("all");
    const next = store.keepDraft({ draftId: draft.draftId, title: "Independent copy" }); expect(snapshot(store, next)).toMatchObject({ userState: { filter: "human-choice" }, stateRevision: 1 }); expect(snapshot(store, next).userState).not.toHaveProperty("untouched");
    const denied = store.createReference({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, includeData: false }); candidate.basedOn = { referenceId: denied.referenceId };
    const noConsent = store.stageDocument({ title: "No data grant", html: "<p>new</p>", source: source(), originContext: { kind: "chat" }, managed: candidate }); expect(noConsent.previewDataSnapshotId).toBeNull(); expect(store.readDraft(noConsent).managed?.initialState.filter).toBe("candidate-default");
  });
  it("uses per-key state CAS and preserves immutable previous snapshots", () => {
    const directory = root(); const store = open(directory); const record = keep(store);
    const updated = store.patchUserState({ artifactId: record.artifactId, expectedCodeRevisionId: record.currentCodeRevisionId, expectedDataSnapshotId: record.currentDataSnapshotId, expectedStateRevision: 0, set: { filter: "active" }, remove: [] });
    expect(snapshot(store, updated).userState).toEqual({ filter: "active", untouched: { n: 1 } }); expect(snapshot(store, record).userState.filter).toBe("all");
    expect(() => store.patchUserState({ artifactId: record.artifactId, expectedCodeRevisionId: record.currentCodeRevisionId, expectedDataSnapshotId: record.currentDataSnapshotId, expectedStateRevision: 0, set: {} })).toThrow(/changed/);
    const db = new DatabaseSync(path.join(directory, "library.sqlite")); try { const rows = db.prepare("SELECT object_id,payload_hash FROM state_entries WHERE key='untouched'").all(); expect(new Set(rows.map(row => row.payload_hash)).size).toBe(1); expect(rows).toHaveLength(2); expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]); } finally { db.close(); }
  });
  it("accepts only exact compatible non-stale code and preserves current human data", () => {
    const store = open(); const record = keep(store); const reference = store.createReference({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, includeData: false });
    const candidate = managed(); candidate.initialState = { reset: true }; candidate.datasets[0]!.value = [999]; candidate.basedOn = { referenceId: reference.referenceId };
    const draft = store.stageDocument({ title: "Revision", html: "<p>revised</p>", source: source(), originContext: { kind: "chat" }, managed: candidate });
    const current = store.patchUserState({ artifactId: record.artifactId, expectedCodeRevisionId: record.currentCodeRevisionId, expectedDataSnapshotId: record.currentDataSnapshotId, expectedStateRevision: 0, set: { filter: "manual" } });
    const accepted = store.acceptRevision({ draftId: draft.draftId, expectedCodeRevisionId: current.currentCodeRevisionId }); expect(accepted.currentDataSnapshotId).toBe(current.currentDataSnapshotId); expect(snapshot(store, accepted).userState.filter).toBe("manual");
    expect(store.describe({ artifactId: record.artifactId }).revisions).toHaveLength(2);
    const stale = store.stageDocument({ title: "Stale", html: "<p>stale</p>", source: source(), originContext: { kind: "chat" }, managed: candidate }); expect(() => store.acceptRevision({ draftId: stale.draftId, expectedCodeRevisionId: accepted.currentCodeRevisionId })).toThrow(/stale/); expect(store.keepDraft({ draftId: stale.draftId, title: "Copy" }).artifactId).not.toBe(record.artifactId);
    candidate.basedOn = { referenceId: store.createReference({ artifactId: accepted.artifactId, codeRevisionId: accepted.currentCodeRevisionId, dataSnapshotId: accepted.currentDataSnapshotId, includeData: false }).referenceId }; candidate.stateSchema = "view-v2";
    const incompatible = store.stageDocument({ title: "New contract", html: "<p>v2</p>", source: source(), originContext: { kind: "chat" }, managed: candidate }); expect(() => store.acceptRevision({ draftId: incompatible.draftId, expectedCodeRevisionId: accepted.currentCodeRevisionId })).toThrow(/contract/);
  });
  it("stages full-set target/session-bound captures and applies with dataset-only CAS", () => {
    const store = open(); const original = keep(store);
    const refresh = store.prepareRefresh({ artifactId: original.artifactId, codeRevisionId: original.currentCodeRevisionId, dataSnapshotId: original.currentDataSnapshotId, targetTabId: "tab-a", datasetIds: ["rows"] });
    const input = { refreshRequestId: refresh.refreshRequestId, targetTabId: "tab-a", lineageDir: "/trusted/project", runtimeKey, sessionId: refreshSessionId, source: source("capture", { sessionId: refreshSessionId }), datasets: [{ ...managed().datasets[0]!, value: [{ n: 2 }] }] };
    expect(() => store.stageCapture(input)).toThrow(/bound/); store.bindRefresh({ refreshRequestId: refresh.refreshRequestId, targetTabId: "tab-a", lineageDir: "/trusted/project", runtimeKey, sessionId: null });
    expect(() => store.stageCapture({ ...input, targetTabId: "other" })).toThrow(); expect(() => store.stageCapture({ ...input, datasets: [] })).toThrow(/full selected/);
    const capture = store.stageCapture(input); expect(snapshot(store, original).datasets.find(d => d.id === "rows")!.value).toEqual([{ n: 1 }]);
    const staleCapture = store.stageCapture({ ...input, source: source("capture-stale", { sessionId: refreshSessionId }) });
    const edited = store.patchUserState({ artifactId: original.artifactId, expectedCodeRevisionId: original.currentCodeRevisionId, expectedDataSnapshotId: original.currentDataSnapshotId, expectedStateRevision: 0, set: { filter: "manual" } });
    const applied = store.applyCapture({ captureId: capture.captureId, expectedCodeRevisionId: edited.currentCodeRevisionId, expectedDatasetHeads: refresh.expectedDatasetHeads }); const saved = snapshot(store, applied);
    expect(saved.userState.filter).toBe("manual"); expect(saved.stateRevision).toBe(1); expect(saved.datasets.find(d => d.id === "rows")!.value).toEqual([{ n: 2 }]); expect(saved.datasets.find(d => d.id === "notes")!.value).toEqual(["original"]);
    expect(() => store.applyCapture({ captureId: capture.captureId, expectedCodeRevisionId: applied.currentCodeRevisionId, expectedDatasetHeads: refresh.expectedDatasetHeads })).toThrow(/already/);
    expect(() => store.applyCapture({ captureId: staleCapture.captureId, expectedCodeRevisionId: applied.currentCodeRevisionId, expectedDatasetHeads: refresh.expectedDatasetHeads })).toThrow(/dataset changed/);
    const description = store.describe({ artifactId: original.artifactId }); expect(description.captures[0]!.datasets[0]).toMatchObject({ valueBytes: 9, currentValueBytes: 9 }); expect(JSON.stringify(description)).not.toContain('"value":');
    expect(() => store.readPart({ artifactId: original.artifactId, codeRevisionId: original.currentCodeRevisionId, dataSnapshotId: applied.currentDataSnapshotId, captureId: capture.captureId, part: "dataset", datasetId: "rows" })).toThrow(/match/);
    expect(store.readPart({ artifactId: original.artifactId, codeRevisionId: original.currentCodeRevisionId, dataSnapshotId: original.currentDataSnapshotId, captureId: capture.captureId, part: "dataset", datasetId: "rows" }).text).toBe('[{"n":2}]');
  });
  it("keeps grants immutable, pages large multibyte bodies, and never broadens consent", () => {
    const store = open(); const spec = managed(); spec.datasets[0]!.value = "€🙂".repeat(16000); const record = keep(store, spec);
    const request = { artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId };
    const denied = store.createReference({ ...request, includeData: false }); expect(() => store.readReferencePart({ referenceId: denied.referenceId, part: "dataset", datasetId: "rows" })).toThrow(/grant/); expect(() => store.readReferencePart({ referenceId: denied.referenceId, part: "state" })).toThrow(/grant/);
    const ref = store.createReference({ ...request, includeData: true }); let offset = 0; let text = "";
    for (;;) { const page = store.readReferencePart({ referenceId: ref.referenceId, part: "dataset", datasetId: "rows", offset, limit: 65536 }); text += page.text; if (page.nextOffset === null) break; offset = page.nextOffset; }
    expect(JSON.parse(text)).toBe(spec.datasets[0]!.value); const manifest = store.readReferencePart({ referenceId: ref.referenceId, part: "manifest" }); expect(manifest.text).not.toContain("parameters"); expect(manifest.text).not.toContain("initialState");
    store.patchUserState({ artifactId: record.artifactId, expectedCodeRevisionId: record.currentCodeRevisionId, expectedDataSnapshotId: record.currentDataSnapshotId, expectedStateRevision: 0, set: { filter: "newer" } });
    expect(JSON.parse(store.readReferencePart({ referenceId: ref.referenceId, part: "state" }).text).filter).toBe("all");
    store.dropDraftsForLineage({ lineageDir: record.origin.lineageDir }); expect(store.readReference({ referenceId: ref.referenceId })).toEqual(ref);
  });
  it("fences authority immediately precommit and rolls back deletion/GC on revocation", () => {
    let allowed = true; const store = open(root(), () => { if (!allowed) throw new ArtifactError("disabled", "disabled"); }); const record = keep(store); const draft = store.stageDocument({ title: "draft", html: "x", source: source(), originContext: { kind: "chat" } });
    expect(() => store.keepDraft({ draftId: draft.draftId, title: "Denied", authorize: () => { throw new ArtifactError("disabled", "revoked guest"); } })).toThrow(/revoked/); expect(store.list().artifacts).toHaveLength(1);
    expect(() => store.keepDraft({ draftId: draft.draftId, title: "Async denied", authorize: async () => {} })).toThrow(/must be synchronous/); expect(store.list().artifacts).toHaveLength(1);
    allowed = false; expect(() => store.deleteArtifact({ artifactId: record.artifactId, expectedGeneration: record.generation })).toThrow(/disabled/); allowed = true; expect(snapshot(store, record).datasets).toHaveLength(2);
    expect(() => store.deleteArtifact({ artifactId: record.artifactId, expectedGeneration: record.generation + 1 })).toThrow(/changed/);
    store.discardDraft({ draftId: record.artifactId }); expect(store.describe({ artifactId: record.artifactId }).artifact).toEqual(record);
  });
  it("charges metadata, deduplicates shared bytes, and transactionally reclaims deletion quota", () => {
    const directory = root(); const store = open(directory); const first = keep(store); const db = new DatabaseSync(path.join(directory, "library.sqlite"));
    try {
      const before = Number(db.prepare("SELECT COUNT(*) AS n FROM payloads").get()!.n); const second = keep(store); expect(Number(db.prepare("SELECT COUNT(*) AS n FROM payloads").get()!.n)).toBe(before);
      const deletedReference = store.createReference({ artifactId: first.artifactId, codeRevisionId: first.currentCodeRevisionId, dataSnapshotId: first.currentDataSnapshotId, includeData: true });
      const pressure = randomUUID(); db.prepare("INSERT INTO objects(id,kind,artifact_id,metadata,metadata_bytes) VALUES(?,'quota-reservation',?,'{}',?)").run(pressure, first.artifactId, ARTIFACT_LIMITS.artifactBytes);
      expect(() => store.createReference({ artifactId: first.artifactId, codeRevisionId: first.currentCodeRevisionId, dataSnapshotId: first.currentDataSnapshotId, includeData: false })).toThrow(/quota/); expect(store.describe({ artifactId: first.artifactId }).references).toEqual([deletedReference]);
      store.deleteArtifact({ artifactId: first.artifactId, expectedGeneration: first.generation }); expect(Number(db.prepare("SELECT COUNT(*) AS n FROM payloads").get()!.n)).toBe(before);
      expect(store.lookupSource({ source: first.origin })).toEqual({ status: "deleted", artifactId: first.artifactId }); expect(() => store.keepDraft({ draftId: first.sourceDraftId, title: "Resurrect" })).toThrow(/deleted/);
      expect(() => store.readReference({ referenceId: deletedReference.referenceId })).toThrow("Deleted");
      store.deleteArtifact({ artifactId: second.artifactId, expectedGeneration: second.generation }); expect(Number(db.prepare("SELECT COUNT(*) AS n FROM payloads").get()!.n)).toBe(0); expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });
  it("adopts observed materialized-session facts for drafts and accepted sources without changing bytes", () => {
    const store = open(); const pendingKeptSource = source("kept-pending", { sessionId: null, runtimeKey: pendingRuntimeKey }); const kept = keep(store, managed(), pendingKeptSource); const s = source("pending", { sessionId: null, runtimeKey: pendingRuntimeKey, lineageDir: "/removed" }); const draft = store.stageDocument({ title: "pending", html: "x", source: s, originContext: { kind: "chat" }, managed: managed() });
    store.adoptSourceSession({ lineageDir: "/removed", runtimeKey: pendingRuntimeKey, sessionId: materializedSessionId }); expect(store.readSource(draft).sessionId).toBe(materializedSessionId); expect(store.lookupSource({ source: { ...s, sessionId: materializedSessionId, runtimeKey: null } }).status).toBe("draft");
    store.adoptSourceSession({ lineageDir: kept.origin.lineageDir, runtimeKey: pendingRuntimeKey, sessionId: materializedSessionId }); expect(store.readSource({ draftId: kept.sourceDraftId }).sessionId).toBe(materializedSessionId); expect(store.readCode({ artifactId: kept.artifactId, codeRevisionId: kept.currentCodeRevisionId })).toMatchObject({ html: "<p>Chart</p>", source: { sessionId: materializedSessionId } });
    store.reconcileSources({ lineageDirs: [kept.origin.lineageDir] }); expect(() => store.readDraft(draft)).toThrow(); expect(snapshot(store, kept).datasets).toHaveLength(2);
  });
});

describe("unknown native artifact identities", () => {
  it("keeps separate user state when native tool identities are unknown", () => {
    const store = open(); const unknown = source("unknown-native", {toolCallId: null});
    const input = {title: "Same document", html: "<p>same</p>", source: unknown, originContext: {kind: "chat" as const}, managed: managed()};
    const first = store.stageDocument(input); const second = store.stageDocument(input);
    store.patchDraftState({draftId: first.draftId, expectedStateRevision: 0, set: {filter: "first user input"}});
    store.patchDraftState({draftId: second.draftId, expectedStateRevision: 0, set: {filter: "second user input"}});
    const firstKept = store.keepDraft({draftId: first.draftId, title: "First"});
    const secondKept = store.keepDraft({draftId: second.draftId, title: "Second"});
    expect(snapshot(store, firstKept).userState.filter).toBe("first user input");
    expect(snapshot(store, secondKept).userState.filter).toBe("second user input");
    expect(firstKept.artifactId).not.toBe(secondKept.artifactId);
  });
});

describe("pending artifact candidates", () => {
  it("describes metadata-only compatible and incompatible proposals without changing accepted heads", () => {
    const store = open(); const record = keep(store);
    const reference = store.createReference({artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, includeData: true});
    const proposal = managed(); proposal.basedOn = {referenceId: reference.referenceId};
    const draft = store.stageDocument({title: "Proposal", html: "<p>proposed code</p>", source: source(), originContext: {kind: "chat"}, managed: proposal});
    const pending = store.describe({artifactId: record.artifactId});
    expect(pending.candidates).toMatchObject([{draft: {draftId: draft.draftId}, compatible: true, stale: false, expectedCodeRevisionId: record.currentCodeRevisionId}]);
    expect(JSON.stringify(pending.candidates)).not.toContain("initialState");
    expect(JSON.stringify(pending.candidates)).not.toContain("proposed code");
    expect(pending.artifact.currentCodeRevisionId).toBe(record.currentCodeRevisionId);
    store.discardDraft({draftId: draft.draftId});
    proposal.stateSchema = "view-v2";
    const incompatible = store.stageDocument({title: "Different contract", html: "<p>independent code</p>", source: source(), originContext: {kind: "chat"}, managed: proposal});
    expect(store.describe({artifactId: record.artifactId}).candidates.find(candidate => candidate.draft.draftId === incompatible.draftId)?.compatible).toBe(false);
    expect(store.describe({artifactId: record.artifactId}).artifact.currentDataSnapshotId).toBe(record.currentDataSnapshotId);
    store.dropDraftsForLineage({lineageDir: incompatible.source.lineageDir});
    expect(store.describe({artifactId: record.artifactId}).candidates).toEqual([]);
  });
});

describe("ArtifactStore retained authority and integrity", () => {
  it("keeps a deleted runtime-only source deleted after observed materialization", () => {
    const store = open(); const pending = source("deleted-before-materialization", {sessionId: null, runtimeKey: pendingRuntimeKey});
    const record = keep(store, managed(), pending);
    store.deleteArtifact({artifactId: record.artifactId, expectedGeneration: record.generation});
    store.adoptSourceSession({lineageDir: pending.lineageDir, runtimeKey: pendingRuntimeKey, sessionId: materializedSessionId});
    const observed = {...pending, sessionId: materializedSessionId, runtimeKey: null};
    expect(store.lookupSource({source: observed})).toEqual({status: "deleted", artifactId: record.artifactId});
    expect(() => store.stageDocument({title: "Resurrect", html: "<p>same</p>", source: observed, originContext: {kind: "chat"}})).toThrow(/deleted/);
  });
  it("rejects corrupt descriptor versions and consent against the normalized immutable grant", () => {
    const directory = root(); const store = open(directory); const record = keep(store); const other = keep(store);
    const reference = store.createReference({artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, includeData: false});
    const db = new DatabaseSync(path.join(directory, "library.sqlite"));
    try {
      const update = db.prepare("UPDATE objects SET metadata=? WHERE id=?");
      update.run(JSON.stringify({...reference, dataSnapshotId: other.currentDataSnapshotId}), reference.referenceId);
      expect(() => store.readReferencePart({referenceId: reference.referenceId, part: "state"})).toThrow(/grant/);
      update.run(JSON.stringify({...reference, includeData: true, dataUri: `omp-ui://artifacts/reference/${reference.referenceId}/state`}), reference.referenceId);
      expect(() => store.readReferencePart({referenceId: reference.referenceId, part: "state"})).toThrow(/grant/);
    } finally { db.close(); }
  });
  it.each(["dataset:notes", "state:untouched"])("never acknowledges a state save or refresh retaining corrupt %s bytes", slot => {
    const directory = root(); const store = open(directory); const record = keep(store);
    snapshot(store, record);
    const refresh = store.prepareRefresh({artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, targetTabId: "tab", datasetIds: ["rows"]});
    store.bindRefresh({refreshRequestId: refresh.refreshRequestId, targetTabId: "tab", lineageDir: record.origin.lineageDir, runtimeKey, sessionId: refreshSessionId});
    const capture = store.stageCapture({refreshRequestId: refresh.refreshRequestId, targetTabId: "tab", lineageDir: record.origin.lineageDir, runtimeKey, sessionId: refreshSessionId, source: source("fresh", {sessionId: refreshSessionId}), datasets: [{...managed().datasets[0]!, value: [99]}]});
    const db = new DatabaseSync(path.join(directory, "library.sqlite"));
    try { db.prepare("UPDATE payloads SET bytes=CAST('bad' AS BLOB),size=3 WHERE hash=(SELECT payload_hash FROM payload_links WHERE object_id=? AND slot=?)").run(record.currentDataSnapshotId, slot); }
    finally { db.close(); }
    expect(() => store.patchUserState({artifactId: record.artifactId, expectedCodeRevisionId: record.currentCodeRevisionId, expectedDataSnapshotId: record.currentDataSnapshotId, expectedStateRevision: 0, set: {filter: "changed"}})).toThrow(/corrupt/i);
    expect(() => store.applyCapture({captureId: capture.captureId, expectedCodeRevisionId: record.currentCodeRevisionId, expectedDatasetHeads: refresh.expectedDatasetHeads})).toThrow(/corrupt/i);
    expect(store.list().artifacts.find(item => item.artifactId === record.artifactId)?.currentDataSnapshotId).toBe(record.currentDataSnapshotId);
  });
});

describe("ArtifactStore security and lease", () => {
  it.runIf(process.platform !== "win32")("refuses non-private POSIX directories and database files", () => {
    const directory = root();
    fs.chmodSync(directory, 0o755);
    expect(() => open(directory)).toThrow(/private/);
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(path.join(directory, "library.sqlite"), "", { mode: 0o600 });
    fs.chmodSync(path.join(directory, "library.sqlite"), 0o644);
    expect(() => open(directory)).toThrow(/private/);
  });
  it("refuses symlink roots/files, foreign owners/versions, and corrupt payload bytes", () => {
    const directory = root(); const target = root(); const link = path.join(directory, "link"); fs.symlinkSync(target, link); expect(() => open(link)).toThrow(/symlink/);
    const linkedDbRoot = root(); fs.writeFileSync(path.join(target, "foreign"), "", { mode: 0o600 }); fs.symlinkSync(path.join(target, "foreign"), path.join(linkedDbRoot, "library.sqlite")); expect(() => open(linkedDbRoot)).toThrow();
    const store = open(directory); const record = keep(store); expect(() => new ArtifactStore({ root: directory, ownerInstanceId: randomUUID() })).toThrow(/owner/);
    const db = new DatabaseSync(path.join(directory, "library.sqlite")); try { db.prepare("UPDATE payloads SET bytes=CAST('bad' AS BLOB),size=3 WHERE hash=(SELECT payload_hash FROM payload_links WHERE object_id=? AND slot='html')").run(record.currentCodeRevisionId); expect(() => store.assertSurface({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId })).not.toThrow(); expect(() => store.readCode({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId })).toThrow(/corrupt/); } finally { db.close(); }
    store.close(); const version = new DatabaseSync(path.join(directory, "library.sqlite")); version.exec("PRAGMA user_version=99"); version.close(); expect(() => open(directory)).toThrow(/version/);
    const corrupt = root(); fs.writeFileSync(path.join(corrupt, "library.sqlite"), "not sqlite", { mode: 0o600 }); expect(() => open(corrupt)).toThrow();
  });
  it("refuses corrupt staged capture bytes without publishing a new current snapshot", () => {
    const directory = root(); const store = open(directory); const record = keep(store);
    const refresh = store.prepareRefresh({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, targetTabId: "tab-a", datasetIds: ["rows"] });
    store.bindRefresh({ refreshRequestId: refresh.refreshRequestId, targetTabId: "tab-a", lineageDir: record.origin.lineageDir, runtimeKey, sessionId: refreshSessionId });
    const capture = store.stageCapture({ refreshRequestId: refresh.refreshRequestId, targetTabId: "tab-a", lineageDir: record.origin.lineageDir, runtimeKey, sessionId: refreshSessionId, source: source("corrupt-capture", { sessionId: refreshSessionId }), datasets: [{ ...managed().datasets[0]!, value: [99] }] });
    const db = new DatabaseSync(path.join(directory, "library.sqlite"));
    try { db.prepare("UPDATE payloads SET bytes=CAST('bad' AS BLOB),size=3 WHERE hash=(SELECT payload_hash FROM payload_links WHERE object_id=? AND slot='dataset:rows')").run(capture.captureId); }
    finally { db.close(); }
    expect(() => store.applyCapture({ captureId: capture.captureId, expectedCodeRevisionId: record.currentCodeRevisionId, expectedDatasetHeads: refresh.expectedDatasetHeads })).toThrow(ArtifactError);
    expect(store.list().artifacts[0]!.currentDataSnapshotId).toBe(record.currentDataSnapshotId);
    expect(snapshot(store, record).datasets.find(d => d.id === "rows")!.value).toEqual([{ n: 1 }]);
  });
  it("refuses a live writer and fences a stolen lease", () => {
    const directory = root(); const store = open(directory); expect(() => open(directory)).toThrow(/live writer/); const db = new DatabaseSync(path.join(directory, "library.sqlite")); try { db.prepare("UPDATE writer_lease SET token=?").run(randomUUID()); expect(() => store.stageDocument({ title: "x", html: "x", source: source(), originContext: { kind: "chat" } })).toThrow(/revoked/); } finally { db.close(); }
  });
  it("treats uncheckable live-process authority as Busy without stealing its lease", () => {
    const directory = root(); open(directory);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Permission denied"), { code: "EPERM" }); });
    try { let failure: unknown; try { open(directory); } catch (error) { failure = error; } expect(failure).toMatchObject({ code: "busy" }); }
    finally { kill.mockRestore(); }
  });
  it("recovers a process killed during initialization and permits only one racing reclaimer", async () => {
    const directory = root(); const dbPath = path.join(directory, "library.sqlite");
    const worker = path.join(directory, "store-worker.mjs"); buildSync({ entryPoints: [fileURLToPath(new URL("./artifact-store.ts", import.meta.url))], outfile: worker, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    // The freshly built module path is selected at runtime by this process-boundary test.
    // The synchronous authorizer is the final precommit fault-injection boundary of the real constructor.
    const interrupted = spawn(process.execPath, ["--input-type=module", "-e", `const {ArtifactStore}=await import(process.argv[1]);new ArtifactStore({root:process.argv[2],ownerInstanceId:process.argv[3],authorize(){console.log('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}})`, pathToFileURL(worker).href, directory, ownerInstanceId]); children.push(interrupted); await childLine(interrupted); const exited = once(interrupted, "exit"); interrupted.kill("SIGKILL"); await exited;
    const recovered = open(directory); expect(recovered.list().artifacts).toEqual([]); recovered.close();
    const code = `const {ArtifactStore}=await import(process.argv[1]);try{const s=new ArtifactStore({root:process.argv[2],ownerInstanceId:process.argv[3]});console.log('owned');process.stdin.resume()}catch(e){console.log(e.code);process.exit(0)}`;
    // A dead, same-host committed lease is reclaimable; two serialized constructors cannot both own it.
    const db = new DatabaseSync(dbPath); db.prepare("INSERT INTO writer_lease(singleton,host,pid,token) VALUES(1,?,?,?)").run(os.hostname(), interrupted.pid!, randomUUID()); db.close();
    const a = spawn(process.execPath, ["--input-type=module", "-e", code, pathToFileURL(worker).href, directory, ownerInstanceId]); const b = spawn(process.execPath, ["--input-type=module", "-e", code, pathToFileURL(worker).href, directory, ownerInstanceId]); children.push(a, b);
    expect((await Promise.all([childLine(a), childLine(b)])).sort()).toEqual(["busy", "owned"]);
  }, 20000);
});

describe("ArtifactStore human maintenance", () => {
  it("renames with generation CAS while grants keep their immutable Keep-time titles", () => {
    const store = open(); const record = keep(store);
    const grant = store.createReference({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, includeData: true });
    expect(grant.title).toBe("Chart");
    expect(() => store.rename({ artifactId: record.artifactId, expectedGeneration: 99, title: "Renamed" })).toThrow(/changed/);
    const renamed = store.rename({ artifactId: record.artifactId, expectedGeneration: record.generation, title: "Renamed" });
    expect(renamed).toMatchObject({ title: "Renamed", generation: record.generation + 1 });
    // The stored grant keeps its snapshot title; a descriptor built from the NEW title fails closed.
    expect(store.readReference({ referenceId: grant.referenceId }).title).toBe("Chart");
    expect(store.list().artifacts.find(row => row.artifactId === record.artifactId)?.title).toBe("Renamed");
    const candidate = managed(); candidate.basedOn = { referenceId: grant.referenceId };
    const draft = store.stageDocument({ title: "Candidate", html: "<p>x</p>", source: source(), originContext: { kind: "chat" }, managed: candidate });
    expect(store.lookupSource({ source: draft.source, draftId: draft.draftId }).status).toBe("draft");
    // A new grant after the rename carries the new title.
    const next = store.createReference({ artifactId: record.artifactId, codeRevisionId: renamed.currentCodeRevisionId, dataSnapshotId: renamed.currentDataSnapshotId, includeData: false });
    expect(next.title).toBe("Renamed");
    // A stale delete on the shared generation still conflicts.
    expect(() => store.deleteArtifact({ artifactId: record.artifactId, expectedGeneration: record.generation })).toThrow(/changed/);
  });
  it("orders pinned first, pages deterministically with v2 cursors across equal timestamps and multibyte titles, and supports filters/sorts/counts", () => {
    const store = open();
    const longTitle = "🚀".repeat(50) + "|Pipe|Alpha";
    const d1 = store.stageDocument({ title: longTitle, html: "<p>1</p>", source: source("a"), originContext: { kind: "project", label: "Reports", path: "/reports" }, managed: managed() });
    const first = store.keepDraft({ draftId: d1.draftId, title: longTitle });
    const d2 = store.stageDocument({ title: "Beta Doc", html: "<p>2</p>", source: source("b"), originContext: { kind: "chat" } });
    const second = store.keepDraft({ draftId: d2.draftId, title: "Beta Doc" });
    const d3 = store.stageDocument({ title: "Gamma Chart", html: "<p>3</p>", source: source("c"), originContext: { kind: "project", label: "Reports", path: "/reports" }, managed: managed() });
    const third = store.keepDraft({ draftId: d3.draftId, title: "Gamma Chart" });

    // Pinning preserves updatedAt, increments generation, and puts the row on page 1 regardless of sort.
    const pinned = store.pin({ artifactId: second.artifactId, expectedGeneration: second.generation, pinned: true });
    expect(pinned.pinnedAt).not.toBeNull();
    expect(pinned.updatedAt).toBe(second.updatedAt);
    expect(pinned.generation).toBe(second.generation + 1);
    expect(() => store.pin({ artifactId: second.artifactId, expectedGeneration: second.generation, pinned: false })).toThrow(/changed/);

    // Paging with limit=1 covers every item deterministically with a bounded v2 cursor (< 80 chars).
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 5; step++) {
      const page = store.list({ limit: 1, cursor, sort: "recent" });
      expect(page.totalCount).toBe(3);
      expect(page.origins).toEqual([
        { key: "/reports", label: "Reports", kind: "project" },
        { key: "chat", label: "Chat", kind: "chat" },
      ]);
      if (page.artifacts.length === 0) break;
      seen.push(page.artifacts[0]!.artifactId);
      if (!page.nextCursor) break;
      expect(page.nextCursor.length).toBeLessThan(120);
      cursor = page.nextCursor;
    }
    expect(seen[0]).toBe(second.artifactId);
    expect([...seen].sort()).toEqual([first.artifactId, second.artifactId, third.artifactId].sort());

    // Name sort still places pinned items first and pages cleanly over multibyte titles with '|'.
    const namePage1 = store.list({ limit: 1, sort: "name" });
    expect(namePage1.artifacts[0]!.artifactId).toBe(second.artifactId);
    expect(() => store.list({ cursor: namePage1.nextCursor!, sort: "recent" })).toThrow(/cursor/);
    const namePage2 = store.list({ limit: 2, cursor: namePage1.nextCursor!, sort: "name" });
    expect(namePage2.artifacts.map(r => r.artifactId)).toEqual([third.artifactId, first.artifactId]);

    // Search matches project labels and Chat; filters separate managed/document/review.
    expect(store.list({ query: "reports" }).artifacts.map(r => r.artifactId).sort()).toEqual([first.artifactId, third.artifactId].sort());
    expect(store.list({ query: "chat" }).artifacts.map(r => r.artifactId)).toEqual([second.artifactId]);
    expect(store.list({ filter: "managed" }).artifacts.map(r => r.artifactId).sort()).toEqual([first.artifactId, third.artifactId].sort());
    expect(store.list({ filter: "document" }).artifacts.map(r => r.artifactId)).toEqual([second.artifactId]);
    expect(store.list({ origin: "chat" }).artifacts.map(r => r.artifactId)).toEqual([second.artifactId]);
    expect(store.list({ origin: "/reports" }).artifacts.map(r => r.artifactId).sort()).toEqual([first.artifactId, third.artifactId].sort());

    // Junk cursor fails validation; deleted anchor fails with conflict.
    expect(() => store.list({ cursor: "!!!not-a-token|||" })).toThrow(/cursor/);
    expect(() => store.list({ cursor: Buffer.from(JSON.stringify({ v: 2, s: "recent", id: "not-a-uuid" }), "utf8").toString("base64url") })).toThrow(/cursor id/);
    const deletedAnchor = store.list({ limit: 1 }).nextCursor!;
    store.deleteArtifact({ artifactId: pinned.artifactId, expectedGeneration: pinned.generation });
    expect(() => store.list({ cursor: deletedAnchor })).toThrow(/expired/);
  });
  it("stores, replaces, validates, and reads binary raster thumbnails with polarity fallback and stale detection", () => {
    const store = open();
    const record = keep(store, managed(), source("thumb"));
    const png1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const png2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8]);
    const jpg1 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 10, 11]);

    // Bad magic or oversize fails validation.
    expect(() => store.saveThumbnail({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, dark: true, mime: "image/png", bytes: new Uint8Array([1, 2, 3]) })).toThrow(/mime/);
    expect(() => store.saveThumbnail({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, dark: true, mime: "image/png", bytes: new Uint8Array(128 * 1024 + 1) })).toThrow(/bounds/);

    // Save dark thumbnail without bumping generation or updatedAt.
    const savedDark1 = store.saveThumbnail({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, dark: true, mime: "image/png", bytes: png1 });
    expect(savedDark1).not.toBeNull();
    const afterSave = store.describe({ artifactId: record.artifactId });
    expect(afterSave.artifact.generation).toBe(record.generation);
    expect(afterSave.artifact.updatedAt).toBe(record.updatedAt);
    expect(afterSave.thumbnails.dark).toEqual({ hash: savedDark1!.hash, stale: false });
    expect(afterSave.thumbnails.light).toBeNull();

    // Light request falls back to dark polarity when light slot is absent.
    const fallback = store.readThumbnail({ artifactId: record.artifactId, dark: false });
    expect(fallback).toMatchObject({ mime: "image/png", dark: true, stale: false, hash: savedDark1!.hash });
    expect(Buffer.from(fallback!.base64, "base64")).toEqual(Buffer.from(png1));

    // Atomic same-polarity replacement swaps hash and keeps light intact.
    const savedLight = store.saveThumbnail({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, dark: false, mime: "image/jpeg", bytes: jpg1 });
    const savedDark2 = store.saveThumbnail({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, dark: true, mime: "image/png", bytes: png2 });
    expect(savedDark2!.hash).not.toBe(savedDark1!.hash);
    expect(store.readThumbnail({ artifactId: record.artifactId, dark: true })?.hash).toBe(savedDark2!.hash);
    expect(store.readThumbnail({ artifactId: record.artifactId, dark: false })?.hash).toBe(savedLight!.hash);

    // Advancing head marks existing thumbnails stale and refuses saving against superseded heads.
    const moved = store.patchUserState({ artifactId: record.artifactId, expectedCodeRevisionId: record.currentCodeRevisionId, expectedDataSnapshotId: record.currentDataSnapshotId, expectedStateRevision: 0, set: { checked: true } });
    expect(store.readThumbnail({ artifactId: record.artifactId, dark: true })?.stale).toBe(true);
    expect(store.describe({ artifactId: record.artifactId }).thumbnails.dark?.stale).toBe(true);
    expect(store.saveThumbnail({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, dark: true, mime: "image/png", bytes: png1 })).toBeNull();
    const refreshed = store.saveThumbnail({ artifactId: record.artifactId, codeRevisionId: moved.currentCodeRevisionId, dataSnapshotId: moved.currentDataSnapshotId, dark: true, mime: "image/png", bytes: png1 });
    expect(refreshed).not.toBeNull();
    expect(store.readThumbnail({ artifactId: record.artifactId, dark: true })?.stale).toBe(false);
  });
  it("discards unapplied captures, refuses applied ones, and auto-dismisses emptied requests", () => {
    const store = open(); const original = keep(store);
    const refresh = store.prepareRefresh({ artifactId: original.artifactId, codeRevisionId: original.currentCodeRevisionId, dataSnapshotId: original.currentDataSnapshotId, targetTabId: "tab-a", datasetIds: ["rows"] });
    store.bindRefresh({ refreshRequestId: refresh.refreshRequestId, targetTabId: "tab-a", lineageDir: "/trusted/project", runtimeKey, sessionId });
    const staged = store.stageCapture({ refreshRequestId: refresh.refreshRequestId, targetTabId: "tab-a", lineageDir: "/trusted/project", runtimeKey, sessionId, source: source(), datasets: [{ id: "rows", title: "Rows", schema: "rows-v1", value: [{ n: 2 }], provenance: provenance() }] });
    expect(store.readRefresh({ refreshRequestId: refresh.refreshRequestId }).status).toBe("captured");
    store.discardCapture({ captureId: staged.captureId });
    // The request had zero remaining captures, so it fell through to dismissed.
    expect(store.readRefresh({ refreshRequestId: refresh.refreshRequestId }).status).toBe("dismissed");
    // A late re-capture for a dismissed request fails closed.
    expect(() => store.stageCapture({ refreshRequestId: refresh.refreshRequestId, targetTabId: "tab-a", lineageDir: "/trusted/project", runtimeKey, sessionId, source: source(), datasets: [{ id: "rows", title: "Rows", schema: "rows-v1", value: [{ n: 3 }], provenance: provenance() }] })).toThrow(/dismissed/);
    // An applied capture refuses discard.
    const refresh2 = store.prepareRefresh({ artifactId: original.artifactId, codeRevisionId: original.currentCodeRevisionId, dataSnapshotId: original.currentDataSnapshotId, targetTabId: "tab-b", datasetIds: ["notes"] });
    store.bindRefresh({ refreshRequestId: refresh2.refreshRequestId, targetTabId: "tab-b", lineageDir: "/trusted/project", runtimeKey, sessionId });
    const staged2 = store.stageCapture({ refreshRequestId: refresh2.refreshRequestId, targetTabId: "tab-b", lineageDir: "/trusted/project", runtimeKey, sessionId, source: source(), datasets: [{ id: "notes", title: "Notes", schema: "notes-v1", value: ["fresh"], provenance: provenance() }] });
    store.applyCapture({ captureId: staged2.captureId, expectedCodeRevisionId: original.currentCodeRevisionId, expectedDatasetHeads: refresh2.expectedDatasetHeads });
    expect(() => store.discardCapture({ captureId: staged2.captureId })).toThrow(/applied/);
  });
  it("dismisses awaiting requests, refuses captured/applied ones, and fences late captures", () => {
    const store = open(); const original = keep(store);
    const refresh = store.prepareRefresh({ artifactId: original.artifactId, codeRevisionId: original.currentCodeRevisionId, dataSnapshotId: original.currentDataSnapshotId, targetTabId: "tab-a", datasetIds: ["rows"] });
    expect(() => store.dismissRefreshRequest({ refreshRequestId: refresh.refreshRequestId })).not.toThrow();
    expect(store.readRefresh({ refreshRequestId: refresh.refreshRequestId }).status).toBe("dismissed");
    const live = store.prepareRefresh({ artifactId: original.artifactId, codeRevisionId: original.currentCodeRevisionId, dataSnapshotId: original.currentDataSnapshotId, targetTabId: "tab-d", datasetIds: ["notes"] });
    store.bindRefresh({ refreshRequestId: live.refreshRequestId, targetTabId: "tab-d", lineageDir: "/trusted/project", runtimeKey, sessionId });
    const staged = store.stageCapture({ refreshRequestId: live.refreshRequestId, targetTabId: "tab-d", lineageDir: "/trusted/project", runtimeKey, sessionId, source: source(), datasets: [{ id: "notes", title: "Notes", schema: "notes-v1", value: ["later"], provenance: provenance() }] });
    // captured refuses dismiss; applied refuses both.
    expect(() => store.dismissRefreshRequest({ refreshRequestId: live.refreshRequestId })).toThrow(/awaiting/);
    const appliedRecord = store.applyCapture({ captureId: staged.captureId, expectedCodeRevisionId: original.currentCodeRevisionId, expectedDatasetHeads: live.expectedDatasetHeads });
    expect(store.readRefresh({ refreshRequestId: live.refreshRequestId }).status).toBe("applied");
    expect(() => store.dismissRefreshRequest({ refreshRequestId: live.refreshRequestId })).toThrow(/applied/);
    expect(appliedRecord.generation).toBeGreaterThan(original.generation);
  });
  it("restores an old snapshot as a new head with cause restore and fences in-flight captures", () => {
    const store = open(); const record = keep(store);
    const firstHead = record.currentDataSnapshotId;
    const edited = store.patchUserState({ artifactId: record.artifactId, expectedCodeRevisionId: record.currentCodeRevisionId, expectedDataSnapshotId: firstHead, expectedStateRevision: 0, set: { filter: "manual" } });
    expect(snapshot(store, edited).userState.filter).toBe("manual");
    const refresh = store.prepareRefresh({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: edited.currentDataSnapshotId, targetTabId: "tab-a", datasetIds: ["rows"] });
    store.bindRefresh({ refreshRequestId: refresh.refreshRequestId, targetTabId: "tab-a", lineageDir: "/trusted/project", runtimeKey, sessionId });
    const restored = store.restoreSnapshot({ artifactId: record.artifactId, dataSnapshotId: firstHead, expectedCodeRevisionId: record.currentCodeRevisionId });
    expect(restored.currentDataSnapshotId).not.toBe(firstHead);
    expect(restored.currentDataSnapshotId).not.toBe(edited.currentDataSnapshotId);
    expect(snapshot(store, restored).userState.filter).toBe("all"); // the old values won the head
    expect(store.readSnapshot({ artifactId: record.artifactId, dataSnapshotId: firstHead }).cause).toBe("initial"); // append-only: the old snapshot stays
    expect(store.describe({ artifactId: record.artifactId }).snapshots.find(row => row.dataSnapshotId === restored.currentDataSnapshotId)?.cause).toBe("restore");
    // Restore minted fresh dataset heads, so the in-flight capture fails closed at staging.
    expect(() => store.stageCapture({ refreshRequestId: refresh.refreshRequestId, targetTabId: "tab-a", lineageDir: "/trusted/project", runtimeKey, sessionId, source: source(), datasets: [{ id: "rows", title: "Rows", schema: "rows-v1", value: [{ n: 7 }], provenance: provenance() }] })).toThrow(/changed/);
    expect(() => store.restoreSnapshot({ artifactId: record.artifactId, dataSnapshotId: randomUUID(), expectedCodeRevisionId: record.currentCodeRevisionId })).toThrow();
  });
  it("prunes only excluded-otherwise history and always spares every referenced version", () => {
    const store = open(); let record = keep(store);
    // A refresh is bound to the then-current snapshot; growing newer snapshots afterwards makes that referenced snapshot OLD, which prune must still spare.
    const oldRefresh = store.prepareRefresh({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, targetTabId: "tab-a", datasetIds: ["rows"] });
    for (let n = 0; n < 4; n++) record = store.patchUserState({ artifactId: record.artifactId, expectedCodeRevisionId: record.currentCodeRevisionId, expectedDataSnapshotId: record.currentDataSnapshotId, expectedStateRevision: record.generation - 1, set: { round: n } });
    const grant = store.createReference({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, includeData: true });
    const before = store.describe({ artifactId: record.artifactId });
    expect(before.snapshots).toHaveLength(5);
    const result = store.prune({ artifactId: record.artifactId, expectedGeneration: record.generation, keepRevisions: 1, keepSnapshots: 1 });
    expect(result.removedRevisions).toBe(0); // only one revision exists; nothing deletable
    const after = store.describe({ artifactId: record.artifactId });
    // keepSnapshots=1 keeps the head; the old refresh-referenced snapshot and the grant snapshot survive; the three middle history snapshots go.
    expect(result.removedSnapshots).toBe(3);
    expect(before.snapshots.length - after.snapshots.length).toBe(result.removedSnapshots);
    expect(after.snapshots.some(row => row.dataSnapshotId === oldRefresh.dataSnapshotId)).toBe(true);
    expect(after.snapshots.some(row => row.dataSnapshotId === grant.dataSnapshotId)).toBe(true);
    expect(after.snapshots.some(row => row.dataSnapshotId === after.artifact.currentDataSnapshotId)).toBe(true);
    expect(result.freedLogicalBytes).toBeGreaterThan(0);
    expect(() => store.prune({ artifactId: record.artifactId, expectedGeneration: 424242, keepRevisions: 1, keepSnapshots: 1 })).toThrow(/changed/);
    expect(() => store.prune({ artifactId: record.artifactId, expectedGeneration: after.artifact.generation, keepRevisions: 0, keepSnapshots: 5 })).toThrow(/keepRevisions/);
    // Pruning never moves heads: history-only.
    expect(store.describe({ artifactId: record.artifactId }).artifact.currentDataSnapshotId).toBe(after.artifact.currentDataSnapshotId);
    // The pruned-away snapshots are gone and reads of survivors still work.
    const removed = before.snapshots.map(row => row.dataSnapshotId).filter(id => !after.snapshots.some(row => row.dataSnapshotId === id));
    expect(removed).toHaveLength(result.removedSnapshots);
    for (const id of removed) expect(() => store.readSnapshot({ artifactId: record.artifactId, dataSnapshotId: id })).toThrow();
    for (const id of after.snapshots.map(row => row.dataSnapshotId)) expect(() => store.readSnapshot({ artifactId: record.artifactId, dataSnapshotId: id })).not.toThrow();
  });

  it("records autoApply and scheduledBy only when asked and answers hasPreparedRefreshFor (ADR-0101)", () => {
    const store = open(); const record = keep(store);
    const plain = store.prepareRefresh({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, targetTabId: "tab-plain", datasetIds: ["rows"] });
    expect("autoApply" in plain).toBe(false); expect("scheduledBy" in plain).toBe(false);
    const scheduled = store.prepareRefresh({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, targetTabId: "tab-routine", datasetIds: ["rows"], autoApply: true, scheduledBy: "Nightly" });
    expect(scheduled.autoApply).toBe(true); expect(scheduled.scheduledBy).toBe("Nightly");
    const falsey = store.prepareRefresh({ artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId, targetTabId: "tab-false", datasetIds: ["rows"], autoApply: false });
    expect("autoApply" in falsey).toBe(false);
    expect(store.hasPreparedRefreshFor({ targetTabId: "tab-plain" })).toBe(true);
    expect(store.hasPreparedRefreshFor({ targetTabId: "tab-routine" })).toBe(true);
    expect(store.hasPreparedRefreshFor({ targetTabId: "tab-none" })).toBe(false);
  });
});
