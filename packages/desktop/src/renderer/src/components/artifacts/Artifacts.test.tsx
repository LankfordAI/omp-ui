// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactDescription, ArtifactPartResult, ArtifactProvenance, ArtifactRefreshRequest, ArtifactSource } from "@omp-ui/core/artifacts";
import type { ArtifactSurfaceNotice } from "../../../../artifact-runtime-protocol";
import { backendState, remoteOwnedState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const backendMock = {
  artifactReadPart: vi.fn(), artifactReference: vi.fn(), artifactPrepareRefresh: vi.fn(), artifactApplyCapture: vi.fn(), setWindowChrome: vi.fn(async () => {}),
  artifactDescribe: vi.fn(), artifactList: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
// The bridge is captured during module evaluation, so these imports intentionally exercise that loading boundary.
const { useStore } = await import("../../store");
const { ArtifactSurface } = await import("./ArtifactSurface");
const { ArtifactDataSources } = await import("./ArtifactDataSources");
const { ArtifactReferencePicker } = await import("./ArtifactReferencePicker");
const { ArtifactCaptureCard } = await import("./ArtifactCaptureCard");
const { Artifacts } = await import("./Artifacts");
const { bumpNavigationGeneration, getNavigationGeneration } = await import("../../store/slices/view");

const id = "11111111-1111-4111-8111-111111111111";
const code = "22222222-2222-4222-8222-222222222222";
const snapshot = "33333333-3333-4333-8333-333333333333";
const captureId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-11-09T00:00:00.000Z";
const source: ArtifactSource = { ownerInstanceId: id, lineageDir: "lineage", sessionId: id, runtimeKey: "runtime", toolCallId: "call", sourceHash: "a".repeat(64), createdAt: timestamp };
const provenance: ArtifactProvenance = { source: { kind: "manual", label: "Quarterly input" }, method: { kind: "manual", description: "Entered by a person" }, capturedAt: timestamp, recordedAt: timestamp, captureSessionId: id, captureToolCallId: "call", trust: "agent-reported", refresh: { kind: "manual", requiredSources: [] } };
const description: ArtifactDescription = {
  artifact: { artifactId: id, ownerInstanceId: id, title: "Quarterly chart", managed: true, currentCodeRevisionId: code, currentDataSnapshotId: snapshot, generation: 1, keptAt: timestamp, createdAt: timestamp, updatedAt: timestamp, origin: source, originContext: { kind: "project", label: "Reports", path: "/reports" }, sourceDraftId: id },
  code: { artifactId: id, codeRevisionId: code, revisionNumber: 1, baseRevisionId: null, definition: { protocolVersion: 1, stateSchema: "state-v1", datasets: [{ id: "quarter", title: "Quarter", schema: "quarter-v1" }] }, source, createdAt: timestamp },
  snapshot: { artifactId: id, dataSnapshotId: snapshot, stateRevision: 1, cause: "initial", createdAt: timestamp, datasets: [{ id: "quarter", title: "Quarter", schema: "quarter-v1", head: "head", provenance }] },
  revisions: [], snapshots: [], references: [], captures: [], refreshRequests: [], candidates: [], sourceTarget: null,
};
const refreshRequest: ArtifactRefreshRequest = { refreshRequestId: id, referenceId: id, artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot, datasetIds: ["quarter"], expectedDatasetHeads: { quarter: "head" }, targetTabId: "target-tab", bound: true, lineageDir: "lineage", runtimeKey: id, sessionId: id, createdAt: timestamp, status: "captured" };
function page(text = "{}", nextOffset: number | null = null, offset = 0): ArtifactPartResult { return { version: 1, referenceId: id, part: "dataset", offset, nextOffset, totalBytes: 20000, encoding: "utf-8", text }; }
let root: Root | null = null;
let host: HTMLDivElement;
async function render(node: React.ReactNode): Promise<void> {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(node); });
}
function button(text: string): HTMLButtonElement { return [...(document.querySelector('[role="dialog"]') ?? host).querySelectorAll("button")].find((item) => item.textContent === text)!; }
beforeEach(() => { vi.clearAllMocks(); useStore.setState({ state: backendState({ artifactLibraryEnabled: true, htmlArtifactScripts: true }) }); backendMock.artifactReadPart.mockResolvedValue(page()); });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); delete window.ompArtifactHost; });

describe("trusted artifact surface", () => {
  it("keeps one main-issued guest across rerenders and accepts save status only from the host", async () => {
    let notice: ((event: ArtifactSurfaceNotice) => void) | undefined;
    const prepareSurface = vi.fn(async () => ({ surfaceId: id, url: "data:text/html;base64,bWFpbg==", partition: "omp-ui-artifacts", managed: true, readOnly: false }));
    const releaseSurface = vi.fn(async () => {});
    window.ompArtifactHost = { prepareSurface, releaseSurface, updateTheme: vi.fn(async () => {}), onSurfaceNotice: (listener) => { notice = listener; return () => {}; } };
    const exact = { artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot };
    await render(<ArtifactSurface source={exact} html="<p>Static</p>" title="Chart" />);
    const guest = host.querySelector("webview");
    expect(guest?.getAttribute("src")).toBe("data:text/html;base64,bWFpbg==");
    expect(guest?.hasAttribute("preload")).toBe(false);
    await act(async () => { root!.render(<ArtifactSurface source={{ ...exact }} html="<p>Static</p>" title="Chart" />); });
    expect(prepareSurface).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("webview")).toHaveLength(1);
    act(() => notice!({ surfaceId: id, reason: "saving", reloadRequired: false }));
    expect(host.textContent).toContain("Saving");
    act(() => notice!({ surfaceId: id, reason: "not-saved", reloadRequired: false }));
    expect(host.textContent).toContain("Not saved");
    act(() => notice!({ surfaceId: id, reason: "changed", reloadRequired: true }));
    expect(host.querySelector("webview")).toBe(guest);
    expect(button("Reload")).toBeDefined();
    act(() => root!.unmount()); root = null;
    expect(releaseSurface).toHaveBeenCalledWith(id);
  });

  it("uses a scripts-off sandbox without a desktop bridge", async () => {
    await render(<ArtifactSurface source={{ artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot }} html="<script>evil()</script>" title="Chart" />);
    expect(host.querySelector("webview")).toBeNull();
    expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
    expect(host.querySelector("iframe")?.getAttribute("srcdoc")).toContain("script-src 'none'");
    expect(host.textContent).toContain("Read only");
  });
});

describe("current metadata with a pinned active writer", () => {
  it("refreshes omitted heads without replacing the guest, then opens the current snapshot when Preview is reopened", async () => {
    let current = description;
    backendMock.artifactDescribe.mockImplementation(async () => current);
    backendMock.artifactList.mockResolvedValue({ artifacts: [], nextCursor: null });
    backendMock.artifactReadPart.mockImplementation(async (request: { part: string }) => page(request.part === "definition" ? JSON.stringify({ html: "<p>Chart</p>", managed: description.code.definition }) : "{}"));
    const prepareSurface = vi.fn(async () => ({ surfaceId: id, url: "data:text/html;base64,bWFpbg==", partition: "omp-ui-artifacts", managed: true, readOnly: false }));
    window.ompArtifactHost = { prepareSurface, releaseSurface: vi.fn(async () => {}), updateTheme: vi.fn(async () => {}), onSurfaceNotice: () => () => {} };
    useStore.setState({ artifacts: { artifactId: id } });
    await render(<Artifacts />);
    const guest = host.querySelector("webview");
    expect(guest).not.toBeNull();
    expect(prepareSurface).toHaveBeenCalledTimes(1);
    current = { ...description, artifact: { ...description.artifact, currentDataSnapshotId: captureId, generation: 2 }, snapshot: { ...description.snapshot, dataSnapshotId: captureId, stateRevision: 2, cause: "user-edit" } };
    await act(async () => useStore.getState().invalidateArtifactLibrary());
    expect(backendMock.artifactDescribe).toHaveBeenLastCalledWith({ artifactId: id });
    expect(host.querySelector("webview")).toBe(guest);
    expect(prepareSurface).toHaveBeenCalledTimes(1);
    await act(async () => button("Saved data").click());
    expect(backendMock.artifactReadPart).toHaveBeenLastCalledWith(expect.objectContaining({ part: "state", dataSnapshotId: captureId }));
    await act(async () => button("Preview").click());
    expect(prepareSurface).toHaveBeenLastCalledWith({ artifactId: id, codeRevisionId: code, dataSnapshotId: captureId }, expect.any(Object));
  });

  it("keeps explicitly selected history pinned during invalidation and Preview reopening", async () => {
    let current = description;
    backendMock.artifactDescribe.mockImplementation(async (request: { codeRevisionId?: string; dataSnapshotId?: string }) => ({ ...current, code: { ...current.code, codeRevisionId: request.codeRevisionId ?? current.code.codeRevisionId }, snapshot: { ...current.snapshot, dataSnapshotId: request.dataSnapshotId ?? current.snapshot.dataSnapshotId } }));
    backendMock.artifactList.mockResolvedValue({ artifacts: [], nextCursor: null });
    backendMock.artifactReadPart.mockImplementation(async (request: { part: string }) => page(request.part === "definition" ? JSON.stringify({ html: "<p>Historical chart</p>", managed: description.code.definition }) : "{}"));
    useStore.setState({ artifacts: { artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot } });
    await render(<Artifacts />);
    current = { ...description, artifact: { ...description.artifact, currentDataSnapshotId: captureId, generation: 2 }, snapshot: { ...description.snapshot, dataSnapshotId: captureId, stateRevision: 2, cause: "user-edit" } };
    await act(async () => useStore.getState().invalidateArtifactLibrary());
    expect(backendMock.artifactDescribe).toHaveBeenLastCalledWith({ artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot });
    await act(async () => button("Saved data").click());
    expect(backendMock.artifactReadPart).toHaveBeenLastCalledWith(expect.objectContaining({ part: "state", dataSnapshotId: snapshot }));
    await act(async () => button("Preview").click());
    expect(backendMock.artifactReadPart).toHaveBeenLastCalledWith(expect.objectContaining({ part: "definition", codeRevisionId: code, dataSnapshotId: snapshot }));
  });
});

describe("bounded artifact reads and human consent", () => {
  it("escapes data and follows exact UTF-8 offsets without putting values in the DOM as HTML", async () => {
    backendMock.artifactReadPart.mockResolvedValueOnce(page('<img id="injected">', 16384)).mockResolvedValueOnce(page("tail", null, 16384));
    await render(<ArtifactDataSources description={description} />);
    expect(host.querySelector("#injected")).toBeNull();
    expect(host.textContent).toContain('<img id="injected">');
    await act(async () => button("Next page").click());
    expect(backendMock.artifactReadPart).toHaveBeenLastCalledWith(expect.objectContaining({ artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot, offset: 16384, limit: 16384 }));
    expect(host.textContent).toContain("tail");
  });

  it("offers existing sessions only for references with saved-data consent off", async () => {
    await render(<ArtifactReferencePicker description={description} onClose={() => {}} />);
    expect([...document.querySelectorAll("option")].some((option) => option.value.startsWith("new:"))).toBe(false);
    expect(document.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("HTML itself can contain sensitive information");
    expect(backendMock.artifactReference).not.toHaveBeenCalled();
  });

  it("Refresh now starts a background run with every dataset selected", async () => {
    const runArtifactRefresh = vi.fn(async () => "run-tab");
    const attach = vi.fn(async () => true);
    const onRefreshStarted = vi.fn();
    const onClose = vi.fn();
    const previous = { runArtifactRefresh: useStore.getState().runArtifactRefresh, referenceArtifactInSession: useStore.getState().referenceArtifactInSession };
    useStore.setState({ runArtifactRefresh, referenceArtifactInSession: attach });
    try {
      await render(<ArtifactReferencePicker description={description} mode="refresh" onClose={onClose} onRefreshStarted={onRefreshStarted} />);
      expect(document.querySelector("select")!.selectedOptions[0]!.textContent).toBe("A new background Chat");
      await act(async () => button("Refresh now").click());
      expect(runArtifactRefresh).toHaveBeenCalledWith({ artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot, datasetIds: ["quarter"], title: description.artifact.title, projectCwd: null });
      expect(onRefreshStarted).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
      expect(backendMock.artifactPrepareRefresh).not.toHaveBeenCalled();
      expect(attach).not.toHaveBeenCalled();
    } finally { useStore.setState(previous); }
  });

  it("refresh mode shows a null start as an error and stays open", async () => {
    const runArtifactRefresh = vi.fn(async () => null);
    const onClose = vi.fn();
    const previous = { runArtifactRefresh: useStore.getState().runArtifactRefresh };
    useStore.setState({ runArtifactRefresh });
    try {
      await render(<ArtifactReferencePicker description={description} mode="refresh" onClose={onClose} />);
      await act(async () => button("Refresh now").click());
      expect(document.querySelector('[role="alert"]')?.textContent).toBe("The refresh session could not start.");
      expect(onClose).not.toHaveBeenCalled();
    } finally { useStore.setState(previous); }
  });

  it("carries the original focus intent through a slow refresh added to an existing session's draft", async () => {
    const existing = { ...remoteOwnedState("existing-tab", "remote").remoteInstances[0]!.projects[0]!.sessions[0]!, chat: true, title: "Existing chat" };
    useStore.setState({ state: backendState({ artifactLibraryEnabled: true, chats: [existing] }) });
    const { promise: preparation, resolve: finishPreparation } = Promise.withResolvers<{ request: object; reference: { referenceId: string }; text: string }>();
    backendMock.artifactPrepareRefresh.mockReturnValue(preparation);
    const runArtifactRefresh = vi.fn(async () => "run-tab");
    const attach = vi.fn(async () => true);
    const previous = { runArtifactRefresh: useStore.getState().runArtifactRefresh, referenceArtifactInSession: useStore.getState().referenceArtifactInSession };
    useStore.setState({ runArtifactRefresh, referenceArtifactInSession: attach });
    try {
      await render(<ArtifactReferencePicker description={description} mode="refresh" onClose={() => {}} />);
      await act(async () => { const select = document.querySelector("select")!; select.value = "existing-tab"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      const initialIntent = getNavigationGeneration();
      act(() => button("Add to draft").click());
      expect(backendMock.artifactPrepareRefresh).toHaveBeenCalledWith({ targetTabId: "existing-tab", artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot, datasetIds: ["quarter"] });
      bumpNavigationGeneration();
      await act(async () => { finishPreparation({ request: {}, reference: { referenceId: id }, text: "Editable refresh" }); });
      expect(getNavigationGeneration()).not.toBe(initialIntent);
      expect(attach).toHaveBeenCalledWith("existing-tab", { referenceId: id }, "Editable refresh", { navigationGeneration: initialIntent });
      expect(runArtifactRefresh).not.toHaveBeenCalled();
    } finally { useStore.setState(previous); }
  });

  it("never auto-applies staged captures and preserves manual state through exact dataset-head CAS", async () => {
    const capture = { captureId, refreshRequestId: id, artifactId: id, codeRevisionId: code, expectedDatasetHeads: { quarter: "head" }, source, createdAt: timestamp, appliedDataSnapshotId: null, datasets: [{ id: "quarter", title: "Quarter", schema: "quarter-v1", provenance, valueBytes: 2, currentValueBytes: 2 }] };
    backendMock.artifactApplyCapture.mockResolvedValue(description.artifact);
    backendMock.artifactReadPart.mockImplementation(async (request: { captureId?: string; dataSnapshotId: string }) => {
      if (request.captureId && request.dataSnapshotId !== snapshot) throw new Error("Capture must be read against its refresh source snapshot");
      return page();
    });
    await render(<ArtifactCaptureCard description={{ ...description, artifact: { ...description.artifact, currentDataSnapshotId: id }, snapshot: { ...description.snapshot, dataSnapshotId: id, cause: "user-edit", stateRevision: 2 }, refreshRequests: [refreshRequest] }} capture={capture} />);
    expect(backendMock.artifactReadPart).toHaveBeenCalledWith(expect.objectContaining({ captureId, codeRevisionId: code, dataSnapshotId: snapshot }));
    expect(backendMock.artifactReadPart).toHaveBeenCalledWith(expect.objectContaining({ codeRevisionId: code, dataSnapshotId: id, part: "dataset" }));
    expect(backendMock.artifactApplyCapture).not.toHaveBeenCalled();
    expect(button("Apply captured data").disabled).toBe(false);
    await act(async () => button("Apply captured data").click());
    expect(backendMock.artifactApplyCapture).toHaveBeenCalledWith({ captureId, expectedCodeRevisionId: code, expectedDatasetHeads: { quarter: "head" } });
    expect(host.textContent).toContain("Applied");
  });
});
