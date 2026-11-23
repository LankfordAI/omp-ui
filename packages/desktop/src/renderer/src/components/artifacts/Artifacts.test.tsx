// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArtifactDescription,
  ArtifactListItem,
  ArtifactListResult,
  ArtifactPartResult,
  ArtifactProvenance,
  ArtifactRefreshRequest,
  ArtifactSource,
} from "@omp-ui/core/artifacts";
import type { ArtifactSurfaceNotice } from "../../../../artifact-runtime-protocol";
import { diffArtifactValues } from "../../lib/artifact-diff";
import { backendState, remoteOwnedState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const backendMock = {
  artifactReadPart: vi.fn(),
  artifactReference: vi.fn(),
  artifactPrepareRefresh: vi.fn(),
  artifactApplyCapture: vi.fn(),
  artifactPin: vi.fn(),
  artifactReadThumbnail: vi.fn(),
  setWindowChrome: vi.fn(async () => {}),
  artifactDescribe: vi.fn(),
  artifactList: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
// The bridge is captured during module evaluation, so these imports intentionally exercise that loading boundary.
const { useStore } = await import("../../store");
const { ArtifactSurface } = await import("./ArtifactSurface");
const { ArtifactDataSources } = await import("./ArtifactDataSources");
const { ArtifactReferencePicker } = await import("./ArtifactReferencePicker");
const { ArtifactCaptureCard } = await import("./ArtifactCaptureCard");
const { Artifacts } = await import("./Artifacts");
const { clearThumbnailCache } = await import("./artifact-thumbnail-cache");
const { bumpNavigationGeneration, getNavigationGeneration } = await import("../../store/slices/view");

const id = "11111111-1111-4111-8111-111111111111";
const id2 = "55555555-5555-4555-8555-555555555555";
const code = "22222222-2222-4222-8222-222222222222";
const snapshot = "33333333-3333-4333-8333-333333333333";
const captureId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-11-09T00:00:00.000Z";
const source: ArtifactSource = { ownerInstanceId: id, lineageDir: "lineage", sessionId: id, runtimeKey: "runtime", toolCallId: "call", sourceHash: "a".repeat(64), createdAt: timestamp };
const provenance: ArtifactProvenance = { source: { kind: "manual", label: "Quarterly input" }, method: { kind: "manual", description: "Entered by a person" }, capturedAt: timestamp, recordedAt: timestamp, captureSessionId: id, captureToolCallId: "call", trust: "agent-reported", refresh: { kind: "manual", requiredSources: [] } };
const description: ArtifactDescription = {
  artifact: { artifactId: id, ownerInstanceId: id, title: "Quarterly chart", managed: true, currentCodeRevisionId: code, currentDataSnapshotId: snapshot, generation: 1, keptAt: timestamp, createdAt: timestamp, updatedAt: timestamp, pinnedAt: null, origin: source, originContext: { kind: "project", label: "Reports", path: "/reports" }, sourceDraftId: id },
  code: { artifactId: id, codeRevisionId: code, revisionNumber: 1, baseRevisionId: null, definition: { protocolVersion: 1, stateSchema: "state-v1", datasets: [{ id: "quarter", title: "Quarter", schema: "quarter-v1" }] }, source, createdAt: timestamp },
  snapshot: { artifactId: id, dataSnapshotId: snapshot, stateRevision: 1, cause: "initial", createdAt: timestamp, datasets: [{ id: "quarter", title: "Quarter", schema: "quarter-v1", head: "head", provenance }] },
  revisions: [{ artifactId: id, codeRevisionId: code, revisionNumber: 1, baseRevisionId: null, source, createdAt: timestamp }],
  snapshots: [{ dataSnapshotId: snapshot, createdAt: timestamp, cause: "initial", stateRevision: 1 }],
  references: [], captures: [], refreshRequests: [], candidates: [], retainedBytes: 1024, libraryBytesUsed: 4096,
  thumbnails: { dark: null, light: null },
  sourceTarget: null,
};
const refreshRequest: ArtifactRefreshRequest = { refreshRequestId: id, referenceId: id, artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot, datasetIds: ["quarter"], expectedDatasetHeads: { quarter: "head" }, targetTabId: "target-tab", bound: true, lineageDir: "lineage", runtimeKey: id, sessionId: id, createdAt: timestamp, status: "captured", scheduledBy: "Nightly" };

function listItem(patch: Partial<ArtifactListItem> = {}): ArtifactListItem {
  return {
    ...description.artifact,
    revisionNumber: 1,
    datasetCount: 1,
    pendingCaptureCount: 0,
    pendingCandidateCount: 0,
    awaitingRefreshCount: 0,
    thumbnails: { dark: null, light: null },
    ...patch,
  };
}

function listResult(patch: Partial<ArtifactListResult> = {}): ArtifactListResult {
  return {
    artifacts: [],
    nextCursor: null,
    libraryBytesUsed: 4096,
    totalCount: 0,
    pendingReviewCount: 0,
    pendingReviewPreview: [],
    origins: [],
    ...patch,
  };
}

function page(text = "{}", nextOffset: number | null = null, offset = 0, totalBytes = text.length): ArtifactPartResult {
  return { version: 1, referenceId: id, part: "dataset", offset, nextOffset, totalBytes, encoding: "utf-8", text };
}

let root: Root | null = null;
let host: HTMLDivElement;
async function render(node: React.ReactNode): Promise<void> {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(node); });
}
function button(text: string): HTMLButtonElement {
  return [...(document.querySelector('[role="dialog"]') ?? host).querySelectorAll("button")].find((item) => item.textContent?.includes(text))!;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearThumbnailCache();
  try { localStorage.removeItem("omp-ui:artifacts-layout"); } catch {}
  useStore.setState({ state: backendState({ artifactLibraryEnabled: true, htmlArtifactScripts: true }), artifacts: null });
  backendMock.artifactReadPart.mockResolvedValue(page());
  backendMock.artifactList.mockResolvedValue(listResult());
  backendMock.artifactReadThumbnail.mockResolvedValue(null);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  delete window.ompArtifactHost;
});

describe("trusted artifact surface", () => {
  it("keeps one main-issued guest across rerenders, exposes onSurfaceReady on ready notice, and suppresses Read-only bar on plain docs", async () => {
    let notice: ((event: ArtifactSurfaceNotice) => void) | undefined;
    const prepareSurface = vi.fn(async () => ({ surfaceId: id, url: "data:text/html;base64,bWFpbg==", partition: "omp-ui-artifacts", managed: true, readOnly: false }));
    const releaseSurface = vi.fn(async () => {});
    const captureThumbnail = vi.fn(async () => ({ hash: "abc" }));
    window.ompArtifactHost = {
      prepareSurface,
      releaseSurface,
      updateTheme: vi.fn(async () => {}),
      captureThumbnail,
      ensureDocumentThumbnail: vi.fn(async () => null),
      onSurfaceNotice: (listener) => { notice = listener; return () => {}; },
    };
    const onSurfaceReady = vi.fn();
    const exact = { artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot };
    await render(<ArtifactSurface source={exact} html="<p>Static</p>" title="Chart" onSurfaceReady={onSurfaceReady} />);
    const guest = host.querySelector("webview");
    expect(guest?.getAttribute("src")).toBe("data:text/html;base64,bWFpbg==");
    expect(guest?.hasAttribute("preload")).toBe(false);
    await act(async () => { root!.render(<ArtifactSurface source={{ ...exact }} html="<p>Static</p>" title="Chart" onSurfaceReady={onSurfaceReady} />); });
    expect(prepareSurface).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("webview")).toHaveLength(1);
    act(() => notice!({ surfaceId: id, reason: "ready", reloadRequired: false }));
    expect(onSurfaceReady).toHaveBeenLastCalledWith(expect.objectContaining({ surfaceId: id }));
    act(() => notice!({ surfaceId: id, reason: "saving", reloadRequired: false }));
    expect(host.textContent).toContain("Saving");
    act(() => notice!({ surfaceId: id, reason: "not-saved", reloadRequired: false }));
    expect(host.textContent).toContain("Not saved");
    act(() => notice!({ surfaceId: id, reason: "changed", reloadRequired: true }));
    expect(host.querySelector("webview")).toBe(guest);
    expect(button("Reload")).toBeDefined();
    act(() => root!.unmount()); root = null;
    expect(releaseSurface).toHaveBeenCalledWith(id);

    // Plain kept document with desktop bridge + scripts on suppresses the "Read only" bar.
    await render(<ArtifactSurface source={exact} managed={false} html="<p>Plain doc</p>" title="Plain" />);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).not.toContain("Read only");
  });

  it("uses a scripts-off sandbox without a desktop bridge", async () => {
    await render(<ArtifactSurface source={{ artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot }} html="<script>evil()</script>" title="Chart" />);
    expect(host.querySelector("webview")).toBeNull();
    expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
    expect(host.querySelector("iframe")?.getAttribute("srcdoc")).toContain("script-src 'none'");
    expect(host.textContent).toContain("Read only");
  });
});

describe("Gallery & Full-Canvas Viewer (#1307)", () => {
  it("renders Gallery with Pinned section, Grid/List toggle, Attention strip for page-2+ items, and discards stale filter responses", async () => {
    const pinned = listItem({ artifactId: id, title: "Pinned Dashboard", pinnedAt: timestamp });
    const unpinned = listItem({ artifactId: id2, title: "Second Doc", managed: false, datasetCount: 0 });
    backendMock.artifactList.mockResolvedValueOnce(
      listResult({
        artifacts: [pinned, unpinned],
        totalCount: 2,
        pendingReviewCount: 1,
        pendingReviewPreview: [{ artifactId: "99999999-9999-4999-8999-999999999999", title: "Page 2 Capture", pendingCaptureCount: 1, pendingCandidateCount: 0 }],
        origins: [{ key: "/reports", label: "Reports", kind: "project" }],
      }),
    );
    useStore.setState({ artifacts: { artifactId: null } });
    await render(<Artifacts />);

    expect(host.querySelector("[data-artifacts-pinned-section]")?.textContent).toContain("Pinned Dashboard");
    expect(host.querySelector("[data-artifacts-attention-strip]")?.textContent).toContain("Page 2 Capture");

    // Toggle to List view and verify persistence.
    await act(async () => button("List").click());
    expect(host.querySelector("table")).not.toBeNull();
    expect(localStorage.getItem("omp-ui:artifacts-layout")).toBe("list");

    // Late response from an earlier filter must be discarded when a newer filter resolves first.
    const slow = Promise.withResolvers<ArtifactListResult>();
    const fast = Promise.withResolvers<ArtifactListResult>();
    backendMock.artifactList.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    await act(async () => button("Managed").click());
    await act(async () => button("Documents").click());
    await act(async () => { fast.resolve(listResult({ artifacts: [unpinned], totalCount: 2 })); });
    expect(host.textContent).toContain("Second Doc");
    expect(host.textContent).not.toContain("Pinned Dashboard");
    await act(async () => { slow.resolve(listResult({ artifacts: [pinned], totalCount: 2 })); });
    expect(host.textContent).toContain("Second Doc");
    expect(host.textContent).not.toContain("Pinned Dashboard");
  });

  it("preserves Load more pages on kind='thumbnail' events without resetting to page 1", async () => {
    const first = listItem({ artifactId: id, title: "First Card" });
    const second = listItem({ artifactId: id2, title: "Second Card" });
    backendMock.artifactList
      .mockResolvedValueOnce(listResult({ artifacts: [first], nextCursor: "cursor-1", totalCount: 2 }))
      .mockResolvedValueOnce(listResult({ artifacts: [second], nextCursor: null, totalCount: 2 }));
    backendMock.artifactDescribe.mockResolvedValue({
      ...description,
      thumbnails: { dark: { hash: "deadbeef", stale: false }, light: null },
    });
    useStore.setState({ artifacts: { artifactId: null } });
    await render(<Artifacts />);
    await act(async () => button("Load more").click());
    expect(host.textContent).toContain("First Card");
    expect(host.textContent).toContain("Second Card");

    const callsBefore = backendMock.artifactList.mock.calls.length;
    await act(async () => {
      useStore.getState().invalidateArtifactLibrary({ epoch: 1, artifactIds: [id], kind: "thumbnail" });
    });
    // Must not re-run artifactList or drop page 2.
    expect(backendMock.artifactList.mock.calls.length).toBe(callsBefore);
    expect(host.textContent).toContain("First Card");
    expect(host.textContent).toContain("Second Card");
  });

  it("keeps the guest mounted when toggling the Data & History drawer, shows historical banner, and displays per-artifact footprint in History", async () => {
    let current: ArtifactDescription = {
      ...description,
      snapshots: [
        { dataSnapshotId: captureId, createdAt: timestamp, cause: "user-edit", stateRevision: 2 },
        { dataSnapshotId: snapshot, createdAt: timestamp, cause: "initial", stateRevision: 1 },
      ],
    };
    backendMock.artifactDescribe.mockImplementation(async (req: { codeRevisionId?: string; dataSnapshotId?: string }) => ({
      ...current,
      code: { ...current.code, codeRevisionId: req.codeRevisionId ?? current.code.codeRevisionId },
      snapshot: { ...current.snapshot, dataSnapshotId: req.dataSnapshotId ?? current.snapshot.dataSnapshotId },
    }));
    backendMock.artifactReadPart.mockImplementation(async (request: { part: string }) =>
      page(request.part === "definition" ? JSON.stringify({ html: "<p>Chart</p>", managed: description.code.definition }) : "{}"),
    );
    const prepareSurface = vi.fn(async () => ({ surfaceId: id, url: "data:text/html;base64,bWFpbg==", partition: "omp-ui-artifacts", managed: true, readOnly: false }));
    window.ompArtifactHost = {
      prepareSurface,
      releaseSurface: vi.fn(async () => {}),
      updateTheme: vi.fn(async () => {}),
      captureThumbnail: vi.fn(async () => null),
      ensureDocumentThumbnail: vi.fn(async () => null),
      onSurfaceNotice: () => () => {},
    };
    useStore.setState({ artifacts: { artifactId: id } });
    await render(<Artifacts />);
    const guest = host.querySelector("webview");
    expect(guest).not.toBeNull();
    expect(prepareSurface).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-artifacts-drawer]")).toBeNull();

    // Toggling the drawer open/closed never unmounts or re-prepares the guest.
    await act(async () => { button("Data & History").click(); });
    expect(host.querySelector("[data-artifacts-drawer]")).not.toBeNull();
    expect(host.querySelector("webview")).toBe(guest);
    expect(prepareSurface).toHaveBeenCalledTimes(1);

    // Switch drawer to History: shows per-artifact retained footprint and lets user inspect a historical snapshot.
    const historyTab = [...host.querySelectorAll<HTMLButtonElement>("[data-artifacts-drawer] button")].find((b) => b.textContent === "History")!;
    await act(async () => historyTab.click());
    expect(host.textContent).toContain("Retained ≈");
    expect(host.textContent).toContain("Prune old versions");

    // Inspecting historical snapshot shows historical banner + Return to latest.
    current = { ...current, artifact: { ...current.artifact, currentDataSnapshotId: captureId } };
    await act(async () => { useStore.getState().openArtifacts({ artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot }); });
    expect(host.querySelector("[data-artifact-historical-banner]")).not.toBeNull();
    expect(host.textContent).toContain("Return to latest");
    await act(async () => button("Return to latest").click());
    expect(useStore.getState().artifacts).toEqual({ artifactId: id });
  });

  it("opens the Data & History drawer automatically when store requests panel: 'data'", async () => {
    backendMock.artifactDescribe.mockResolvedValue(description);
    backendMock.artifactReadPart.mockResolvedValue(page());
    await act(async () => { useStore.getState().openArtifacts({ artifactId: id, panel: "data" }); });
    await render(<Artifacts />);
    expect(host.querySelector("[data-artifacts-drawer]")).not.toBeNull();
  });
});

describe("structured capture diffs and human consent (#1307)", () => {
  it("computes deterministic keyed-array, object-key, and fallback summary diffs", () => {
    const keyed = diffArtifactValues(
      [{ id: "a", v: 1 }, { id: "b", v: 2 }],
      [{ id: "a", v: 1 }, { id: "b", v: 3 }, { id: "c", v: 4 }],
    );
    expect(keyed.kind).toBe("keyed-array");
    if (keyed.kind === "keyed-array") {
      expect(keyed.added.map((x) => x.key)).toEqual(["c"]);
      expect(keyed.changed.map((x) => x.key)).toEqual(["b"]);
      expect(keyed.removed).toEqual([]);
      expect(keyed.unchangedCount).toBe(1);
    }

    // Duplicate IDs or missing IDs fall back to summary.
    expect(diffArtifactValues([{ id: 1 }, { id: 1 }], [{ id: 1 }]).kind).toBe("summary");
    expect(diffArtifactValues([{ name: "x" }], [{ name: "y" }]).kind).toBe("summary");

    // Plain object key diff.
    const obj = diffArtifactValues({ a: 1, b: 2 }, { a: 1, c: 3 });
    expect(obj.kind).toBe("object-keys");
  });

  it("unblocks Apply without forced chunk paging, shows scheduledBy chip, and handles >2 MiB payloads gracefully", async () => {
    const capture = { captureId, refreshRequestId: id, artifactId: id, codeRevisionId: code, expectedDatasetHeads: { quarter: "head" }, source, createdAt: timestamp, appliedDataSnapshotId: null, datasets: [{ id: "quarter", title: "Quarter", schema: "quarter-v1", provenance, valueBytes: 3_000_000, currentValueBytes: 3_000_000 }] };
    backendMock.artifactApplyCapture.mockResolvedValue(description.artifact);
    backendMock.artifactReadPart.mockResolvedValue(page('{"big":1}', 65536, 0, 3_000_000));

    await render(<ArtifactCaptureCard description={{ ...description, refreshRequests: [refreshRequest] }} capture={capture} />);
    expect(host.textContent).toContain("Scheduled · Nightly");
    expect(host.textContent).toContain("diff limit");
    // Apply is enabled immediately without paging every 16 KiB block.
    expect(button("Apply captured data").disabled).toBe(false);
    await act(async () => button("Apply captured data").click());
    expect(backendMock.artifactApplyCapture).toHaveBeenCalledWith({ captureId, expectedCodeRevisionId: code, expectedDatasetHeads: { quarter: "head" } });
    expect(host.textContent).toContain("Applied");
  });

  it("escapes data and follows exact UTF-8 offsets without putting values in the DOM as HTML", async () => {
    backendMock.artifactReadPart.mockResolvedValueOnce(page('<img id="injected">', 16384)).mockResolvedValueOnce(page("tail", null, 16384));
    await render(<ArtifactDataSources description={description} />);
    expect(host.querySelector("#injected")).toBeNull();
    expect(host.textContent).toContain('<img id="injected">');
    await act(async () => button("Next page").click());
    expect(backendMock.artifactReadPart).toHaveBeenLastCalledWith(expect.objectContaining({ artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot, offset: 16384, limit: 16384 }));
    expect(host.textContent).toContain("tail");
  });

  it("defaults Reference picker to Start fresh with saved-data consent off and calls referenceArtifactInNewSession", async () => {
    const referenceArtifactInNewSession = vi.fn(async () => "new-chat-tab");
    const previous = { referenceArtifactInNewSession: useStore.getState().referenceArtifactInNewSession };
    useStore.setState({ referenceArtifactInNewSession });
    try {
      await render(<ArtifactReferencePicker description={description} onClose={() => {}} />);
      expect(document.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
      expect(document.body.textContent).toContain("Start fresh");
      expect(document.body.textContent).toContain("HTML itself can contain sensitive information");
      const initialIntent = getNavigationGeneration();
      await act(async () => button("Add to draft").click());
      expect(referenceArtifactInNewSession).toHaveBeenCalledWith({
        artifactId: id,
        codeRevisionId: code,
        dataSnapshotId: snapshot,
        includeData: false,
        projectCwd: null,
        navigationGeneration: initialIntent,
      });
    } finally {
      useStore.setState(previous);
    }
  });

  it("Refresh now starts a background run with every dataset selected and carries navigation generation for existing session", async () => {
    const existing = { ...remoteOwnedState("existing-tab", "remote").remoteInstances[0]!.projects[0]!.sessions[0]!, chat: true, title: "Existing chat" };
    useStore.setState({ state: backendState({ artifactLibraryEnabled: true, chats: [existing] }) });
    const runArtifactRefresh = vi.fn(async () => "run-tab");
    const attach = vi.fn(async () => true);
    const onRefreshStarted = vi.fn();
    const onClose = vi.fn();
    const previous = { runArtifactRefresh: useStore.getState().runArtifactRefresh, attachArtifactRefreshDraft: useStore.getState().attachArtifactRefreshDraft };
    useStore.setState({ runArtifactRefresh, attachArtifactRefreshDraft: attach as never });
    try {
      await render(<ArtifactReferencePicker description={description} mode="refresh" onClose={onClose} onRefreshStarted={onRefreshStarted} />);
      await act(async () => button("Refresh now").click());
      expect(runArtifactRefresh).toHaveBeenCalledWith({ artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot, datasetIds: ["quarter"], title: description.artifact.title, projectCwd: null });
      expect(onRefreshStarted).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();

      // Now select existing chat in listbox and verify delayed preparation keeps original navigation generation.
      act(() => root?.unmount()); root = null;
      const prepared = { request: { refreshRequestId: id, referenceId: id, artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot, datasetIds: ["quarter"] }, reference: { referenceId: id, title: "Quarterly chart" } };
      const { promise: preparation, resolve: finishPreparation } = Promise.withResolvers<typeof prepared>();
      backendMock.artifactPrepareRefresh.mockReturnValue(preparation);
      await render(<ArtifactReferencePicker description={description} mode="refresh" onClose={() => {}} />);
      await act(async () => button("Existing chat").click());
      const initialIntent = getNavigationGeneration();
      act(() => button("Add to draft").click());
      expect(backendMock.artifactPrepareRefresh).toHaveBeenCalledWith({ targetTabId: "existing-tab", artifactId: id, codeRevisionId: code, dataSnapshotId: snapshot, datasetIds: ["quarter"] });
      bumpNavigationGeneration();
      await act(async () => { finishPreparation(prepared); });
      expect(getNavigationGeneration()).not.toBe(initialIntent);
      expect(attach).toHaveBeenCalledWith("existing-tab", prepared.reference, { version: 1, refreshRequestId: id, artifactId: id, title: "Quarterly chart", datasetIds: ["quarter"] }, { navigationGeneration: initialIntent });
    } finally {
      useStore.setState(previous);
    }
  });
});
