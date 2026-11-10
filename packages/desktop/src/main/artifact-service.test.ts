import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseHtmlArtifactArgs, withArtifactReferenceContext, withArtifactRefreshContext, type ArtifactJson, type ArtifactLibraryChanged, type ArtifactRecord, type ArtifactReference } from "@omp-ui/core";
import { ArtifactService, type ArtifactTarget } from "./artifact-service";
import { artifactSourceHash } from "./artifact-source";
import { readArtifactDatasetFile } from "./artifact-dataset-file";
import { HostBridge } from "./host-bridge";

const cleanups: (() => void)[] = [];
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_KEY = "22222222-2222-4222-8222-222222222222";
const REFRESH_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const REFRESH_RUNTIME_KEY = "44444444-4444-4444-8444-444444444444";
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(initiallyEnabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-service-"));
  const owner = randomUUID(); let enabled = initiallyEnabled; let currentOwner: string = owner;
  const lineageDir = path.join(root, "lineage"); fs.mkdirSync(lineageDir);
  let target: ArtifactTarget = { ownerInstanceId: owner, lineageDir, sessionId: SESSION_ID, runtimeKey: RUNTIME_KEY, native: true, originContext: { kind: "chat" } };
  const events: ArtifactLibraryChanged[] = [];
  let sourcePath: (tabId: string) => Promise<string | null> = async () => path.join(lineageDir, "session.jsonl");
  const options = { registryFile: path.join(root, "registry.json"), artifactsRoot: path.join(root, "artifacts"), ownerInstanceId: () => currentOwner,
    enabled: () => enabled, scriptsEnabled: () => true, resolveTarget: () => target, sourcePath: (tabId: string) => sourcePath(tabId),
    sources: () => [{ lineageDir }], onChanged: (event: ArtifactLibraryChanged) => events.push(event) };
  let service = new ArtifactService(options);
  cleanups.push(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, owner, lineageDir, events, get service() { return service; }, get target() { return target; }, setTarget(next: ArtifactTarget) { target = next; },
    setOwner(next: string) { currentOwner = next; }, setSourcePath(next: (tabId: string) => Promise<string | null>) { sourcePath = next; },
    setEnabled(on: boolean) { enabled = on; service.setEnabled(on); }, restart() { service.close(); service = new ArtifactService(options); } };
}
function dataset(value: ArtifactJson = [1, 2]) {
  return { id: "rows", title: "Rows", schema: "rows-v1", value, provenance: {
    source: { kind: "file", label: "Report", locator: "/reports/rows.csv" }, method: { kind: "import", description: "Read CSV", parameters: { delimiter: "," } },
    capturedAt: "2026-11-08T00:00:00.000Z", refresh: { kind: "session", instructions: "Read /reports/rows.csv", requiredSources: ["/reports/rows.csv"] },
  } };
}
function args(value: ArtifactJson = [1, 2]) {
  return { title: "Rows", html: "<main>Rows</main>", artifact: { protocolVersion: 1, stateSchema: "view-v1", initialState: { selected: 1 }, datasets: [dataset(value)] } };
}
async function keep(f: { service: ArtifactService }, value: ArtifactJson = [1, 2]) {
  const draft = await f.service.stageRender({ tabId: "tab", toolCallId: randomUUID(), args: args(value) });
  return f.service.keep({ draftId: draft.draftId, title: "My rows" });
}
function versions(record: ArtifactRecord) { return { artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId }; }
function wire(reference: ArtifactReference, text = "Use this context") { return withArtifactReferenceContext(text, [reference]); }
function refreshWire(prepared: { request: { refreshRequestId: string; artifactId: string }; reference: ArtifactReference }, text = "Use this context") {
  return withArtifactRefreshContext(wire(prepared.reference, text), [{ version: 1 as const, refreshRequestId: prepared.request.refreshRequestId, artifactId: prepared.request.artifactId, title: "T", datasetIds: ["rows"] }]);
}
function fileArgs(valueFile = "local://rows.json") {
  const rendered = args(); const { value: _value, ...definition } = rendered.artifact.datasets[0]!;
  return { ...rendered, artifact: { ...rendered.artifact, datasets: [{ ...definition, valueFile }] } };
}
function nativeTranscript(f: { lineageDir: string; target: ArtifactTarget }): string {
  const stem = `2026-11-09T00-00-00-000Z_${f.target.sessionId}`;
  const file = path.join(f.lineageDir, `${stem}.jsonl`);
  fs.mkdirSync(path.join(f.lineageDir, stem, "local"), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: f.target.sessionId })}\n`);
  return file;
}
async function materialize(raw: unknown, localRoot: string, context: { signal: AbortSignal; authorize(): void }) {
  const parsed = parseHtmlArtifactArgs(raw); if (!parsed.ok) throw new Error(parsed.reason);
  const artifact = parsed.args.artifact; if (artifact === undefined) return raw;
  const datasets = [];
  for (const dataset of artifact.datasets) {
    if (typeof dataset.valueFile === "string") {
      const { valueFile, ...inline } = dataset;
      const value = await readArtifactDatasetFile(localRoot, valueFile, context);
      datasets.push({ ...inline, value });
    } else datasets.push(dataset);
  }
  return { ...raw as Record<string, unknown>, artifact: { ...artifact, datasets } };
}

describe("main-owned artifact authority", () => {
  it("creates no storage while disabled; legacy HTML still answers without artifact details", async () => {
    const f = fixture(false);
    expect(() => f.service.list()).toThrow("disabled");
    f.service.dropDraftsForLineage(f.lineageDir);
    expect(fs.existsSync(path.join(f.root, "artifacts"))).toBe(false);
    const sent: unknown[] = [];
    const bridge = new HostBridge({ readPlanFile: async () => ({ ok: false, reason: "unreadable" }), planSnapshot: () => null,
      planRoot: () => f.lineageDir, notify: () => "posted", capabilitySessionId: () => null, log: () => {}, artifacts: f.service });
    bridge.route("tab", { type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: "native-id", name: "omp-ui_render_html", arguments: {} }] } }, frame => sent.push(frame));
    bridge.route("tab", { type: "host_tool_call", id: "answer-id", toolCallId: "native-id", toolName: "omp-ui_render_html", arguments: { title: "Plain", html: "<b>plain</b>" } }, frame => sent.push(frame));
    await Promise.resolve();
    expect(sent[0]).toMatchObject({ id: "answer-id", type: "host_tool_result" });
    expect(sent[0]).not.toHaveProperty("result.details.artifactDraft");
    expect(fs.existsSync(path.join(f.root, "artifacts"))).toBe(false);
  });

  it("stages before success and preserves native tool identity, including missing native IDs", async () => {
    const f = fixture(); const sent: unknown[] = [];
    const bridge = new HostBridge({ readPlanFile: async () => ({ ok: false, reason: "unreadable" }), planSnapshot: () => null,
      planRoot: () => f.lineageDir, notify: () => "posted", capabilitySessionId: () => null, log: () => {}, artifacts: f.service });
    bridge.route("tab", { type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: "native-tool-id", name: "omp-ui_render_html", arguments: {} }] } }, frame => sent.push(frame));
    bridge.route("tab", { type: "host_tool_call", id: "transport-answer-id", toolCallId: "native-tool-id", toolName: "omp-ui_render_html", arguments: args() }, frame => sent.push(frame));
    await Promise.resolve();
    const result = sent[0] as { result: { details: { artifactDraft: { draftId: string; sourceHash: string } } } };
    const draft = result.result.details.artifactDraft;
    expect(await f.service.resolveSource({ tabId: "tab", sessionId: f.target.sessionId, toolCallId: "native-tool-id", ...draft })).toMatchObject({ status: "draft", draft: { source: { toolCallId: "native-tool-id" } } });
    const absent = await f.service.stageRender({ tabId: "tab", toolCallId: null, args: { ...args(), title: "Missing ID" } });
    expect(absent.source.toolCallId).toBeNull();
    const loaded = f.service.resolveSurface({ draftId: absent.draftId });
    expect(loaded.datasets.rows!.provenance).toMatchObject({ captureToolCallId: null, captureSessionId: SESSION_ID, trust: "agent-reported" });
    expect(loaded.datasets.rows!.provenance.recordedAt).toBe(absent.source.createdAt);
  });

  it("Keeps idempotently and resolves retained source associations after Keep and explicit deletion", async () => {
    const f = fixture(); const rendered = args();
    const draft = await f.service.stageRender({ tabId: "tab", toolCallId: "tool", args: rendered });
    const kept = f.service.keep({ draftId: draft.draftId, title: "Accepted" });
    expect(f.service.keep({ draftId: draft.draftId, title: "Different title" })).toEqual(kept);
    const source = { tabId: "tab", sessionId: f.target.sessionId, toolCallId: "tool", sourceHash: artifactSourceHash(rendered), draftId: draft.draftId };
    expect(await f.service.resolveSource(source)).toMatchObject({ status: "kept", artifact: { artifactId: kept.artifactId } });
    f.service.delete({ artifactId: kept.artifactId, expectedGeneration: kept.generation });
    expect(await f.service.resolveSource(source)).toEqual({ status: "deleted", artifactId: kept.artifactId });
  });

  it("retains pre-Keep acknowledged edits, rejects stale draft CAS and fences disabled commits", async () => {
    const f = fixture();
    const draft = await f.service.stageRender({ tabId: "tab", toolCallId: "draft", args: args() });
    const surface = f.service.resolveSurface({ draftId: draft.draftId });
    const receipt = f.service.saveBoundState(surface.binding, { expectedStateRevision: 0, set: { selected: 2 } }, () => {});
    expect(receipt.stateRevision).toBe(1);
    expect(receipt.dataSnapshotId).toMatch(/^[a-f0-9-]{36}$/);
    expect(() => f.service.saveBoundState(surface.binding, { expectedStateRevision: 0, set: { selected: 3 } }, () => {})).toThrow();
    const kept = f.service.keep({ draftId: draft.draftId, title: "Edited" });
    const accepted = f.service.resolveSurface(versions(kept)); expect(accepted.state).toEqual({ selected: 2 });
    let calls = 0;
    expect(() => f.service.saveBoundState(accepted.binding, { expectedStateRevision: accepted.stateRevision, set: { selected: 99 } }, () => {
      if (++calls === 2) f.setEnabled(false);
    })).toThrow();
    f.setEnabled(true);
    expect(f.service.resolveSurface(versions(kept)).state).toEqual({ selected: 2 });
  });

  it("uses exact immutable read grants across restart, preserves consent, and pages multibyte text", async () => {
    const f = fixture(); const kept = await keep(f, "한🙂".repeat(30_000));
    const reference = f.service.reference({ targetTabId: "tab", ...versions(kept), includeData: true });
    const definitionOnly = f.service.reference({ targetTabId: "tab", ...versions(kept), includeData: false });
    f.service.admitPrompt({ tabId: "tab", text: wire(reference) });
    expect(() => f.service.admitPrompt({ tabId: "tab", text: wire({ ...definitionOnly, includeData: true }) })).toThrow("immutable");
    expect(() => f.service.readHostUri({ tabId: "tab", url: definitionOnly.manifestUri.replace("manifest", "state") })).toThrow();
    f.restart();
    let offset = 0; let text = "";
    for (;;) {
      const page = JSON.parse(f.service.readHostUri({ tabId: "tab", url: `${reference.manifestUri.replace("manifest", "dataset/rows")}?offset=${offset}&limit=65536` })) as { text: string; nextOffset: number | null };
      text += page.text; if (page.nextOffset === null) break; offset = page.nextOffset;
    }
    expect(JSON.parse(text)).toBe("한🙂".repeat(30_000));
    expect(() => f.service.readHostUri({ tabId: "tab", url: `${reference.manifestUri}?limit=999999` })).toThrow();
    f.setTarget({ ...f.target, ownerInstanceId: randomUUID(), machine: "Other machine" });
    expect(() => f.service.reference({ targetTabId: "tab", ...versions(kept), includeData: true })).toThrow("machine");
  });

  it("binds refresh only on actual send, supports unmaterialized targets, and applies only human-authorized data", async () => {
    const f = fixture(); const kept = await keep(f);
    f.setTarget({ ...f.target, sessionId: null, runtimeKey: REFRESH_RUNTIME_KEY });
    const refresh = f.service.prepareRefresh({ targetTabId: "tab", ...versions(kept), datasetIds: ["rows"] });
    expect(refresh.request.sessionId).toBeNull();
    f.service.admitPrompt({ tabId: "tab", text: refreshWire(refresh) });
    f.setTarget({ ...f.target, sessionId: REFRESH_SESSION_ID });
    const capture = f.service.stageCapture({ tabId: "tab", toolCallId: "capture-native", args: { status: "captured", refreshRequestId: refresh.request.refreshRequestId, datasets: [dataset([3, 4])] } });
    if (capture.status !== "captured") throw new Error("Expected a staged capture");
    expect(f.service.resolveSurface(versions(kept)).datasets.rows!.value).toEqual([1, 2]);
    const changed = f.service.applyCapture({ captureId: capture.captureId, expectedCodeRevisionId: kept.currentCodeRevisionId, expectedDatasetHeads: capture.expectedDatasetHeads });
    expect(f.service.resolveSurface(versions(changed)).datasets.rows!.value).toEqual([3, 4]);
    expect(() => f.service.applyCapture({ captureId: capture.captureId, expectedCodeRevisionId: kept.currentCodeRevisionId, expectedDatasetHeads: capture.expectedDatasetHeads })).toThrow();
  });

  it("retains current working data when accepting a compatible revision and rejects stale candidates", async () => {
    const f = fixture(); const kept = await keep(f);
    const reference = f.service.reference({ targetTabId: "tab", ...versions(kept), includeData: true });
    const candidate = await f.service.stageRender({ tabId: "tab", toolCallId: "revision", args: { ...args([99]), html: "<main>Revised</main>", artifact: { ...args([99]).artifact, basedOn: { referenceId: reference.referenceId } } } });
    const surface = f.service.resolveSurface(versions(kept));
    const receipt = f.service.saveBoundState(surface.binding, { expectedStateRevision: surface.stateRevision, set: { selected: 7 } }, () => {});
    const revised = f.service.acceptRevision({ draftId: candidate.draftId, expectedCodeRevisionId: kept.currentCodeRevisionId });
    expect(revised.currentDataSnapshotId).toBe(receipt.dataSnapshotId);
    expect(f.service.resolveSurface(versions(revised)).state.selected).toBe(7);
    expect(f.service.resolveSurface(versions(revised)).datasets.rows!.value).toEqual([1, 2]);
    const stale = await f.service.stageRender({ tabId: "tab", toolCallId: "stale", args: { ...args(), artifact: { ...args().artifact, basedOn: { referenceId: reference.referenceId } } } });
    expect(() => f.service.acceptRevision({ draftId: stale.draftId, expectedCodeRevisionId: revised.currentCodeRevisionId })).toThrow();
  });

  it("cleans existing drafts while disabled without deleting accepted histories or creating absent stores", async () => {
    const f = fixture(); const kept = await keep(f);
    const discarded = await f.service.stageRender({ tabId: "tab", toolCallId: "unkept", args: { title: "Plain draft", html: "<p>plain</p>" } });
    f.setEnabled(false); f.service.dropDraftsForLineage(f.lineageDir); f.setEnabled(true);
    expect(f.service.describe({ artifactId: kept.artifactId }).artifact.artifactId).toBe(kept.artifactId);
    expect(() => f.service.resolveSurface({ draftId: discarded.draftId })).toThrow();
  });

  it("imports only the exact successful native transcript source without caller HTML authority", async () => {
    const f = fixture(); const authored = { title: "Historical", html: "<p>main-owned bytes</p>" };
    const file = path.join(f.lineageDir, "session.jsonl");
    fs.writeFileSync(file, [
      { type: "session", id: f.target.sessionId },
      { type: "message", timestamp: "2026-11-09T01:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "native-historic", name: "omp-ui_render_html", arguments: authored }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "native-historic", toolName: "omp-ui_render_html", isError: false, content: [] } },
    ].map(row => JSON.stringify(row)).join("\n"));
    const found = await f.service.resolveSource({ tabId: "tab", sessionId: f.target.sessionId, toolCallId: "native-historic", sourceHash: artifactSourceHash(authored) });
    expect(found.status).toBe("draft");
    if (found.status !== "draft") throw new Error("Expected historical draft");
    expect(f.service.resolveSurface({ draftId: found.draft.draftId }).html).toBe(authored.html);
    await expect(f.service.resolveSource({ tabId: "tab", sessionId: f.target.sessionId, toolCallId: "native-historic", sourceHash: artifactSourceHash({ ...authored, html: "forged" }) })).rejects.toThrow("arguments");
  });

  it("requires main materialization and an existing native transcript for file references", async () => {
    const f = fixture();
    await expect(f.service.stageRender({ tabId: "tab", toolCallId: "no-materializer", args: fileArgs() })).rejects.toThrow("materialization");
    f.setSourcePath(async () => null);
    await expect(f.service.stageRender({ tabId: "tab", toolCallId: "no-transcript", args: fileArgs(),
      materialize: async () => args() })).rejects.toMatchObject({ code: "source-missing" });
    expect(fs.existsSync(path.join(f.root, "artifacts"))).toBe(false);
  });

  it("keys durable imported values by raw identity and never rereads them after Keep and reopen", async () => {
    const f = fixture(); const transcript = nativeTranscript(f); f.setSourcePath(async () => transcript); const rendered = fileArgs(); let importedFile = "";
    const draft = await f.service.stageRender({ tabId: "tab", toolCallId: "native-file-import", args: rendered,
      materialize: async (raw, localRoot, context) => {
        fs.mkdirSync(localRoot, { recursive: true }); importedFile = path.join(localRoot, "rows.json");
        fs.writeFileSync(importedFile, JSON.stringify([1, 2]));
        return materialize(raw, localRoot, context);
      } });
    expect(draft.source.sourceHash).toBe(artifactSourceHash(rendered));
    expect(draft.source.sourceHash).not.toBe(artifactSourceHash(args()));
    expect(f.service.resolveSurface({ draftId: draft.draftId }).datasets.rows!.value).toEqual([1, 2]);
    const kept = f.service.keep({ draftId: draft.draftId, title: "Imported rows" });
    let sourceReads = 0; f.setSourcePath(async () => { sourceReads++; return transcript; });
    const source = { tabId: "tab", sessionId: f.target.sessionId, toolCallId: "native-file-import", sourceHash: draft.source.sourceHash, draftId: draft.draftId };
    f.restart(); fs.writeFileSync(importedFile, JSON.stringify([99]));
    const { draftId: _draftId, ...rawSource } = source;
    expect(await f.service.resolveSource(rawSource)).toMatchObject({ status: "kept", artifact: { artifactId: kept.artifactId } });
    expect(await f.service.resolveSource(source)).toMatchObject({ status: "kept", artifact: { artifactId: kept.artifactId } });
    expect(f.service.resolveSurface(versions(kept)).datasets.rows!.value).toEqual([1, 2]);
    fs.rmSync(importedFile); fs.rmSync(transcript); f.restart();
    expect(await f.service.resolveSource(source)).toMatchObject({ status: "kept", artifact: { artifactId: kept.artifactId } });
    expect(f.service.resolveSurface(versions(kept)).datasets.rows!.value).toEqual([1, 2]);
    expect(sourceReads).toBe(0);
  });

  it("validates depth across the resolved envelope before creating storage", async () => {
    const f = fixture(); const transcript = nativeTranscript(f); f.setSourcePath(async () => transcript); let deep: ArtifactJson = "leaf";
    for (let depth = 0; depth < 70; depth++) deep = { nested: deep };
    await expect(f.service.stageRender({ tabId: "tab", toolCallId: "deep-file", args: fileArgs(),
      materialize: async () => args(deep) })).rejects.toThrow(/depth/i);
    expect(fs.existsSync(path.join(f.root, "artifacts"))).toBe(false);
  });

  it("applies the aggregate limit to mixed inline and materialized datasets", async () => {
    const f = fixture(); const transcript = nativeTranscript(f); f.setSourcePath(async () => transcript); const size = 7 * 1024 * 1024;
    const inline = [0, 1, 2, 3].map(index => ({ ...dataset("x".repeat(size)), id: `inline${index}` }));
    const rendered = fileArgs(); const mixed = { ...rendered, artifact: { ...rendered.artifact, datasets: [...inline, rendered.artifact.datasets[0]!] } };
    await expect(f.service.stageRender({ tabId: "tab", toolCallId: "mixed-file", args: mixed,
      materialize: async (raw, localRoot, context) => {
        fs.mkdirSync(localRoot, { recursive: true }); fs.writeFileSync(path.join(localRoot, "rows.json"), JSON.stringify("y".repeat(size)));
        return materialize(raw, localRoot, context);
      } })).rejects.toThrow(/total/i);
    expect(fs.existsSync(path.join(f.root, "artifacts"))).toBe(false);
  });

  it("does not reconstruct a missing file-backed association from transcript history", async () => {
    const f = fixture(); const authored = fileArgs();
    const file = path.join(f.lineageDir, "session.jsonl");
    fs.writeFileSync(file, [
      { type: "session", id: f.target.sessionId },
      { type: "message", timestamp: "2026-11-09T01:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "native-file-backed", name: "omp-ui_render_html", arguments: authored }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "native-file-backed", toolName: "omp-ui_render_html", isError: false, content: [] } },
    ].map(row => JSON.stringify(row)).join("\n"));
    const request = { tabId: "tab", sessionId: f.target.sessionId, toolCallId: "native-file-backed", sourceHash: artifactSourceHash(authored) };
    await expect(f.service.resolveSource(request)).rejects.toMatchObject({ code: "source-missing" });
    expect(f.service.list().artifacts).toEqual([]);
  });

  it.each(["target", "gate", "off-on", "owner", "availability", "request", "cancel"] as const)("creates no storage when %s authority changes during file admission", async (race) => {
    const f = fixture(); let admitted = true; let materialized = false;
    const waiting = Promise.withResolvers<string | null>();
    f.setSourcePath(() => waiting.promise);
    const pending = f.service.stageRender({ tabId: "tab", toolCallId: "file-race", args: fileArgs(),
      materialize: async () => { materialized = true; return args(); }, authorizeRequest: () => { if (!admitted) throw new Error("request cancelled"); } });
    if (race === "target") f.setTarget({ ...f.target, sessionId: REFRESH_SESSION_ID });
    if (race === "gate") f.setEnabled(false);
    if (race === "off-on") { f.setEnabled(false); f.setEnabled(true); }
    if (race === "owner") f.setOwner(randomUUID());
    if (race === "availability") f.setTarget({ ...f.target, artifactsAvailable: false, artifactError: "registration lost" });
    if (race === "request") admitted = false;
    if (race === "cancel") f.service.close();
    waiting.resolve(path.join(f.lineageDir, "session.jsonl"));
    await expect(pending).rejects.toThrow();
    expect(materialized).toBe(false);
    expect(fs.existsSync(path.join(f.root, "artifacts"))).toBe(false);
  });

  it("materializes initially-null native IDs only from an observed same-runtime header, including after Keep", async () => {
    const f = fixture(); f.setTarget({ ...f.target, sessionId: null });
    const draft = await f.service.stageRender({ tabId: "tab", toolCallId: null, args: args() });
    const kept = f.service.keep({ draftId: draft.draftId, title: "Early Keep" });
    expect(kept.origin.sessionId).toBeNull();
    f.setTarget({ ...f.target, sessionId: REFRESH_SESSION_ID });
    f.service.observeSource({ lineageDir: f.lineageDir, runtimeKey: RUNTIME_KEY, sessionId: REFRESH_SESSION_ID });
    expect(f.service.describe({ artifactId: kept.artifactId }).artifact.origin.sessionId).toBe(REFRESH_SESSION_ID);
    f.restart();
    expect(await f.service.resolveSource({ tabId: "tab", sessionId: REFRESH_SESSION_ID, toolCallId: null, draftId: draft.draftId, sourceHash: draft.source.sourceHash })).toMatchObject({ status: "kept", artifact: { artifactId: kept.artifactId } });
  });

  it("reconciles registry membership rather than file presence and retains accepted orphan histories", async () => {
    const f = fixture();
    const activeWithoutFile = await f.service.stageRender({ tabId: "tab", toolCallId: "active", args: { title: "Active", html: "active" } });
    f.setTarget({ ...f.target, lineageDir: path.join(f.root, "deleted-lineage"), sessionId: REFRESH_SESSION_ID });
    const unkept = await f.service.stageRender({ tabId: "tab", toolCallId: "deleted-draft", args: { title: "Unkept", html: "unkept" } });
    const accepted = await keep(f);
    f.setTarget({ ...f.target, lineageDir: f.lineageDir, sessionId: SESSION_ID });
    f.restart();
    expect(f.service.resolveSurface({ draftId: activeWithoutFile.draftId }).html).toBe("active");
    expect(() => f.service.resolveSurface({ draftId: unkept.draftId })).toThrow();
    expect(f.service.describe({ artifactId: accepted.artifactId }).artifact.artifactId).toBe(accepted.artifactId);
  });
});

describe("refresh failure and dormant admission", () => {
  it.each([
    { name: "captured without datasets", args: { status: "captured" } },
    { name: "captured with a null message", args: { status: "captured", datasets: [dataset([3, 4])], message: null } },
    { name: "failed without a message", args: { status: "failed" } },
    { name: "failed with null datasets", args: { status: "failed", message: "File unavailable", datasets: null } },
  ])("rejects $name without changing refresh or accepted data", async ({ args }) => {
    const f = fixture(); const kept = await keep(f);
    const prepared = f.service.prepareRefresh({ targetTabId: "tab", ...versions(kept), datasetIds: ["rows"] });
    f.service.admitPrompt({ tabId: "tab", text: refreshWire(prepared) });
    const baseline = f.service.describe({ artifactId: kept.artifactId });
    const baselineSurface = f.service.resolveSurface(versions(baseline.artifact));
    expect(baseline.refreshRequests[0]).toMatchObject({ refreshRequestId: prepared.request.refreshRequestId, bound: true, status: "awaiting" });

    expect(() => f.service.stageCapture({ tabId: "tab", toolCallId: "invalid-capture", args: { ...args, refreshRequestId: prepared.request.refreshRequestId } }))
      .toThrowError(expect.objectContaining({ code: "unsupported-contract" }));

    const current = f.service.describe({ artifactId: kept.artifactId });
    expect(current.refreshRequests).toEqual(baseline.refreshRequests);
    expect(current.refreshRequests[0]).toMatchObject({ status: "awaiting" });
    expect(current.captures).toEqual(baseline.captures);
    expect(current.artifact.currentCodeRevisionId).toBe(baseline.artifact.currentCodeRevisionId);
    expect(current.artifact.currentDataSnapshotId).toBe(baseline.artifact.currentDataSnapshotId);
    expect(current.snapshot.datasets).toEqual(baseline.snapshot.datasets);
    expect(f.service.resolveSurface(versions(current.artifact)).datasets).toEqual(baselineSurface.datasets);
  });

  it("preflights dormant drafts without binding, then records destination-bound failure without moving accepted data", async () => {
    const f = fixture(); const kept = await keep(f);
    f.setTarget({...f.target, runtimeKey: null});
    const prepared = f.service.prepareRefresh({targetTabId: "tab", ...versions(kept), datasetIds: ["rows"]});
    const text = refreshWire(prepared);
    f.service.admitPrompt({tabId: "tab", text, bindRefresh: false});
    expect(f.service.describe({artifactId: kept.artifactId}).refreshRequests[0]).toMatchObject({bound: false, status: "awaiting"});
    f.setTarget({...f.target, runtimeKey: REFRESH_RUNTIME_KEY});
    f.service.admitPrompt({tabId: "tab", text});
    f.setTarget({...f.target, sessionId: REFRESH_SESSION_ID});
    expect(() => f.service.stageCapture({tabId: "tab", toolCallId: "wrong", args: {status: "failed", refreshRequestId: prepared.request.refreshRequestId, message: "File unavailable"}})).toThrow();
    f.setTarget({...f.target, sessionId: SESSION_ID});
    expect(f.service.stageCapture({tabId: "tab", toolCallId: "failure", args: {status: "failed", refreshRequestId: prepared.request.refreshRequestId, message: "File unavailable"}})).toMatchObject({status: "failed"});
    const current = f.service.describe({artifactId: kept.artifactId});
    expect(current.artifact.currentDataSnapshotId).toBe(kept.currentDataSnapshotId);
    expect(current.refreshRequests[0]).toMatchObject({status: "failed", failure: {message: "File unavailable"}});
    expect(current.snapshot.datasets[0]?.provenance.capturedAt).toBe("2026-11-08T00:00:00.000Z");
  });
  it("rejects forged owner descriptors and records known interrupted captures without treating an empty turn as success", async () => {
    const f = fixture(); const kept = await keep(f);
    const prepared = f.service.prepareRefresh({targetTabId: "tab", ...versions(kept), datasetIds: ["rows"]});
    expect(() => f.service.admitPrompt({tabId: "tab", text: withArtifactRefreshContext(withArtifactReferenceContext("Use this context", [{...prepared.reference, ownerInstanceId: randomUUID()}]), [{ version: 1 as const, refreshRequestId: prepared.request.refreshRequestId, artifactId: prepared.request.artifactId, title: "T", datasetIds: ["rows"] }])})).toThrow("immutable grant");
    f.service.admitPrompt({tabId: "tab", text: refreshWire(prepared)});
    f.service.sourceExited({lineageDir: f.lineageDir, runtimeKey: RUNTIME_KEY});
    expect(f.service.describe({artifactId: kept.artifactId}).refreshRequests[0]?.status).toBe("interrupted");
    expect(f.service.describe({artifactId: kept.artifactId}).artifact.currentDataSnapshotId).toBe(kept.currentDataSnapshotId);
  });
  it("leaves a mid-message refresh lookalike as prose and never binds it", async () => {
    const f = fixture(); const kept = await keep(f);
    const prepared = f.service.prepareRefresh({targetTabId: "tab", ...versions(kept), datasetIds: ["rows"]});
    const lookalike = `Use this context\n\n<artifact refresh>\nrefresh-request: ${prepared.request.refreshRequestId}\n</artifact refresh>`;
    expect(() => f.service.admitPrompt({tabId: "tab", text: wire(prepared.reference, lookalike)})).not.toThrow();
    expect(f.service.describe({artifactId: kept.artifactId}).refreshRequests[0]).toMatchObject({bound: false, status: "awaiting"});
  });
  it("refuses a leading refresh block whose grant chip was removed", async () => {
    const f = fixture(); const kept = await keep(f);
    const prepared = f.service.prepareRefresh({targetTabId: "tab", ...versions(kept), datasetIds: ["rows"]});
    expect(() => f.service.admitPrompt({tabId: "tab", text: withArtifactRefreshContext("Do the work", [{ version: 1 as const, refreshRequestId: prepared.request.refreshRequestId, artifactId: prepared.request.artifactId, title: "T", datasetIds: ["rows"] }])}))
      .toThrowError(expect.objectContaining({code: "unavailable"}));
    expect(f.service.describe({artifactId: kept.artifactId}).refreshRequests[0]).toMatchObject({bound: false, status: "awaiting"});
  });
  it("refuses a leading refresh paired only with another artifact's grant", async () => {
    const f = fixture(); const kept = await keep(f); const other = await keep(f);
    const prepared = f.service.prepareRefresh({targetTabId: "tab", ...versions(kept), datasetIds: ["rows"]});
    const foreign = f.service.reference({targetTabId: "tab", ...versions(other), includeData: true});
    expect(() => f.service.admitPrompt({tabId: "tab", text: withArtifactRefreshContext(wire(foreign), [{ version: 1 as const, refreshRequestId: prepared.request.refreshRequestId, artifactId: prepared.request.artifactId, title: "T", datasetIds: ["rows"] }])}))
      .toThrow("exact data reference");
    expect(f.service.describe({artifactId: kept.artifactId}).refreshRequests[0]).toMatchObject({bound: false, status: "awaiting"});
  });
  it("binds two leading refresh entries each paired with its own grant", async () => {
    const f = fixture(); const first = await keep(f); const second = await keep(f, [5, 6]);
    const a = f.service.prepareRefresh({targetTabId: "tab", ...versions(first), datasetIds: ["rows"]});
    const b = f.service.prepareRefresh({targetTabId: "tab", ...versions(second), datasetIds: ["rows"]});
    const text = withArtifactRefreshContext(withArtifactReferenceContext("Refresh both", [a.reference, b.reference]),
      [{ version: 1 as const, refreshRequestId: a.request.refreshRequestId, artifactId: a.request.artifactId, title: "T", datasetIds: ["rows"] },
        { version: 1 as const, refreshRequestId: b.request.refreshRequestId, artifactId: b.request.artifactId, title: "T", datasetIds: ["rows"] }]);
    f.service.admitPrompt({tabId: "tab", text});
    expect(f.service.describe({artifactId: first.artifactId}).refreshRequests[0]).toMatchObject({refreshRequestId: a.request.refreshRequestId, bound: true, status: "awaiting"});
    expect(f.service.describe({artifactId: second.artifactId}).refreshRequests[0]).toMatchObject({refreshRequestId: b.request.refreshRequestId, bound: true, status: "awaiting"});
  });
});

describe("kept surface independence", () => {
  it("revokes removed draft surfaces but preserves a kept writer when its source is deleted", async () => {
    const f = fixture(); const record = await keep(f);
    const kept = f.service.resolveSurface(versions(record));
    const draft = await f.service.stageRender({tabId: "tab", toolCallId: "unkept-surface", args: args()});
    const changes: ArtifactLibraryChanged[] = [];
    f.service.onSurfaceInvalidated(change => changes.push(change));
    f.service.dropDraftsForLineage(f.lineageDir);
    expect(changes.at(-1)).toMatchObject({epoch: kept.binding.epoch, artifactIds: [draft.draftId]});
    const receipt = f.service.saveBoundState(kept.binding, {expectedStateRevision: 0, set: {note: "independent of source"}}, () => {});
    expect(receipt.stateRevision).toBe(1);
    expect(f.service.readBoundSurface(kept.binding).state.note).toBe("independent of source");
  });
});
