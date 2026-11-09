import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftArtifactReference } from "@omp-ui/core/artifacts";
import { parseArtifactPromptReferences, withArtifactReferenceContext } from "@omp-ui/core/artifact-references";
import { h } from "../../test/store-harness";
import { rpcTabState, tabInfo, remoteInstance } from "../../test/fixtures";
import { withSessionReferenceContext } from "../../lib/session-references";
import { splitQueuedWireText } from "../../lib/queue-restore";
import { queueEntryDisplayText } from "../../lib/queue-chip";
import { reduceEvent, historyToItems, userContentFromContent } from "../../lib/transcript";
import { getNavigationGeneration } from "./view";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reference: DraftArtifactReference = { version: 1, referenceId: id(1), ownerInstanceId: id(2), artifactId: id(3), codeRevisionId: id(4), dataSnapshotId: id(5), title: "Budget", machine: "desk-main", snapshotAt: "2026-11-09T06:00:00.000Z", includeData: false, manifestUri: `omp-ui://artifacts/reference/${id(1)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${id(1)}/definition`, instanceId: null };
function draftReference(n: number): DraftArtifactReference {
  const referenceId = id(100 + n);
  return { ...reference, referenceId, codeRevisionId: id(200 + n), manifestUri: `omp-ui://artifacts/reference/${referenceId}/manifest`, definitionUri: `omp-ui://artifacts/reference/${referenceId}/definition` };
}
const identity = vi.fn(async () => ({ instanceId: id(2), version: "1" }));
Object.assign(h.mockBackend, { getInstanceIdentity: identity });

beforeEach(() => {
  const state = { ...h.stateWithRecord("session-1"), artifactLibraryEnabled: true };
  h.backendState = state;
  h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState({ status: "ready" }) }, tabs: [tabInfo({ tabId: h.TAB })], activeTabId: h.TAB, artifactDrafts: {}, artifactDraftText: {} });
  identity.mockResolvedValue({ instanceId: id(2), version: "1" });
});

describe("artifact reference drafts", () => {
  it("replaces a duplicate version with its exact newly consented refresh grant", async () => {
    const store = h.useStore.getState();
    expect(store.attachArtifactReference(h.TAB, reference)).toBe(true);
    const refresh = { ...reference, referenceId: id(6), includeData: true, dataUri: `omp-ui://artifacts/reference/${id(6)}/state`, manifestUri: `omp-ui://artifacts/reference/${id(6)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${id(6)}/definition` };
    await expect(store.referenceArtifactInSession(h.TAB, refresh, `Refresh using ${refresh.referenceId}`)).resolves.toBe(true);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([refresh]);
    expect(h.useStore.getState().artifactDraftText[h.TAB]).toEqual([`Refresh using ${refresh.referenceId}`]);
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
    const attaching = h.useStore.getState().referenceArtifactInSession(h.TAB, reference, "Refresh the totals");
    await h.flushMicrotasks();
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference]);
    expect(h.useStore.getState().artifactDraftText[h.TAB]).toEqual(["Refresh the totals"]);
    expect(h.sent).toEqual([]);
    h.useStore.getState().focusTab("newer-intent");
    resume.resolve({ tabId: h.TAB });
    await attaching;
    expect(h.useStore.getState().activeTabId).toBe("newer-intent");
    expect(h.useStore.getState().tabs.some(tab => tab.tabId === h.TAB)).toBe(true);
    expect(h.useStore.getState().drainArtifactDraftText(h.TAB)).toEqual(["Refresh the totals"]);
  });
  it("preserves navigation that changed while a caller prepared the immutable grant", async () => {
    const navigationGeneration = getNavigationGeneration();
    h.useStore.getState().focusTab("newer-before-grant");
    await h.useStore.getState().referenceArtifactInSession(h.TAB, reference, "Refresh without stealing focus", { navigationGeneration });
    expect(h.useStore.getState().activeTabId).toBe("newer-before-grant");
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference]);
    expect(h.useStore.getState().artifactDraftText[h.TAB]).toEqual(["Refresh without stealing focus"]);
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
    const sending = h.useStore.getState().sendPrompt(h.TAB, "", "prompt", [], [], [], [], [reference]);
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
    await expect(h.useStore.getState().sendPrompt(h.TAB, "", "prompt", [], [], [], [], [reference])).resolves.toBe(false);
    expect(h.sent).toEqual([]);
    h.useStore.setState({ state: h.backendState });
    const rejected = h.useStore.getState().abortAndPrompt(h.TAB, "retry", [], [], [], [], [reference]);
    const frame = h.sent.find(entry => entry.cmd.type === "abort_and_prompt")!;
    h.respond(h.TAB, frame.cmd, "rejected", false);
    await expect(rejected).resolves.toBe(false);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference]);
  });
  it("holds exact reference wire and restores cancelled holds outside the rpc queue", async () => {
    h.useStore.getState().attachArtifactReference(h.TAB, reference);
    await expect(h.useStore.getState().holdPrompt(h.TAB, "refresh later", 2000000000000, [], [], [], [], [reference])).resolves.toBe(true);
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
    h.respond(h.TAB, command.cmd, { steering: [{ text: withArtifactReferenceContext("restored", [reference]), images: [] }], followUp: [], imagesDropped: false, truncated: false });
    await restoring;
    expect(h.useStore.getState().artifactDrafts[h.TAB]!.map(ref => ref.referenceId)).toContain(reference.referenceId);
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
    await expect(h.useStore.getState().sendPrompt(h.TAB, "", "prompt", [], [], [], [], restored)).resolves.toBe(false);
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
    expect(h.useStore.getState().attachArtifactReference(h.TAB, explicit, "Use this newly prepared grant")).toBe(true);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([explicit]);
  });
  it("moves compatible references attached during both spawn and deletion awaits", async () => {
    const state = { ...h.stateWithRecord(null), artifactLibraryEnabled: true };
    h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState(), fresh: rpcTabState() }, advisorDefaults: { "/q": { enabled: false, model: null } } });
    const spawn = h.deferred<{ tabId: string }>();
    h.mockBackend.spawnSession.mockReturnValueOnce(spawn.promise);
    h.mockBackend.deleteSession.mockImplementationOnce(async tabId => {
      expect(h.useStore.getState().attachArtifactReference(h.TAB, draftReference(1), "suggested during deletion")).toBe(true);
      return { deleted: [tabId], failed: [] };
    });
    const moving = h.useStore.getState().moveUnpromptedSession(h.TAB, { projectCwd: "/q", instanceId: null }, { text: "move", images: [], documents: [], annotations: [], references: [], artifactReferences: [] });
    await h.flushMicrotasks();
    expect(h.useStore.getState().attachArtifactReference(h.TAB, draftReference(0), "suggested during spawn")).toBe(true);
    spawn.resolve({ tabId: "fresh" });
    await expect(moving).resolves.toBe("fresh");
    expect(h.useStore.getState().artifactDrafts.fresh).toEqual([draftReference(0), draftReference(1)]);
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toBeUndefined();
    expect(h.useStore.getState().artifactDraftText.fresh).toEqual(["suggested during spawn", "suggested during deletion"]);
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
    spawn.resolve({ tabId: "fresh" });
    await expect(moving).resolves.toBeNull();
    expect(h.mockBackend.deleteSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().artifactDrafts[h.TAB]).toEqual([reference]);
    expect(h.useStore.getState().activeTabId).toBe(h.TAB);
  });
});

describe("wire/history lifecycle", () => {
  it("restores chips while queue matching retains the untouched wire", () => {
    const session = { title: "Other", sessionId: "other", machine: "desk-main", path: "/saved/other.jsonl" };
    const raw = withSessionReferenceContext(withArtifactReferenceContext("compare", [reference]), [session]);
    expect(parseArtifactPromptReferences(raw)).toEqual([expect.objectContaining({ referenceId: id(1), includeData: false })]);
    expect(splitQueuedWireText(raw)).toMatchObject({ text: "compare", references: [session], artifactReferences: [expect.objectContaining({ referenceId: id(1) })] });
    expect(queueEntryDisplayText(raw)).toBe("@ Other\n@ Budget\ncompare");
    expect(userContentFromContent(raw)).toMatchObject({ text: "compare", artifactReferences: [expect.objectContaining({ referenceId: id(1) })] });
    expect(historyToItems([{ role: "user", content: raw }])[0]).toMatchObject({ kind: "user", text: "compare", artifactReferences: [expect.objectContaining({ referenceId: id(1) })] });
    expect(raw).toContain("<artifact references>");
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
