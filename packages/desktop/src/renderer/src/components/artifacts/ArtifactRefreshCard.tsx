import { findOwner, useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { Button } from "../ui";

/**
 * One requested dataset refresh as the transcript saw it on the wire
 * (ADR-0092): a slim row naming the artifact, never the request uuid in the
 * body — that rides the tooltip for support. A legacy prompt's marker row is
 * the same shape minus datasets and the library link: without a paired grant
 * there is no artifact to open. No live status here; the library owns it.
 */
export function ArtifactRefreshCard({ entry, tabId }: {
  /** A wire entry, or a legacy display-only marker (title optional, no
   *  artifactId): the artifactId gates the library link. */
  entry: { refreshRequestId: string; title?: string; artifactId?: string; datasetIds?: string[] };
  tabId?: string;
}) {
  const t = useT();
  // The same library-enabled + locally-owned rpc-ui-tab gate as
  // ArtifactCaptureTranscriptCard: a foreign or PTY tab has no library to open.
  const allowed = useStore((s) => entry.artifactId !== undefined && s.state?.artifactLibraryEnabled === true && tabId !== undefined && findOwner(s.state, tabId)?.instanceId === null && findOwner(s.state, tabId)?.record.mode === "rpc-ui");
  const datasets = entry.datasetIds ?? [];
  return <div className="flex flex-wrap items-center gap-2 rounded border border-line px-2 py-1 text-xs" title={t("artifacts.refreshChip", { title: entry.title ?? "Artifact" }) + ` (${entry.refreshRequestId}${datasets.length > 0 ? `; ${datasets.join(", ")}` : ""})`}>
    <span aria-hidden className="shrink-0 text-ink-mid">↻</span>
    <span className="font-medium">{t("artifacts.refreshRequested")}</span>
    <span className="min-w-0 max-w-[24rem] truncate text-ink-dim">{entry.title}</span>
    {datasets.length > 0 && <span className="min-w-0 truncate text-ink-dim">{t("artifacts.refreshRequestedDatasets", { datasets: datasets.join(", ") })}</span>}
    {allowed && <Button variant="ghost" className="ml-auto shrink-0 px-1.5 py-0 text-xs" onClick={() => useStore.getState().openArtifacts({ artifactId: entry.artifactId!, panel: "data" })}>{t("artifacts.openLibrary")}</Button>}
  </div>;
}
