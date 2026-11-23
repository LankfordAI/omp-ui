import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ARTIFACT_LIMITS,
  type ArtifactDescription,
  type ArtifactListItem,
} from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { formatBytes, relativeTime } from "../../lib/format";
import { IS_ELECTRON } from "../../lib/platform";
import { useTheme } from "../../lib/themes";
import { useDismissal } from "../../lib/use-dismissal";
import { OVERLAY_INSET } from "../../lib/window-controls";
import { findOwner, useStore } from "../../store";
import { Button, Chip, IconButton, IconClose } from "../ui";
import { ArtifactCaptureCard } from "./ArtifactCaptureCard";
import { ArtifactContractDiff } from "./ArtifactContractDiff";
import { ArtifactDataSources } from "./ArtifactDataSources";
import {
  ArtifactSurface,
  type ArtifactSurfaceReadyHandle,
  type ArtifactSurfaceStatus,
} from "./ArtifactSurface";

export interface ArtifactViewerProps {
  description: ArtifactDescription;
  preview: { html: string; source: { artifactId: string; codeRevisionId: string; dataSnapshotId: string } } | null;
  error: string | null;
  drawerOpen: boolean;
  drawerTab: "data" | "history";
  onToggleDrawer: () => void;
  onDrawerTabChange: (tab: "data" | "history") => void;
  onBackToGallery: () => void;
  onSelectArtifact: (selection: { artifactId: string; codeRevisionId?: string; dataSnapshotId?: string; panel?: "preview" | "data" | "history" }) => void;
  onReloadPreview: () => void;
  onOpenPicker: (mode: "reference" | "refresh") => void;
  onPin: () => void;
  onRename: () => void;
  onExportHtml: () => void;
  onPrune: () => void;
  onDelete: () => void;
  onRestore: (dataSnapshotId: string) => void;
  onDismissRefresh: (refreshRequestId: string) => void;
  onCloseArtifacts: () => void;
}

const CAUSE_LABELS: Record<string, string> = {
  initial: "Initial",
  "user-edit": "User edit",
  refresh: "Refresh",
  restore: "Restored",
};

export function ArtifactViewer({
  description,
  preview,
  error,
  drawerOpen,
  drawerTab,
  onToggleDrawer,
  onDrawerTabChange,
  onBackToGallery,
  onSelectArtifact,
  onReloadPreview,
  onOpenPicker,
  onPin,
  onRename,
  onExportHtml,
  onPrune,
  onDelete,
  onRestore,
  onDismissRefresh,
  onCloseArtifacts,
}: ArtifactViewerProps) {
  const theme = useTheme();
  const appState = useStore((s) => s.state);
  const revision = useStore((s) => s.artifactLibraryRevision);
  const [expanded, setExpanded] = useState(false);
  const [surfaceStatus, setSurfaceStatus] = useState<ArtifactSurfaceStatus>("loading");
  const [surfaceHandle, setSurfaceHandle] = useState<ArtifactSurfaceReadyHandle | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherRows, setSwitcherRows] = useState<ArtifactListItem[]>([]);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [candidateBusy, setCandidateBusy] = useState<string | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);

  const previewRef = useRef<HTMLDialogElement>(null);
  const switcherTriggerRef = useRef<HTMLButtonElement>(null);
  const switcherMenuRef = useRef<HTMLDivElement>(null);
  const overflowTriggerRef = useRef<HTMLSpanElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const capturedTuplesRef = useRef<Set<string>>(new Set());

  useDismissal({
    open: switcherOpen,
    refs: [switcherTriggerRef, switcherMenuRef],
    onClose: () => setSwitcherOpen(false),
    onEscape: () => setSwitcherOpen(false),
    restoreFocus: () => switcherTriggerRef.current?.focus(),
  });
  useDismissal({
    open: overflowOpen,
    refs: [overflowTriggerRef, overflowMenuRef],
    onClose: () => setOverflowOpen(false),
    onEscape: () => setOverflowOpen(false),
    restoreFocus: () => overflowTriggerRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
  });

  useEffect(() => {
    if (!switcherOpen) return;
    let canceled = false;
    void backend
      .artifactList({ limit: 30 })
      .then((page) => {
        if (!canceled) setSwitcherRows(page.artifacts);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [switcherOpen, revision]);

  useLayoutEffect(() => {
    const dialog = previewRef.current;
    if (!expanded || !dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [expanded]);

  const { artifact, code, snapshot } = description;
  const isHistoricalCode = code.codeRevisionId !== artifact.currentCodeRevisionId;
  const isHistoricalSnapshot = snapshot.dataSnapshotId !== artifact.currentDataSnapshotId;
  const isHistorical = isHistoricalCode || isHistoricalSnapshot;
  const pendingCaptureCount = description.captures.filter((c) => c.appliedDataSnapshotId === null).length;
  const pendingCount = pendingCaptureCount + description.candidates.length;
  const canRefresh = artifact.managed && (code.definition?.datasets.length ?? 0) > 0;
  const originLabel = artifact.originContext.kind === "chat" ? "Chat" : artifact.originContext.label;
  const pinned = artifact.pinnedAt !== null;

  // Capture a raster thumbnail once a current-head managed surface is ready and settled.
  useEffect(() => {
    if (!surfaceHandle || !artifact.managed || isHistorical) return;
    const slot = theme.dark ? description.thumbnails.dark : description.thumbnails.light;
    if (slot && !slot.stale) return;
    const tuple = `${artifact.artifactId}:${artifact.currentCodeRevisionId}:${artifact.currentDataSnapshotId}:${theme.dark ? "d" : "l"}`;
    if (capturedTuplesRef.current.has(tuple)) return;

    let canceled = false;
    const timer = setTimeout(() => {
      void surfaceHandle
        .captureThumbnail(theme.dark)
        .then((saved) => {
          if (!canceled && saved !== null) {
            capturedTuplesRef.current.add(tuple);
          }
        })
        .catch(() => {});
    }, 250);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [
    surfaceHandle,
    artifact.artifactId,
    artifact.managed,
    artifact.currentCodeRevisionId,
    artifact.currentDataSnapshotId,
    isHistorical,
    description.thumbnails.dark,
    description.thumbnails.light,
    theme.dark,
  ]);

  const discardCandidate = async (draftId: string): Promise<void> => {
    setCandidateBusy(draftId);
    setCandidateError(null);
    try {
      await backend.artifactDiscardDraft({ draftId });
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) {
      setCandidateError(displayMessage(reason));
    } finally {
      setCandidateBusy(null);
    }
  };

  const handleRefreshClick = (): void => {
    if (isHistorical) {
      onSelectArtifact({ artifactId: artifact.artifactId });
    }
    onOpenPicker("refresh");
  };

  const statusChipLabel =
    surfaceStatus === "saving"
      ? "Saving…"
      : surfaceStatus === "saved"
        ? "Saved"
        : surfaceStatus === "not-saved"
          ? "Not saved"
          : surfaceStatus === "loading"
            ? "Loading…"
            : "Read only";

  const activeRefreshes = description.refreshRequests.filter((request) => request.status !== "dismissed");
  const pendingCaptures = description.captures.filter((c) => c.appliedDataSnapshotId === null);
  const appliedCaptures = description.captures.filter((c) => c.appliedDataSnapshotId !== null);

  return (
    <div className="flex min-h-0 flex-1 flex-col @container">
      {/* Slim viewer top bar */}
      <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line chrome-void px-3 py-2">
        <Button size="xs" variant="ghost" onClick={onBackToGallery}>
          ← All artifacts
        </Button>

        <div className="relative min-w-0 max-w-xs">
          <button
            ref={switcherTriggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            onClick={() => setSwitcherOpen((open) => !open)}
            className="flex max-w-full items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold text-ink hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-copper"
          >
            <span className="min-w-0 truncate">{artifact.title}</span>
            <span aria-hidden className="shrink-0 text-xs text-ink-dim">▾</span>
          </button>
          {switcherOpen && (
            <div
              ref={switcherMenuRef}
              role="menu"
              aria-label="Switch artifact"
              className="absolute left-0 top-full z-30 mt-1 max-h-80 w-72 max-w-[90vw] overflow-y-auto rounded-lg border border-line-strong bg-overlay p-1 shadow-lg backdrop-glass"
            >
              {switcherRows.map((row) => (
                <button
                  key={row.artifactId}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSwitcherOpen(false);
                    onSelectArtifact({ artifactId: row.artifactId });
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    row.artifactId === artifact.artifactId
                      ? "bg-hover font-medium text-ink"
                      : "text-ink-mid hover:bg-hover hover:text-ink",
                  )}
                >
                  {row.pinnedAt !== null && <span className="shrink-0 text-copper">★</span>}
                  <span className="min-w-0 flex-1 truncate">{row.title}</span>
                  <span className="shrink-0 font-mono text-ink-faint">{`v${row.revisionNumber}`}</span>
                </button>
              ))}
              {switcherRows.length === 0 && (
                <p className="px-2 py-2 text-xs text-ink-dim">No other artifacts</p>
              )}
            </div>
          )}
        </div>

        <Chip tone="neutral" title={artifact.originContext.kind === "project" ? artifact.originContext.path : "Chat"}>
          {originLabel}
        </Chip>
        <Chip tone="neutral">{`v${code.revisionNumber}`}</Chip>
        {artifact.managed && (
          <Chip tone={surfaceStatus === "not-saved" ? "rose" : surfaceStatus === "saved" ? "signal" : "neutral"}>
            {statusChipLabel}
          </Chip>
        )}

        <span className="flex-1" />

        <Button size="xs" onClick={() => onOpenPicker("reference")}>
          @ Reference
        </Button>
        {canRefresh && (
          <Button size="xs" onClick={handleRefreshClick}>
            ↻ Refresh
          </Button>
        )}
        <Button
          size="xs"
          selected={drawerOpen}
          onClick={onToggleDrawer}
          aria-expanded={drawerOpen}
          data-artifacts-drawer-toggle
        >
          <span>Data &amp; History</span>
          {pendingCount > 0 && (
            <span className="ml-1 rounded-full bg-copper-wash px-1.5 font-mono text-[11px] leading-4 text-copper">
              {pendingCount}
            </span>
          )}
        </Button>
        <IconButton
          label={expanded ? "Close expanded view" : "Expand"}
          onClick={() => setExpanded((old) => !old)}
        >
          <span aria-hidden>⤢</span>
        </IconButton>

        <div className="relative">
          <span ref={overflowTriggerRef} className="inline-flex">
            <IconButton
              label="More artifact actions"
              onClick={() => setOverflowOpen((open) => !open)}
            >
              <span aria-hidden>⋯</span>
            </IconButton>
          </span>
          {overflowOpen && (
            <div
              ref={overflowMenuRef}
              role="menu"
              aria-label="Artifact actions"
              className="absolute right-0 top-full z-30 mt-1 w-52 rounded-lg border border-line-strong bg-overlay p-1 text-xs shadow-lg backdrop-glass"
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-ink-mid hover:bg-hover hover:text-ink"
                onClick={() => { setOverflowOpen(false); onPin(); }}
              >
                <span>{pinned ? "Unpin artifact" : "Pin artifact"}</span>
                <span aria-hidden>{pinned ? "★" : "☆"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded px-2.5 py-1.5 text-left text-ink-mid hover:bg-hover hover:text-ink"
                onClick={() => { setOverflowOpen(false); onRename(); }}
              >
                Rename…
              </button>
              {description.sourceTarget?.sessionId && (
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full rounded px-2.5 py-1.5 text-left text-ink-mid hover:bg-hover hover:text-ink"
                  onClick={() => {
                    setOverflowOpen(false);
                    if (description.sourceTarget) void useStore.getState().openArtifactSource(description.sourceTarget);
                  }}
                >
                  Open exact source
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded px-2.5 py-1.5 text-left text-ink-mid hover:bg-hover hover:text-ink"
                onClick={() => { setOverflowOpen(false); onExportHtml(); }}
              >
                Export HTML source…
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded px-2.5 py-1.5 text-left text-ink-mid hover:bg-hover hover:text-ink"
                onClick={() => { setOverflowOpen(false); onPrune(); }}
              >
                Prune old versions…
              </button>
              <div className="my-1 border-t border-line-soft" />
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded px-2.5 py-1.5 text-left text-rose hover:bg-rose/10"
                onClick={() => { setOverflowOpen(false); onDelete(); }}
              >
                Delete artifact…
              </button>
            </div>
          )}
        </div>

        <IconButton label="close dialog" onClick={onCloseArtifacts}>
          <IconClose />
        </IconButton>
      </header>

      {/* Main viewer body: full-canvas guest + optional slide-over drawer */}
      <div className="relative flex min-h-0 flex-1 flex-col @[56rem]:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error && (
            <p role="alert" className="mx-3 mt-3 shrink-0 break-words rounded border border-rose/30 bg-rose/5 p-2.5 text-xs text-rose">
              {error}
            </p>
          )}

          {isHistorical && (
            <div
              data-artifact-historical-banner
              className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-copper/30 bg-copper-wash/30 px-3 py-2 text-xs"
            >
              <span className="text-ink-mid">
                {`Viewing historical version: Revision v${code.revisionNumber} · ${CAUSE_LABELS[snapshot.cause] ?? snapshot.cause} (${relativeTime(snapshot.createdAt)})`}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {artifact.managed && isHistoricalSnapshot && (
                  <Button size="xs" onClick={() => onRestore(snapshot.dataSnapshotId)}>
                    Restore as new
                  </Button>
                )}
                <Button size="xs" variant="solid" onClick={() => onSelectArtifact({ artifactId: artifact.artifactId })}>
                  Return to latest
                </Button>
              </div>
            </div>
          )}

          {description.candidates.length > 0 && (
            <section
              aria-label="Draft candidates"
              data-artifact-candidate-banner
              className="shrink-0 space-y-2 border-b border-iris/30 bg-iris/5 px-3 py-2 text-xs"
            >
              {description.candidates.map((candidate) => (
                <div key={candidate.draft.draftId} data-artifact-candidate-id={candidate.draft.draftId} className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <Chip tone="iris">Draft candidate</Chip>
                      <span className="font-medium text-ink">{candidate.draft.title}</span>
                      <span className="text-ink-dim">
                        {candidate.stale
                          ? `Stale (based on v${candidate.baseRevisionNumber ?? "?"})`
                          : candidate.compatible
                            ? "Compatible contract"
                            : "Contract changed"}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {candidate.sourceTarget?.sessionId ? (
                        <Button
                          size="xs"
                          variant="solid"
                          disabled={candidateBusy !== null}
                          onClick={() => {
                            if (candidate.sourceTarget) void useStore.getState().openArtifactSource(candidate.sourceTarget);
                          }}
                        >
                          Open exact source
                        </Button>
                      ) : (
                        <span className="text-ink-dim">Source session unavailable</span>
                      )}
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={candidateBusy !== null}
                        onClick={() => void discardCandidate(candidate.draft.draftId)}
                      >
                        {candidateBusy === candidate.draft.draftId ? "Loading…" : "Discard"}
                      </Button>
                    </div>
                  </div>
                  <details className="text-ink-dim">
                    <summary className="cursor-pointer">Contract changes</summary>
                    <div className="mt-1">
                      <ArtifactContractDiff current={candidate.currentDefinition} candidate={candidate.definition} />
                    </div>
                  </details>
                </div>
              ))}
              {candidateError && <p role="alert" className="text-rose">{candidateError}</p>}
            </section>
          )}

          {/* Persistent guest canvas — never unmounted when toggling the drawer */}
          <dialog
            ref={previewRef}
            className={
              expanded
                ? "fixed inset-0 m-0 flex h-dvh max-h-none w-screen max-w-none flex-col border-0 bg-void p-3 text-ink [app-region:no-drag]"
                : "relative m-0 flex min-h-40 min-w-0 w-full max-w-none flex-1 flex-col border-0 bg-transparent p-0 text-inherit"
            }
            role={expanded ? "dialog" : "presentation"}
            aria-modal={expanded || undefined}
            aria-label={artifact.title}
            onCancel={(event) => {
              event.preventDefault();
              setExpanded(false);
            }}
          >
            {expanded && (
              <div
                className="mb-2 flex shrink-0 items-center justify-between gap-2"
                style={IS_ELECTRON && OVERLAY_INSET > 0 ? { paddingRight: OVERLAY_INSET } : undefined}
              >
                <span className="truncate text-sm font-medium text-ink">{artifact.title}</span>
                <Button size="xs" onClick={() => setExpanded(false)}>
                  Close expanded view
                </Button>
              </div>
            )}
            {preview ? (
              <ArtifactSurface
                source={preview.source}
                html={preview.html}
                title={artifact.title}
                managed={artifact.managed}
                inline={true}
                className="min-h-0 min-w-0 flex-1"
                onReload={onReloadPreview}
                onEscape={() => setExpanded(false)}
                onSurfaceReady={setSurfaceHandle}
                onStatusChange={setSurfaceStatus}
              />
            ) : (
              <div className="grid flex-1 place-items-center text-xs text-ink-dim">Loading preview…</div>
            )}
          </dialog>
        </div>

        {/* Slide-over Data & History drawer */}
        {drawerOpen && (
          <aside
            aria-label="Data and History"
            data-artifacts-drawer
            className="flex min-h-0 shrink-0 flex-col border-t border-line bg-sunken/70 backdrop-glass @[56rem]:w-[24rem] @[56rem]:border-l @[56rem]:border-t-0 max-h-[55%] @[56rem]:max-h-none"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div className="flex items-center gap-1" role="tablist" aria-label="Drawer sections">
                <Button
                  size="xs"
                  selected={drawerTab === "data"}
                  onClick={() => onDrawerTabChange("data")}
                >
                  <span>Data &amp; Captures</span>
                  {pendingCaptureCount > 0 && (
                    <span className="ml-1 rounded-full bg-copper-wash px-1 font-mono text-[10px] text-copper">
                      {pendingCaptureCount}
                    </span>
                  )}
                </Button>
                <Button
                  size="xs"
                  selected={drawerTab === "history"}
                  onClick={() => onDrawerTabChange("history")}
                >
                  History
                </Button>
              </div>
              <IconButton label="Close Data and History drawer" onClick={onToggleDrawer}>
                <IconClose />
              </IconButton>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 [scrollbar-gutter:stable]">
              {drawerTab === "data" ? (
                <>
                  {pendingCaptures.map((capture) => (
                    <ArtifactCaptureCard key={capture.captureId} description={description} capture={capture} />
                  ))}

                  <ArtifactDataSources
                    key={`${code.codeRevisionId}/${snapshot.dataSnapshotId}`}
                    description={description}
                  />

                  {activeRefreshes.length > 0 && (
                    <section aria-label="Refresh requests" className="space-y-2 border-t border-line-soft pt-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Refresh runs</h3>
                      {activeRefreshes.map((request) => {
                        const canDismiss =
                          request.status === "awaiting" ||
                          request.status === "failed" ||
                          request.status === "interrupted";
                        return (
                          <div
                            key={request.refreshRequestId}
                            className="space-y-1.5 rounded-md border border-line bg-surface/60 p-2.5 text-xs text-ink-mid"
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Chip
                                tone={
                                  request.status === "applied"
                                    ? "signal"
                                    : request.status === "failed"
                                      ? "rose"
                                      : "copper"
                                }
                              >
                                {request.status}
                              </Chip>
                              {request.scheduledBy && <Chip tone="neutral">{request.scheduledBy}</Chip>}
                              {request.autoApply && <Chip tone="neutral">auto-apply</Chip>}
                              <span
                                className="ml-auto text-ink-faint"
                                title={request.failure?.recordedAt ?? request.createdAt}
                              >
                                {relativeTime(request.failure?.recordedAt ?? request.createdAt)}
                              </span>
                            </div>
                            <p className="text-ink-dim">
                              {request.status === "failed"
                                ? `Not applied: ${request.failure?.message ?? ""}. Last saved data is unchanged.`
                                : request.status === "interrupted"
                                  ? "The refresh session stopped before reporting captured data. Last saved data is unchanged."
                                  : request.status === "applied"
                                    ? "Captured data applied."
                                    : "Awaiting a capture from the session. Nothing has been applied."}
                            </p>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {findOwner(appState, request.targetTabId) !== undefined && (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => void useStore.getState().openSession(request.targetTabId)}
                                >
                                  View run
                                </Button>
                              )}
                              {canDismiss && (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => onDismissRefresh(request.refreshRequestId)}
                                >
                                  Dismiss
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </section>
                  )}

                  {appliedCaptures.length > 0 && (
                    <details className="border-t border-line-soft pt-3 text-xs">
                      <summary className="cursor-pointer font-medium text-ink-dim">
                        {`Applied captures (${appliedCaptures.length})`}
                      </summary>
                      <div className="mt-2 space-y-2">
                        {appliedCaptures.map((capture) => (
                          <ArtifactCaptureCard key={capture.captureId} description={description} capture={capture} />
                        ))}
                      </div>
                    </details>
                  )}
                </>
              ) : (
                <section aria-label="Version history" className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface/60 p-2.5 text-xs">
                    <span
                      className="text-ink-mid"
                      title="Retained (logical) footprint of this artifact. Shared payloads mean per-artifact figures do not sum to the library total."
                    >
                      {`Retained ≈ ${formatBytes(description.retainedBytes)} of ${formatBytes(ARTIFACT_LIMITS.artifactBytes)}`}
                    </span>
                    <Button size="xs" onClick={onPrune}>
                      Prune old versions
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Code revisions</h3>
                    <div className="space-y-1.5">
                      {description.revisions.map((rev) => {
                        const isSelected = rev.codeRevisionId === code.codeRevisionId;
                        const isCurrent = rev.codeRevisionId === artifact.currentCodeRevisionId;
                        return (
                          <button
                            key={rev.codeRevisionId}
                            type="button"
                            onClick={() =>
                              onSelectArtifact({
                                artifactId: artifact.artifactId,
                                codeRevisionId: rev.codeRevisionId,
                                dataSnapshotId: snapshot.dataSnapshotId,
                              })
                            }
                            className={cn(
                              "flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors",
                              isSelected
                                ? "border-copper bg-copper-wash/30 text-ink"
                                : "border-line bg-surface/60 text-ink-mid hover:border-line-strong hover:text-ink",
                            )}
                          >
                            <span className="font-mono font-medium">{`v${rev.revisionNumber}`}</span>
                            <span className="flex items-center gap-1.5">
                              {isCurrent && <Chip tone="signal">current</Chip>}
                              <span className="text-ink-faint" title={rev.createdAt}>
                                {relativeTime(rev.createdAt)}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Data snapshots</h3>
                    <div className="space-y-1.5">
                      {description.snapshots.map((snap) => {
                        const isSelected = snap.dataSnapshotId === snapshot.dataSnapshotId;
                        const isCurrent = snap.dataSnapshotId === artifact.currentDataSnapshotId;
                        return (
                          <div
                            key={snap.dataSnapshotId}
                            className={cn(
                              "flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors",
                              isSelected
                                ? "border-copper bg-copper-wash/30 text-ink"
                                : "border-line bg-surface/60 text-ink-mid hover:border-line-strong hover:text-ink",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                onSelectArtifact({
                                  artifactId: artifact.artifactId,
                                  codeRevisionId: code.codeRevisionId,
                                  dataSnapshotId: snap.dataSnapshotId,
                                })
                              }
                              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                            >
                              <Chip tone="neutral">{CAUSE_LABELS[snap.cause] ?? snap.cause}</Chip>
                              <span className="font-mono text-ink-dim">{`r${snap.stateRevision}`}</span>
                              {isCurrent && <Chip tone="signal">current</Chip>}
                              <span className="ml-auto text-ink-faint" title={snap.createdAt}>
                                {relativeTime(snap.createdAt)}
                              </span>
                            </button>
                            {artifact.managed && !isCurrent && (
                              <Button size="xs" variant="ghost" onClick={() => onRestore(snap.dataSnapshotId)}>
                                Restore
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <details className="border-t border-line-soft pt-3 text-xs text-ink-dim">
                    <summary className="cursor-pointer font-medium">Source IDs</summary>
                    <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 break-all font-mono text-[11px]">
                      <dt className="text-ink-faint">Artifact</dt><dd>{artifact.artifactId}</dd>
                      <dt className="text-ink-faint">Code</dt><dd>{code.codeRevisionId}</dd>
                      <dt className="text-ink-faint">Snapshot</dt><dd>{snapshot.dataSnapshotId}</dd>
                      <dt className="text-ink-faint">Draft</dt><dd>{artifact.sourceDraftId}</dd>
                    </dl>
                  </details>
                </section>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
