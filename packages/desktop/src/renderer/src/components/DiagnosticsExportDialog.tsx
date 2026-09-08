import { useCallback, useEffect, useState } from "react";
import type { DiagnosticsPreview } from "@omp-ui/core/types";
import { backend, displayMessage } from "../backend";
import { IS_ELECTRON } from "../lib/platform";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { Button, ConfirmDialog } from "./ui";

/**
 * The diagnostic-bundle export dialog (issue #413): preview rows from the
 * main-process manifest, an explicit warned opt-in for transcripts, and one
 * Save/Create action. All backend calls live here, not in the store slice —
 * the same shape as ProjectPicker.
 */

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const DEFAULT_BASENAME = "omp-ui-diagnostics.zip";

export function DiagnosticsExportDialog() {
  const t = useT();
  const close = useStore((s) => s.closeDiagnosticsDialog);
  const reportError = useStore((s) => s.reportError);
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [includeTranscripts, setIncludeTranscripts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [donePath, setDonePath] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setPreviewFailed(false);
    try {
      setPreview(await backend.previewDiagnosticsBundle());
    } catch (err) {
      reportError(err);
      setPreviewFailed(true);
    }
  }, [reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      let destinationPath: string | null = null;
      if (IS_ELECTRON) {
        destinationPath = await backend.chooseDiagnosticsPath(DEFAULT_BASENAME);
        // Cancel keeps the dialog open for a retry (nothing was written).
        if (destinationPath === null) return;
      }
      const result = await backend.exportDiagnosticsBundle({
        includeTranscripts,
        destinationPath,
      });
      setDonePath(result.path);
    } catch (err) {
      reportError(new Error(displayMessage(err)));
    } finally {
      setBusy(false);
    }
  };

  if (donePath !== null) {
    return (
      <ConfirmDialog
        kicker={t("dialog.diagnostics.kicker")}
        title={t("dialog.diagnostics.done")}
        tone="signal"
        onClose={close}
        actions={
          <Button size="sm" onClick={close}>
            {t("common.overlay.close")}
          </Button>
        }
      >
        <p data-selectable className="break-all font-mono text-xs text-ink">
          {donePath}
        </p>
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      kicker={t("dialog.diagnostics.kicker")}
      title={t("dialog.diagnostics.title")}
      tone="neutral"
      onClose={close}
      actions={
        <>
          <Button size="sm" onClick={close}>
            {t("dialog.diagnostics.cancel")}
          </Button>
          {previewFailed ? (
            <Button size="sm" onClick={() => void load()}>
              {t("dialog.diagnostics.retry")}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={preview === null || busy}
              onClick={() => void save()}
            >
              {busy ? t("dialog.diagnostics.busy") : IS_ELECTRON ? t("dialog.diagnostics.save") : t("dialog.diagnostics.saveWeb")}
            </Button>
          )}
        </>
      }
    >
      {preview === null && !previewFailed && (
        <div className="space-y-2" aria-busy="true">
          <p className="text-xs text-ink-mid">{t("dialog.diagnostics.loading")}</p>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-raised" />
          ))}
        </div>
      )}
      {preview !== null && (
        <div className="space-y-3">
          <div>
            <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim">
              {t("dialog.diagnostics.sectionsHeading")}
            </h3>
            <ul className="space-y-1">
              {preview.sections
                .filter((section) => section.included)
                .map((section) => (
                  <li
                    key={section.id}
                    className="flex items-baseline justify-between gap-3 text-xs"
                  >
                    <span className="font-mono text-ink">{section.id}</span>
                    <span className="text-ink-mid">
                      {section.files.length} · {humanSize(section.totalBytes)}
                    </span>
                  </li>
                ))}
            </ul>
            <p className="mt-2 text-xs text-ink-mid">
              {t("dialog.diagnostics.totalLabel", {
                size: humanSize(preview.totalBytes),
              })}
            </p>
          </div>
          {preview.warnings.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-copper">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-mid transition-colors hover:border-line-strong hover:text-ink">
            <input
              type="checkbox"
              checked={includeTranscripts}
              onChange={(event) => setIncludeTranscripts(event.target.checked)}
              className="size-3.5 accent-current"
            />
            {t("dialog.diagnostics.includeTranscripts")}
          </label>
          {includeTranscripts && (
            <p className="text-xs leading-relaxed text-rose">
              {t("dialog.diagnostics.transcriptsWarning")}
            </p>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
