import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRefreshEntry, DraftArtifactReference } from "@omp-ui/core/artifacts";
import { parseArtifactPromptReferences, splitArtifactRefreshContext, withArtifactRefreshContext, withArtifactReferenceContext } from "@omp-ui/core/artifact-references";
import { h } from "../../test/store-harness";
import { rpcTabState, tabInfo, remoteInstance } from "../../test/fixtures";
import { withSessionReferenceContext } from "../../lib/session-references";
import { splitQueuedWireText } from "../../lib/queue-restore";
import { queueEntryDisplayText } from "../../lib/queue-chip";
import { reduceEvent, historyToItems, userContentFromContent } from "../../lib/transcript";
import { getNavigationGeneration } from "./view";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reference: DraftArtifactReference = { version: 1, referenceId: id(1), ownerInstanceId: id(2), artifactId: id(3), codeRevisionId: id(4), dataSnapshotId: id(5), title: "Budget", machine: "desk-main", snapshotAt: "2026-11-09T06:00:00.000Z", includeData: false, manifestUri: `omp-ui://artifacts/reference/${id(1)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${id(1)}/definition`, instanceId: null };
/** The chip a Refresh-now preparation yields for `reference` (ADR-0092 recipe). */
function refreshEntry(n: number, artifactId = reference.artifactId): ArtifactRefreshEntry {
  return { version: 1, refreshRequestId: id(n), artifactId, title: reference.title, datasetIds: ["rows"] };
}
function draftReference(n: number): DraftArtifactReference {
  const referenceId = id(100 + n);
  return { ...reference, referenceId, codeRevisionId: id(200 + n), manifestUri: `omp-ui://artifacts/reference/${referenceId}/manifest`, definitionUri: `omp-ui://artifacts/reference/${referenceId}/definition` };
}
/** The project at "/p" also holds the fresh "run" record main registers for a Refresh now spawn. */
function seedRefreshRun(): void {
  const base = { ...h.stateWithRecord("session-1"), artifactLibraryEnabled: true };
  const project = base.projects[0]!;
  const run = { ...project.sessions[0]!, tabId: "run", sessionId: null };
  const state = { ...base, projects: [{ ...project, sessions: [...project.sessions, run] }] };
  h.backendState = state;
  // The run's runtime is already booted, so the seed's settle poll resolves at once.
  h.useStore.setState(current => ({ state, rpc: { ...current.rpc, run: rpcTabState() }, advisorDefaults: { "/p": { enabled: false, model: null } } }));
  h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "run" });
}
const refreshRun = { artifactId: id(3), codeRevisionId: id(4), dataSnapshotId: id(5), datasetIds: ["rows"], title: "Quarter", projectCwd: "/p" };
const identity = vi.fn(async () => ({ instanceId: id(2), version: "1" }));
Object.assign(h.mockBackend, { getInstanceIdentity: identity });

beforeEach(() => {
  const state = { ...h.stateWithRecord("session-1"), artifactLibraryEnabled: true };
  h.backendState = state;
  h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState({ status: "ready" }) }, tabs: [tabInfo({ tabId: h.TAB })], activeTabId: h.TAB, artifactDrafts: {}, artifactRefreshDrafts: {} });
  identity.mockResolvedValue({ instanceId: id(2), version: "1" });
});

/** The transcript notices one tab has recorded. */
const noticeTexts = (tabId = h.TAB): string[] =>
  (h.useStore.getState().rpc[tabId]?.items ?? []).flatMap(item => (item.kind === "notice" ? [item.text] : []));

describe("artifact reference drafts", () => {
  it("replaces a duplicate version with its exact newly consented refresh grant", async () => {
    const store = h.useStore.getState();
    expect(store.attachArtifactReference(h.TAB, reference)).toBe(true);
    const refresh = { ...reference, referenceId: id(6), includeData: true, dataUri: `omp-ui://artifacts/reference/${id(6)}/state`, manifestUri: `omp-ui://artifacts/reference/${id(6)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${id(6)}/definition` };
    await expect(store.referenceArtifactInSession(h.TAB, refresh)).resolves.toBe(true);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([refresh]);
    expect(reference.includeData).toBe(false);
    store.attachArtifactReference(h.TAB, { ...reference, referenceId: id(7), codeRevisionId: id(8), manifestUri: `omp-ui://artifacts/reference/${id(7)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${id(7)}/definition` });
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toHaveLength(2);
  });
  it("retains grants through rpc slot replacement and clears only selected chips", () => {
    h.useStore.getState().attachArtifactReference(h.TAB, reference);
    h.useStore.setState({ rpc: {} });
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference]);
    h.useStore.getState().removeArtifactReference(h.TAB, reference.referenceId);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([]);
  });
  it("refuses references on another machine and names that machine", () => {
    expect(h.useStore.getState().attachArtifactReference(h.TAB, { ...reference, instanceId: id(9) })).toBe(false);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toBeUndefined();
    expect(JSON.stringify(h.useStore.getState().rpc[h.TAB]!.items)).toContain("desk-main");
  });
  it("stages before dormant resume and a slow resume never steals newer navigation", async () => {
    h.useStore.setState({ tabs: [], rpc: {}, activeTabId: null });
    const resume = h.deferred<{ tabId: string }>();
    h.mockBackend.spawnSession.mockReturnValueOnce(resume.promise);
    const attaching = h.useStore.getState().referenceArtifactInSession(h.TAB, reference);
    await h.flushMicrotasks();
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference]);
    expect(h.sent).toEqual([]);
    h.useStore.getState().focusTab("newer-intent");
    resume.resolve({ tabId: h.TAB });
    await attaching;
    expect(h.useStore.getState().activeTabId).toBe("newer-intent");
    expect(h.useStore.getState().tabs.some(tab => tab.tabId === h.TAB)).toBe(true);
  });
  it("preserves navigation that changed while a caller prepared the immutable grant", async () => {
    const navigationGeneration = getNavigationGeneration();
    h.useStore.getState().focusTab("newer-before-grant");
    await h.useStore.getState().referenceArtifactInSession(h.TAB, reference, { navigationGeneration });
    expect(h.useStore.getState().activeTabId).toBe("newer-before-grant");
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference]);
    expect(h.sent).toEqual([]);
  });
  it("opens an existing target nonactivating and refuses a grant from a different owner", async () => {
    await h.useStore.getState().openSession(h.TAB, { activate: false });
    identity.mockResolvedValueOnce({ instanceId: id(9), version: "1" });
    await h.useStore.getState().referenceArtifactInSession(h.TAB, reference);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toBeUndefined();
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(JSON.stringify(h.useStore.getState().rpc[h.TAB]!.items)).toContain("desk-main");
  });
  it("successful send retires only submitted grants, including a references-only prompt", async () => {
    h.useStore.getState().attachArtifactReference(h.TAB, reference);
    const sending = h.useStore.getState().sendPrompt(h.TAB, "", "prompt", [], [], { artifactReferences: [reference] });
    const frame = h.sent.find(entry => entry.cmd.type === "prompt")!;
    expect(parseArtifactPromptReferences(String(frame.cmd.message))).toEqual([expect.objectContaining({ referenceId: reference.referenceId, includeData: false })]);
    const next = { ...reference, referenceId: id(10), codeRevisionId: id(11), manifestUri: `omp-ui://artifacts/reference/${id(10)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${id(10)}/definition` };
    h.useStore.getState().attachArtifactReference(h.TAB, next);
    h.respond(h.TAB, frame.cmd, {});
    await expect(sending).resolves.toBe(true);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([next]);
  });
  it("feature-off and rejected sends retain grants", async () => {
    h.useStore.getState().attachArtifactReference(h.TAB, reference);
    h.useStore.setState({ state: { ...h.backendState, artifactLibraryEnabled: false } });
    await expect(h.useStore.getState().sendPrompt(h.TAB, "", "prompt", [], [], { artifactReferences: [reference] })).resolves.toBe(false);
    expect(h.sent).toEqual([]);
    h.useStore.setState({ state: h.backendState });
    const rejected = h.useStore.getState().abortAndPrompt(h.TAB, "retry", [], [], { artifactReferences: [reference] });
    const frame = h.sent.find(entry => entry.cmd.type === "abort_and_prompt")!;
    h.respond(h.TAB, frame.cmd, "rejected", false);
    await expect(rejected).resolves.toBe(false);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference]);
  });
  it("holds exact reference wire and restores cancelled holds outside the rpc queue", async () => {
    h.useStore.getState().attachArtifactReference(h.TAB, reference);
    await expect(h.useStore.getState().holdPrompt(h.TAB, "refresh later", 2000000000000, [], [], { artifactReferences: [reference] })).resolves.toBe(true);
    const text = withArtifactReferenceContext("refresh later", [reference]);
    expect(h.mockBackend.holdPrompt).toHaveBeenCalledWith(h.TAB, expect.objectContaining({ text, preview: "refresh later" }));
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([]);
    Object.assign(h.mockBackend, { cancelHeldPrompt: vi.fn(async () => ({ text, images: [] })) });
    await h.useStore.getState().cancelHeldPrompt(h.TAB);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([expect.objectContaining({ referenceId: id(1), includeData: false })]);
    h.useStore.setState({ rpc: {} });
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toHaveLength(1);
  });
  it("promotes and edits by raw queue wire while restored references survive rpc reset", async () => {
    const raw = withArtifactReferenceContext("edit this", [reference]);
    const promote = h.useStore.getState().promoteQueuedMessage(h.TAB, raw);
    const promoting = h.sent.find(entry => entry.cmd.type === "promote_queued_message")!;
    expect(promoting.cmd.message).toBe(raw);
    h.respond(h.TAB, promoting.cmd, { promoted: true });
    await promote;
    const edit = h.useStore.getState().editQueuedMessage(h.TAB, raw, "followUp");
    const editing = h.sent.find(entry => entry.cmd.type === "remove_queued_message")!;
    expect(editing.cmd.message).toBe(raw);
    h.respond(h.TAB, editing.cmd, { removed: true, images: [] });
    await edit;
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([expect.objectContaining({ referenceId: id(1) })]);
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toHaveLength(1);
  });
  it("retains aborted-queue overflow outside the boot-resettable slot", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running", capabilities: { version: 1, processKey: "process", sessionId: "session-1", revision: 1, updatedAt: 0, ompVersion: "18.14.0", skillCommandsEnabled: null, skills: { status: "unavailable", reason: "missing-api" }, tools: { status: "unavailable", reason: "missing-api" }, magicKeywords: { status: "available", items: [] }, toolControl: "unsupported", toolMutation: null } }) } });
    for (let n = 0; n < 8; n++) h.useStore.getState().attachArtifactReference(h.TAB, draftReference(n));
    const restoring = h.useStore.getState().abortAgent(h.TAB);
    const command = h.sent.find(entry => entry.cmd.type === "abort_and_restore_queue")!;
    h.respond(h.TAB, command.cmd, { steering: [{ text: withArtifactRefreshContext(withArtifactReferenceContext("restored", [reference]), [refreshEntry(25)]), images: [] }], followUp: [], imagesDropped: false, truncated: false });
    await restoring;
    expect(h.useStore.getState().artifactDrafts[h.TAB]!.map(ref => ref.referenceId)).toContain(reference.referenceId);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([refreshEntry(25)]);
    expect(noticeTexts().some(text => text.includes("could not be restored"))).toBe(false);
    h.useStore.setState({ rpc: {} });
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toHaveLength(9);
  });
  it("keeps failed launch seed references on the newly landed tab", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "failed-seed" });
    h.useStore.setState(current => ({ rpc: { ...current.rpc, "failed-seed": rpcTabState({ status: "error" }) } }));
    const launched = await h.useStore.getState().launchSession("/p", { prompt: "refresh", artifactReferences: [reference] });
    expect(launched).toBe("failed-seed");
    expect(h.useStore.getState().artifactDrafts["failed-seed"]).toEqual([reference]);
    expect(h.sent.some(entry => entry.cmd.type === "prompt")).toBe(false);
  });
  it("Refresh now seeds a leading refresh block over its paired grant with empty prose", async () => {
    seedRefreshRun();
    const refreshRequestId = id(22);
    const refresh = { ...reference, referenceId: id(6), includeData: true, dataUri: `omp-ui://artifacts/reference/${id(6)}/state`, manifestUri: `omp-ui://artifacts/reference/${id(6)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${id(6)}/definition` };
    // The prepared refresh carries no prose at all (ADR-0092): the request and
    // the grant are the whole seed, and the wire comes from the builders.
    const prepare = vi.fn(async () => ({ request: { refreshRequestId, artifactId: id(3), datasetIds: ["rows"] }, reference: refresh }));
    Object.assign(h.mockBackend, { artifactPrepareRefresh: prepare });
    const revision = h.useStore.getState().artifactLibraryRevision;
    await expect(h.useStore.getState().runArtifactRefresh(refreshRun)).resolves.toBe("run");
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ origin: "new", projectCwd: "/p", mode: "rpc-ui", planMode: true }));
    expect(prepare).toHaveBeenCalledWith({ targetTabId: "run", artifactId: id(3), codeRevisionId: id(4), dataSnapshotId: id(5), datasetIds: ["rows"] });
    expect(h.useStore.getState().artifactLibraryRevision).toBe(revision + 1);
    expect(h.useStore.getState().activeTabId).toBe(h.TAB);
    await h.flushMicrotasks();
    const rename = h.sent.find(entry => entry.tabId === "run" && entry.cmd.type === "set_session_name")!;
    expect(rename.cmd).toMatchObject({ name: "Refresh: Quarter" });
    h.respond("run", rename.cmd, {});
    await h.flushMicrotasks();
    const prompt = h.sent.find(entry => entry.tabId === "run" && entry.cmd.type === "prompt")!;
    const message = String(prompt.cmd.message);
    expect(message.startsWith("<artifact refresh>\n")).toBe(true);
    const peeled = splitArtifactRefreshContext(message);
    expect(peeled.refreshes).toEqual([expect.objectContaining({ refreshRequestId, artifactId: id(3), title: "Budget", datasetIds: ["rows"] })]);
    // The grant rides its own block and the prose is empty: no legacy sentence.
    expect(parseArtifactPromptReferences(message)).toEqual([expect.objectContaining({ referenceId: refresh.referenceId, includeData: true })]);
    expect(peeled.text).toBe(withArtifactReferenceContext("", [refresh]));
    h.respond("run", prompt.cmd, {});
    await h.flushMicrotasks();
    expect(h.useStore.getState().activeTabId).toBe(h.TAB);
    expect(h.useStore.getState().backgroundSeedFailedTabId).toBeNull();
    expect(h.useStore.getState().artifactDrafts.run).toEqual([]);
    expect(h.useStore.getState().artifactRefreshDrafts.run).toEqual([]);
  });
  it("a failed preparation erases the empty run and rethrows", async () => {
    seedRefreshRun();
    Object.assign(h.mockBackend, { artifactPrepareRefresh: vi.fn(async () => { throw new Error("snapshot moved"); }) });
    await expect(h.useStore.getState().runArtifactRefresh(refreshRun)).rejects.toThrow("snapshot moved");
    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith("run", false);
    expect(h.useStore.getState().tabs.some(tab => tab.tabId === "run")).toBe(false);
    expect(h.useStore.getState().activeTabId).toBe(h.TAB);
    expect(h.sent.some(entry => entry.cmd.type === "prompt")).toBe(false);
  });
  it("refuses cross-machine moves before spawning and clears only truly deleted targets", async () => {
    h.useStore.getState().attachArtifactReference(h.TAB, reference);
    h.useStore.setState({ state: { ...h.stateWithRecord(null), artifactLibraryEnabled: true } });
    await expect(h.useStore.getState().moveUnpromptedSession(h.TAB, { projectCwd: "/other", instanceId: id(9) }, { text: "draft", images: [], documents: [], annotations: [], references: [], artifactReferences: [reference] })).resolves.toBeNull();
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference]);
    await h.useStore.getState().deleteSession(h.TAB);
    await h.useStore.getState().confirmDeleteSession(false);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toBeUndefined();
  });
  it("preflights full-draft queue edits before withdrawing any host message", async () => {
    for (let n = 0; n < 8; n++) h.useStore.getState().attachArtifactReference(h.TAB, draftReference(n));
    const raw = withArtifactReferenceContext("keep queued", [reference]);
    await h.useStore.getState().editQueuedMessage(h.TAB, raw, "followUp");
    expect(h.sent.some(entry => entry.cmd.type === "remove_queued_message")).toBe(false);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toHaveLength(8);
  });
  it("retains racing queue-edit overflow as visible removable chips while wire sends remain bounded", async () => {
    for (let n = 0; n < 7; n++) h.useStore.getState().attachArtifactReference(h.TAB, draftReference(n));
    const raw = withArtifactReferenceContext("restore exact grant", [reference]);
    const editing = h.useStore.getState().editQueuedMessage(h.TAB, raw, "followUp");
    const command = h.sent.find(entry => entry.cmd.type === "remove_queued_message")!;
    h.useStore.getState().attachArtifactReference(h.TAB, draftReference(7));
    h.respond(h.TAB, command.cmd, { removed: true, images: [] });
    await editing;
    const restored = h.useStore.getState().artifactDrafts[h.TAB]!;
    expect(restored).toHaveLength(9);
    expect(restored.map(ref => ref.referenceId)).toContain(reference.referenceId);
    await expect(h.useStore.getState().sendPrompt(h.TAB, "", "prompt", [], [], { artifactReferences: restored })).resolves.toBe(false);
    expect(h.sent.some(entry => entry.cmd.type === "prompt")).toBe(false);
    h.useStore.getState().removeArtifactReference(h.TAB, draftReference(0).referenceId);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toHaveLength(8);
  });
  it("retains unknown held-cancel overflow instead of discarding the withdrawn grant", async () => {
    for (let n = 0; n < 8; n++) h.useStore.getState().attachArtifactReference(h.TAB, draftReference(n));
    Object.assign(h.mockBackend, { cancelHeldPrompt: vi.fn(async () => ({ text: withArtifactReferenceContext("held context", [reference]), images: [] })) });
    await h.useStore.getState().cancelHeldPrompt(h.TAB);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toHaveLength(9);
    expect(h.useStore.getState().artifactDrafts[h.TAB]!.map(ref => ref.referenceId)).toContain(reference.referenceId);
  });
  it("retains distinct restored grant IDs even when they name the same accepted version", () => {
    h.useStore.getState().attachArtifactReference(h.TAB, reference);
    const restored = { ...reference, referenceId: id(77), manifestUri: `omp-ui://artifacts/reference/${id(77)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${id(77)}/definition` };
    expect(h.useStore.getState().restoreArtifactReferences(h.TAB, [restored])).toBe(true);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference, restored]);
    const explicit = { ...reference, referenceId: id(78), manifestUri: `omp-ui://artifacts/reference/${id(78)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${id(78)}/definition` };
    expect(h.useStore.getState().attachArtifactReference(h.TAB, explicit)).toBe(true);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([explicit]);
  });
  it("moves compatible references attached during both spawn and deletion awaits", async () => {
    const state = { ...h.stateWithRecord(null), artifactLibraryEnabled: true };
    h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState(), fresh: rpcTabState() }, advisorDefaults: { "/q": { enabled: false, model: null } } });
    const spawn = h.deferred<{ tabId: string }>();
    h.mockBackend.spawnSession.mockReturnValueOnce(spawn.promise);
    h.mockBackend.deleteSession.mockImplementationOnce(async tabId => {
      expect(h.useStore.getState().attachArtifactReference(h.TAB, draftReference(1))).toBe(true);
      return { deleted: [tabId], failed: [] };
    });
    const moving = h.useStore.getState().moveUnpromptedSession(h.TAB, { projectCwd: "/q", instanceId: null }, { text: "move", images: [], documents: [], annotations: [], references: [], artifactReferences: [] });
    await h.flushMicrotasks();
    expect(h.useStore.getState().attachArtifactReference(h.TAB, draftReference(0))).toBe(true);
    // A request prepared against the source tab cannot bind on the target, even
    // one attached during the spawn await (ADR-0092): it is dropped where the
    // rest of the draft landed, with a notice.
    h.useStore.getState().attachArtifactRefresh(h.TAB, refreshEntry(26));
    spawn.resolve({ tabId: "fresh" });
    await expect(moving).resolves.toBe("fresh");
    expect(h.useStore.getState().artifactDrafts.fresh).toEqual([draftReference(0), draftReference(1)]);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toBeUndefined();
    expect(h.useStore.getState().artifactRefreshDrafts.fresh).toBeUndefined();
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toBeUndefined();
    expect(JSON.stringify(h.useStore.getState().rpc.fresh!.items)).toContain("belonged to this session's old tab");
  });
  it("refuses a move when a foreign-owner reference arrives while the target is being created", async () => {
    const base = h.stateWithRecord(null);
    const instanceId = id(9);
    const state = { ...base, artifactLibraryEnabled: true, remoteInstances: [remoteInstance({ id: instanceId, nickname: "remote-box", projects: [] })] };
    h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState(), fresh: rpcTabState() }, advisorDefaults: { [`${instanceId}::/q`]: { enabled: false, model: null } } });
    const spawn = h.deferred<{ tabId: string }>();
    h.mockBackend.remoteInstanceRequest.mockImplementation(async (_instance, channel) => channel === "session:spawn" ? spawn.promise : undefined);
    const moving = h.useStore.getState().moveUnpromptedSession(h.TAB, { projectCwd: "/q", instanceId }, { text: "move", images: [], documents: [], annotations: [], references: [], artifactReferences: [] });
    await h.flushMicrotasks();
    expect(h.useStore.getState().attachArtifactReference(h.TAB, reference)).toBe(true);
    expect(h.useStore.getState().attachArtifactRefresh(h.TAB, refreshEntry(27))).toBe(true);
    spawn.resolve({ tabId: "fresh" });
    await expect(moving).resolves.toBeNull();
    expect(h.mockBackend.deleteSession).not.toHaveBeenCalled();
    // A refused move drops nothing: the source keeps both chips.
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference]);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([refreshEntry(27)]);
    expect(h.useStore.getState().activeTabId).toBe(h.TAB);
  });
});

describe("artifact refresh drafts (ADR-0092)", () => {
  it("a second picker click on one artifact rebinds the chip instead of stacking a second send", async () => {
    const store = h.useStore.getState();
    expect(store.attachArtifactRefresh(h.TAB, refreshEntry(30))).toBe(true);
    expect(store.attachArtifactRefresh(h.TAB, refreshEntry(31))).toBe(true);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([refreshEntry(31)]);
    // The single chip is send-able and the wire names only the newer request.
    h.useStore.getState().attachArtifactReference(h.TAB, reference);
    const sending = h.useStore.getState().sendPrompt(h.TAB, "recollect", "prompt", [], [], { artifactReferences: [reference], refreshes: [refreshEntry(31)] });
    const frame = h.sent.find(entry => entry.cmd.type === "prompt")!;
    const message = String(frame.cmd.message);
    expect(message).toContain(`request: ${id(31)}`);
    expect(message).not.toContain(`request: ${id(30)}`);
    h.respond(h.TAB, frame.cmd, {});
    await expect(sending).resolves.toBe(true);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([]);
  });
  it("keeps requests for different artifacts as separate chips and removes one by request id", () => {
    const store = h.useStore.getState();
    expect(store.attachArtifactRefresh(h.TAB, refreshEntry(32))).toBe(true);
    expect(store.attachArtifactRefresh(h.TAB, refreshEntry(33, id(40)))).toBe(true);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toHaveLength(2);
    store.removeArtifactRefresh(h.TAB, id(32));
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([refreshEntry(33, id(40))]);
  });
  it("clears the whole tab or only the submitted list, matching grant semantics", () => {
    const store = h.useStore.getState();
    store.attachArtifactRefresh(h.TAB, refreshEntry(34));
    store.attachArtifactRefresh(h.TAB, refreshEntry(35, id(41)));
    store.clearArtifactRefreshes(h.TAB, [refreshEntry(34)]);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([refreshEntry(35, id(41))]);
    store.attachArtifactRefresh(h.TAB, refreshEntry(36));
    store.clearArtifactRefreshes(h.TAB);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toBeUndefined();
  });
  it("restores withdrawn requests as removable chips, deduped and kept past the send limit", () => {
    const store = h.useStore.getState();
    for (let n = 0; n < 8; n++) expect(store.attachArtifactRefresh(h.TAB, refreshEntry(50 + n, id(100 + n)))).toBe(true);
    // The same request twice restores once; an unseen ninth one stays visible.
    expect(store.restoreArtifactRefreshes(h.TAB, [refreshEntry(50), refreshEntry(58, id(200))])).toBe(true);
    const drafts = h.useStore.getState().artifactRefreshDrafts[h.TAB]!;
    expect(drafts).toHaveLength(9);
    expect(drafts.map(entry => entry.refreshRequestId)).toEqual([id(50), ...Array.from({ length: 7 }, (_, i) => id(51 + i)), id(58)]);
    expect(store.attachArtifactRefresh(h.TAB, refreshEntry(59, id(201)))).toBe(false);
  });
  it("refuses refresh chips on a non-rpc-ui tab", () => {
    h.useStore.setState({ state: h.stateWithRecord(null), tabs: [tabInfo({ tabId: "term", mode: "pty" })], rpc: {} });
    expect(h.useStore.getState().attachArtifactRefresh("term", refreshEntry(37))).toBe(false);
    expect(h.useStore.getState().artifactRefreshDrafts.term).toBeUndefined();
    expect(h.useStore.getState().restoreArtifactRefreshes("term", [refreshEntry(38)])).toBe(false);
  });
  it("attaches grant and request together through one draft attach", async () => {
    const entry = refreshEntry(39);
    await expect(h.useStore.getState().attachArtifactRefreshDraft(h.TAB, reference, entry)).resolves.toBe(true);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([expect.objectContaining({ referenceId: reference.referenceId })]);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([entry]);
  });
  it("leaves no chip and no grant when the request itself is invalid", async () => {
    const broken = { version: 1 as const, refreshRequestId: id(42), artifactId: id(3), title: "Budget", datasetIds: [] };
    await expect(h.useStore.getState().attachArtifactRefreshDraft(h.TAB, reference, broken)).resolves.toBe(false);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toBeUndefined();
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toBeUndefined();
    expect(h.errorMessages().length + noticeTexts().length).toBeGreaterThan(0);
  });
  it("leaves no request behind when the grant binding fails", async () => {
    identity.mockResolvedValueOnce({ instanceId: id(9), version: "1" });
    await expect(h.useStore.getState().attachArtifactRefreshDraft(h.TAB, reference, refreshEntry(43))).resolves.toBe(false);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toBeUndefined();
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toBeUndefined();
    expect(JSON.stringify(h.useStore.getState().rpc[h.TAB]!.items)).toContain("desk-main");
  });
  it("refuses an entry the wire builder rejects and keeps the chips already staged", () => {
    const store = h.useStore.getState();
    expect(store.attachArtifactRefresh(h.TAB, refreshEntry(48))).toBe(true);
    // A request id outside the grammar never reaches the chip list (ADR-0092).
    expect(store.attachArtifactRefresh(h.TAB, { version: 1, refreshRequestId: "not-a-uuid", artifactId: id(3), title: "Budget", datasetIds: ["rows"] })).toBe(false);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([refreshEntry(48)]);
    expect(store.restoreArtifactRefreshes(h.TAB, [{ version: 1, refreshRequestId: id(49), artifactId: "nope", title: "Budget", datasetIds: ["rows"] }])).toBe(false);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([refreshEntry(48)]);
  });
  it("holds the refresh block leading of the reference block and restores it on cancel", async () => {
    const entry = refreshEntry(44);
    h.useStore.getState().attachArtifactReference(h.TAB, reference);
    await expect(h.useStore.getState().holdPrompt(h.TAB, "later", 2000000000000, [], [], { artifactReferences: [reference], refreshes: [entry] })).resolves.toBe(true);
    const held = (h.mockBackend.holdPrompt.mock.calls.at(-1) as unknown[] | undefined)?.[1] as { text: string };
    expect(held.text.startsWith("<artifact refresh>\n")).toBe(true);
    expect(splitQueuedWireText(held.text)).toMatchObject({
      text: "later",
      refreshes: [entry],
      artifactReferences: [expect.objectContaining({ referenceId: reference.referenceId })],
      legacyRefreshRequestId: null,
    });
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([]);
    Object.assign(h.mockBackend, { cancelHeldPrompt: vi.fn(async () => ({ text: held.text, images: [] })) });
    await h.useStore.getState().cancelHeldPrompt(h.TAB);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toEqual([entry]);
    expect(noticeTexts().some(text => text.includes("could not be restored"))).toBe(false);
  });
  it("announces a legacy refresh request as dropped instead of restoring prose", async () => {
    const legacy = `Refresh the requested datasets for this accepted artifact in this ordinary session. Collect only datasets rows.\n\n<artifact refresh>\nrefresh-request: ${id(45)}\n</artifact refresh>`;
    Object.assign(h.mockBackend, { cancelHeldPrompt: vi.fn(async () => ({ text: legacy, images: [] })) });
    await h.useStore.getState().cancelHeldPrompt(h.TAB);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toBeUndefined();
    expect(h.useStore.getState().rpc[h.TAB]!.composerQueue).toBeUndefined();
    expect(noticeTexts().some(text => text.includes("could not be restored into this tab"))).toBe(true);
  });
  it("warns when a withdrawn request cannot return as a chip", async () => {
    Object.assign(h.mockBackend, { cancelHeldPrompt: vi.fn(async () => ({ text: withArtifactRefreshContext("held", [refreshEntry(46)]), images: [] })) });
    // No record and no mounted tab: the restore has nothing to bind against.
    h.useStore.setState({ state: { ...h.backendState, projects: [] }, tabs: [] });
    await h.useStore.getState().cancelHeldPrompt(h.TAB);
    expect(h.useStore.getState().artifactRefreshDrafts[h.TAB]).toBeUndefined();
    expect(noticeTexts().some(text => text.includes("could not be restored into this tab"))).toBe(true);
  });
});

describe("wire/history lifecycle", () => {
  it("restores chips while queue matching retains the untouched wire", () => {
    const session = { title: "Other", sessionId: "other", machine: "desk-main", path: "/saved/other.jsonl" };
    const raw = withSessionReferenceContext(withArtifactReferenceContext("compare", [reference]), [session]);
    expect(parseArtifactPromptReferences(raw)).toEqual([expect.objectContaining({ referenceId: id(1), includeData: false })]);
    expect(splitQueuedWireText(raw)).toMatchObject({ text: "compare", references: [session], artifactReferences: [expect.objectContaining({ referenceId: id(1) })], refreshes: [], legacyRefreshRequestId: null });
    expect(queueEntryDisplayText(raw)).toBe("@ Other\n@ Budget\ncompare");
    expect(userContentFromContent(raw)).toMatchObject({ text: "compare", artifactReferences: [expect.objectContaining({ referenceId: id(1) })] });
    expect(historyToItems([{ role: "user", content: raw }])[0]).toMatchObject({ kind: "user", text: "compare", artifactReferences: [expect.objectContaining({ referenceId: id(1) })] });
    expect(raw).toContain("<artifact references>");
  });
  it("peels a refresh stack in admission order and displays the request line first", () => {
    const entry = refreshEntry(47);
    const raw = withArtifactRefreshContext(withSessionReferenceContext(withArtifactReferenceContext("recollect", [reference]), [{ title: "Other", sessionId: "other", machine: "desk-main", path: "/saved/other.jsonl" }]), [entry]);
    expect(splitQueuedWireText(raw)).toMatchObject({ text: "recollect", refreshes: [entry], legacyRefreshRequestId: null });
    expect(parseArtifactPromptReferences(raw)).toEqual([expect.objectContaining({ referenceId: id(1) })]);
    expect(queueEntryDisplayText(raw)).toBe("↻ Refresh: Budget\n@ Other\n@ Budget\nrecollect");
  });
  it("projects exact artifact details equally for live and history and never failed results", () => {
    const details = { artifactDraft: { version: 1, draftId: id(20), sourceHash: "a".repeat(64) }, artifactCapture: { version: 1, status: "captured", captureId: id(21), artifactId: id(3), refreshRequestId: id(22) } };
    const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call", name: "render_html", arguments: { title: "Budget", html: "<p>Budget</p>" } }] };
    const history = historyToItems([assistant, { role: "toolResult", toolCallId: "call", content: [], details }]);
    expect(history.find(item => item.kind === "tool")).toMatchObject(details);
    const live = reduceEvent(historyToItems([assistant]), { type: "tool_execution_end", toolCallId: "call", result: { content: [], details } });
    expect(live.find(item => item.kind === "tool")).toMatchObject(details);
    const failed = historyToItems([assistant, { role: "toolResult", toolCallId: "call", content: [], details, isError: true }]);
    expect(failed.find(item => item.kind === "tool")).not.toHaveProperty("artifactDraft");
  });
});
