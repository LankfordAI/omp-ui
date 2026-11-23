import { useEffect, useState } from "react";
import {
  ARTIFACT_LIMITS,
  ARTIFACT_PRUNE_KEEP_DEFAULTS,
  type ArtifactDescription,
  type ArtifactListItem,
} from "@omp-ui/core/artifacts";
import { composeHtmlArtifactDocument, htmlArtifactThemeCss } from "@omp-ui/core/html-artifact";
import { backend, displayMessage } from "../../backend";
import { downloadBlob, readAllPart, safeDownloadName } from "../../lib/artifact-parts";
import { IS_ELECTRON } from "../../lib/platform";
import { useTheme } from "../../lib/themes";
import { useStore } from "../../store";
import { Button, Modal } from "../ui";
import { ArtifactGallery } from "./ArtifactGallery";
import { ArtifactReferencePicker } from "./ArtifactReferencePicker";
import { ArtifactViewer } from "./ArtifactViewer";
import { clearThumbnailCache } from "./artifact-thumbnail-cache";

/**
 * Two-mode Artifacts shell (#1307):
 * - `selection.artifactId === null` → Gallery card grid / list
 * - `selection.artifactId !== null` → Full-Canvas Viewer + on-demand Data & History drawer
 * Owns shared confirmed modals so both Gallery quick actions and Viewer actions stay consistent.
 */
export function Artifacts() {
  const theme = useTheme();
  const selection = useStore((s) => s.artifacts);
  const revision = useStore((s) => s.artifactLibraryRevision);
  const lastChange = useStore((s) => s.artifactLastChange);
  const open = useStore((s) => s.openArtifacts);
  const close = useStore((s) => s.closeArtifacts);
  const appState = useStore((s) => s.state);
  const routinesState = useStore((s) => s.routinesState);
  const refreshRoutines = useStore((s) => s.refreshRoutines);

  const [description, setDescription] = useState<ArtifactDescription | null>(null);
  const [preview, setPreview] = useState<{
    html: string;
    source: { artifactId: string; codeRevisionId: string; dataSnapshotId: string };
  } | null>(null);
  const [previewReload, setPreviewReload] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"data" | "history">("data");

  // Shared modals — `pickerTarget` supports both gallery hover actions and the active viewer.
  const [pickerState, setPickerState] = useState<{
    mode: "reference" | "refresh";
    description: ArtifactDescription;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismissBusy, setDismissBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);

  const selectedId = selection?.artifactId ?? null;
  const selectedCode = selection?.codeRevisionId;
  const selectedSnapshot = selection?.dataSnapshotId;

  // Populate scheduled-refresh chips on cold gallery open.
  useEffect(() => {
    if (appState?.routinesEnabled === true && routinesState === null) {
      void refreshRoutines(null);
    }
  }, [appState?.routinesEnabled, routinesState, refreshRoutines]);

  // Clear thumbnail cache if library is disabled.
  useEffect(() => {
    if (appState?.artifactLibraryEnabled !== true || lastChange?.kind === "disabled") {
      clearThumbnailCache();
    }
  }, [appState?.artifactLibraryEnabled, lastChange]);

  // Drawer opens automatically when deep-linked with captureId or explicit data/history panel;
  // ordinary card opens keep the drawer closed for full-canvas viewing.
  useEffect(() => {
    if (selection?.captureId || selection?.panel === "data") {
      setDrawerTab("data");
      setDrawerOpen(true);
    } else if (selection?.panel === "history") {
      setDrawerTab("history");
      setDrawerOpen(true);
    } else if (selectedId !== null) {
      setDrawerOpen(false);
    }
  }, [selectedId, selection?.captureId, selection?.panel]);

  // Scroll targeted capture card into view once drawer renders it.
  useEffect(() => {
    if (!selection?.captureId || !drawerOpen || drawerTab !== "data") return;
    document.getElementById(`artifact-capture-${selection.captureId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [selection?.captureId, drawerOpen, drawerTab, description?.artifact.artifactId]);

  // Clear viewer metadata when leaving the viewer or switching to another artifact.
  // Changing only codeRevisionId/dataSnapshotId keeps ArtifactViewer (and History drawer scroll) mounted.
  useEffect(() => {
    setDescription(null);
  }, [selectedId]);

  // Load description for the selected artifact; follows library revisions independently
  // so Data & History stay fresh without remounting the active guest writer.
  useEffect(() => {
    if (!selectedId) return;
    let canceled = false;
    void backend
      .artifactDescribe({
        artifactId: selectedId,
        ...(selectedCode ? { codeRevisionId: selectedCode } : {}),
        ...(selectedSnapshot ? { dataSnapshotId: selectedSnapshot } : {}),
      })
      .then((next) => {
        if (!canceled) {
          setDescription(next);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!canceled) setError(displayMessage(reason));
      });
    return () => {
      canceled = true;
    };
  }, [selectedId, selectedCode, selectedSnapshot, revision]);

  // Load preview HTML only when the selected artifact/version changes or the user
  // explicitly reloads. Never depend on `description` or `revision`: a managed
  // writer's own `saveState()` advances `currentDataSnapshotId` and must keep its
  // guest mounted; external head changes revoke the writer and surface Reload.
  useEffect(() => {
    let canceled = false;
    setPreview(null);
    setError(null);
    if (!selectedId) return;
    void (async () => {
      const next = await backend.artifactDescribe({
        artifactId: selectedId,
        ...(selectedCode ? { codeRevisionId: selectedCode } : {}),
        ...(selectedSnapshot ? { dataSnapshotId: selectedSnapshot } : {}),
      });
      if (canceled) return;
      const raw = await readAllPart(
        {
          artifactId: selectedId,
          codeRevisionId: next.code.codeRevisionId,
          dataSnapshotId: next.snapshot.dataSnapshotId,
          part: "definition",
        },
        { maxBytes: ARTIFACT_LIMITS.envelopeBytes },
      );
      if (canceled) return;
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("html" in parsed) ||
        typeof parsed.html !== "string"
      ) {
        throw new Error("The saved definition is invalid.");
      }
      setPreview({
        html: parsed.html,
        source: {
          artifactId: selectedId,
          codeRevisionId: next.code.codeRevisionId,
          dataSnapshotId: next.snapshot.dataSnapshotId,
        },
      });
    })().catch((reason: unknown) => {
      if (!canceled) setError(displayMessage(reason));
    });
    return () => {
      canceled = true;
    };
  }, [selectedId, selectedCode, selectedSnapshot, previewReload]);

  // #1312: while following latest, an external head advance — refresh capture applied,
  // restore, or a new code revision — must remount the guest so it reloads against the
  // new head. A snapshot whose cause is "user-edit" is the mounted guest's own
  // saveState(); keep it mounted across that. Pinned (historical) views never bump.
  useEffect(() => {
    if (!description || preview === null) return;
    if (selectedCode || selectedSnapshot) return;
    const headCode = description.artifact.currentCodeRevisionId;
    const headSnapshot = description.artifact.currentDataSnapshotId;
    if (preview.source.codeRevisionId === headCode && preview.source.dataSnapshotId === headSnapshot) return;
    const cause = description.snapshots.find((row) => row.dataSnapshotId === headSnapshot)?.cause ?? description.snapshot.cause;
    if (preview.source.codeRevisionId !== headCode || cause !== "user-edit") {
      setPreviewReload((n) => n + 1);
    }
  }, [description, preview, selectedCode, selectedSnapshot]);

  const handleGalleryQuickAction = async (row: ArtifactListItem, mode: "reference" | "refresh"): Promise<void> => {
    setError(null);
    try {
      const desc = await backend.artifactDescribe({ artifactId: row.artifactId });
      setPickerState({ mode, description: desc });
    } catch (reason) {
      setError(displayMessage(reason));
    }
  };

  const handlePinCurrent = async (): Promise<void> => {
    if (!description) return;
    setError(null);
    try {
      await backend.artifactPin({
        artifactId: description.artifact.artifactId,
        expectedGeneration: description.artifact.generation,
        pinned: description.artifact.pinnedAt === null,
      });
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) {
      setError(displayMessage(reason));
    }
  };

  const remove = async (): Promise<void> => {
    if (!description) return;
    setDeleteBusy(true);
    try {
      await backend.artifactDelete({
        artifactId: description.artifact.artifactId,
        expectedGeneration: description.artifact.generation,
      });
      setDeleting(false);
      open();
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) {
      setError(displayMessage(reason));
    } finally {
      setDeleteBusy(false);
    }
  };

  const dismiss = async (): Promise<void> => {
    if (!dismissing) return;
    setDismissBusy(true);
    try {
      await backend.artifactDismissRefresh({ refreshRequestId: dismissing });
      setDismissing(null);
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) {
      setError(displayMessage(reason));
    } finally {
      setDismissBusy(false);
    }
  };

  const rename = async (): Promise<void> => {
    if (!description) return;
    setRenameBusy(true);
    try {
      await backend.artifactRename({
        artifactId: description.artifact.artifactId,
        expectedGeneration: description.artifact.generation,
        title: renameTitle,
      });
      setRenaming(false);
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) {
      setError(displayMessage(reason));
    } finally {
      setRenameBusy(false);
    }
  };

  const prune = async (): Promise<void> => {
    if (!description) return;
    setPruneBusy(true);
    try {
      await backend.artifactPrune({
        artifactId: description.artifact.artifactId,
        expectedGeneration: description.artifact.generation,
        ...ARTIFACT_PRUNE_KEEP_DEFAULTS,
      });
      setPruning(false);
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) {
      setError(displayMessage(reason));
    } finally {
      setPruneBusy(false);
    }
  };

  const restore = async (): Promise<void> => {
    if (!description || restoring === null) return;
    setRestoreBusy(true);
    try {
      await backend.artifactRestoreSnapshot({
        artifactId: description.artifact.artifactId,
        dataSnapshotId: restoring,
        expectedCodeRevisionId: description.artifact.currentCodeRevisionId,
      });
      setRestoring(null);
      open({ artifactId: description.artifact.artifactId });
      setPreviewReload((n) => n + 1);
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) {
      setError(displayMessage(reason));
    } finally {
      setRestoreBusy(false);
    }
  };

  const exportHtml = async (): Promise<void> => {
    if (!description) return;
    setExportBusy(true);
    try {
      if (IS_ELECTRON) {
        await backend.artifactExportHtmlSource({
          artifactId: description.artifact.artifactId,
          codeRevisionId: description.code.codeRevisionId,
          theme: { dark: theme.dark, tokens: theme.tokens },
        });
      } else {
        const page = await readAllPart({
          artifactId: description.artifact.artifactId,
          codeRevisionId: description.code.codeRevisionId,
          dataSnapshotId: description.snapshot.dataSnapshotId,
          part: "definition",
        });
        const parsed: unknown = JSON.parse(page);
        const html =
          typeof parsed === "object" && parsed !== null && "html" in parsed && typeof parsed.html === "string"
            ? parsed.html
            : null;
        if (html === null) throw new Error("The saved definition is invalid.");
        downloadBlob(
          safeDownloadName(description.artifact.title, "html"),
          "text/html",
          composeHtmlArtifactDocument(html, htmlArtifactThemeCss(theme.tokens, theme.dark), false),
        );
      }
      setExportingHtml(false);
    } catch (reason) {
      setError(displayMessage(reason));
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <section className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-void" aria-label="Artifacts">
      {selectedId === null ? (
        <ArtifactGallery
          onOpenArtifact={(artifactId, opts) => open({ artifactId, ...opts })}
          onQuickAction={(row, mode) => void handleGalleryQuickAction(row, mode)}
          onClose={close}
        />
      ) : description ? (
        <ArtifactViewer
          description={description}
          preview={preview}
          error={error}
          drawerOpen={drawerOpen}
          drawerTab={drawerTab}
          onToggleDrawer={() => setDrawerOpen((prev) => !prev)}
          onDrawerTabChange={setDrawerTab}
          onBackToGallery={() => open()}
          onSelectArtifact={(next) => open(next)}
          onReloadPreview={() => setPreviewReload((n) => n + 1)}
          onOpenPicker={(mode) => setPickerState({ mode, description })}
          onPin={() => void handlePinCurrent()}
          onRename={() => {
            setRenameTitle(description.artifact.title);
            setRenaming(true);
          }}
          onExportHtml={() => setExportingHtml(true)}
          onPrune={() => setPruning(true)}
          onDelete={() => setDeleting(true)}
          onRestore={(snapId) => setRestoring(snapId)}
          onDismissRefresh={(reqId) => setDismissing(reqId)}
          onCloseArtifacts={close}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-2 border-b border-line chrome-void px-3 py-2">
            <Button size="xs" variant="ghost" onClick={() => open()}>
              ← All artifacts
            </Button>
          </header>
          <div className="grid flex-1 place-items-center p-6 text-sm text-ink-dim">
            {error ? <p role="alert" className="text-rose">{error}</p> : "Loading artifact…"}
          </div>
        </div>
      )}

      {pickerState && (
        <ArtifactReferencePicker
          description={pickerState.description}
          mode={pickerState.mode}
          onClose={() => setPickerState(null)}
          onRefreshStarted={() => {
            if (selectedId === pickerState.description.artifact.artifactId) {
              setDrawerTab("data");
              setDrawerOpen(true);
            }
          }}
        />
      )}

      {deleting && description && (
        <Modal
          labelledBy="artifact-delete-title"
          onClose={() => { if (!deleteBusy) setDeleting(false); }}
          width="w-[min(30rem,96vw)]"
        >
          <div className="space-y-4 p-4">
            <h2 id="artifact-delete-title" className="text-base font-semibold">
              Delete this artifact and its history?
            </h2>
            <p className="text-sm text-ink-mid">
              Deletes kept code, saved state, data snapshots, capture drafts, and reference grants. Session transcripts remain, but old references stop resolving. This cannot be undone.
            </p>
            {error && <p role="alert" className="text-sm text-rose">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={deleteBusy} onClick={() => setDeleting(false)}>Cancel</Button>
              <Button disabled={deleteBusy} variant="solid" onClick={() => void remove()}>Delete</Button>
            </div>
          </div>
        </Modal>
      )}

      {dismissing !== null && (
        <Modal
          labelledBy="artifact-dismiss-title"
          onClose={() => { if (!dismissBusy) setDismissing(null); }}
          width="w-[min(30rem,96vw)]"
        >
          <div className="space-y-4 p-4">
            <h2 id="artifact-dismiss-title" className="text-base font-semibold">
              Dismiss this refresh request?
            </h2>
            <p className="text-sm text-ink-mid">
              The request stops appearing here and later captures for it will be refused. The run itself is not stopped — it keeps running until it finishes on its own.
            </p>
            {error && <p role="alert" className="text-sm text-rose">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={dismissBusy} onClick={() => setDismissing(null)}>Cancel</Button>
              <Button disabled={dismissBusy} variant="solid" onClick={() => void dismiss()}>Dismiss</Button>
            </div>
          </div>
        </Modal>
      )}

      {renaming && description && (
        <Modal
          labelledBy="artifact-rename-title"
          onClose={() => { if (!renameBusy) setRenaming(false); }}
          width="w-[min(30rem,96vw)]"
        >
          <div className="space-y-4 p-4">
            <h2 id="artifact-rename-title" className="text-base font-semibold">Rename artifact</h2>
            <p className="text-sm text-ink-mid">
              Composer chips and transcript cards keep showing the title from when the artifact was kept until they are re-attached.
            </p>
            <label className="block space-y-1 text-sm">
              <span className="sr-only">Rename artifact</span>
              <input
                autoFocus
                type="text"
                maxLength={ARTIFACT_LIMITS.titleChars}
                value={renameTitle}
                onChange={(event) => setRenameTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && renameTitle.trim()) {
                    event.preventDefault();
                    void rename();
                  }
                }}
                className="w-full min-w-0 rounded border border-line bg-raised px-3 py-2 text-sm outline-none focus-visible:border-copper"
              />
            </label>
            {error && <p role="alert" className="text-sm text-rose">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={renameBusy} onClick={() => setRenaming(false)}>Cancel</Button>
              <Button disabled={renameBusy || !renameTitle.trim()} variant="solid" onClick={() => void rename()}>Save</Button>
            </div>
          </div>
        </Modal>
      )}

      {pruning && description && (
        <Modal
          labelledBy="artifact-prune-title"
          onClose={() => { if (!pruneBusy) setPruning(false); }}
          width="w-[min(30rem,96vw)]"
        >
          <div className="space-y-4 p-4">
            <h2 id="artifact-prune-title" className="text-base font-semibold">Prune old versions?</h2>
            <p className="text-sm text-ink-mid">
              {`The newest ${ARTIFACT_PRUNE_KEEP_DEFAULTS.keepRevisions} code versions and ${ARTIFACT_PRUNE_KEEP_DEFAULTS.keepSnapshots} data versions are kept, along with every version a reference, capture, or candidate still uses.`}
            </p>
            {error && <p role="alert" className="text-sm text-rose">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={pruneBusy} onClick={() => setPruning(false)}>Cancel</Button>
              <Button disabled={pruneBusy} variant="solid" onClick={() => void prune()}>Prune</Button>
            </div>
          </div>
        </Modal>
      )}

      {exportingHtml && description && (
        <Modal
          labelledBy="artifact-export-html-title"
          onClose={() => { if (!exportBusy) setExportingHtml(false); }}
          width="w-[min(30rem,96vw)]"
        >
          <div className="space-y-4 p-4">
            <h2 id="artifact-export-html-title" className="text-base font-semibold">Export HTML source?</h2>
            <p className="text-sm text-ink-mid">
              The saved file runs outside omp-ui&apos;s protections, in a normal browser tab with full network access. Interactive behavior is not included — this exports the static (scripts-off) document only.
            </p>
            {description.artifact.managed && (
              <p className="text-sm text-ink-dim">Saved state and datasets are not embedded in the exported file.</p>
            )}
            {error && <p role="alert" className="text-sm text-rose">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={exportBusy} onClick={() => setExportingHtml(false)}>Cancel</Button>
              <Button disabled={exportBusy} variant="solid" onClick={() => void exportHtml()}>Export HTML</Button>
            </div>
          </div>
        </Modal>
      )}

      {restoring !== null && description && (
        <Modal
          labelledBy="artifact-restore-title"
          onClose={() => { if (!restoreBusy) setRestoring(null); }}
          width="w-[min(30rem,96vw)]"
        >
          <div className="space-y-4 p-4">
            <h2 id="artifact-restore-title" className="text-base font-semibold">Restore this version?</h2>
            <p className="text-sm text-ink-mid">
              This creates a new current data version from the selected one. Manual edits since then are superseded (not deleted — history keeps them). In-flight refresh captures will fail their dataset check and need a new refresh.
            </p>
            {error && <p role="alert" className="text-sm text-rose">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={restoreBusy} onClick={() => setRestoring(null)}>Cancel</Button>
              <Button disabled={restoreBusy} variant="solid" onClick={() => void restore()}>Restore</Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
