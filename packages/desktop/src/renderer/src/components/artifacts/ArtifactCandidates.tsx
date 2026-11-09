import { useState } from "react";
import type { ArtifactDescription } from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { Button } from "../ui";

/** Candidates remain draft metadata; review/Keep stays in the ordinary source session. */
export function ArtifactCandidates({description}: {description: ArtifactDescription}) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (description.candidates.length === 0) return null;
  const discard = async (draftId: string): Promise<void> => {
    setBusy(draftId); setError(null);
    try {
      await backend.artifactDiscardDraft({draftId});
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) { setError(displayMessage(reason)); }
    finally { setBusy(null); }
  };
  return <section aria-label={t("artifacts.candidates")} className="min-w-0 space-y-3 border-b border-line pb-4">
    <h3 className="text-sm font-semibold">{t("artifacts.candidates")}</h3>
    <p className="text-xs leading-relaxed text-ink-dim">{t("artifacts.keepHint")}</p>
    {description.candidates.map(candidate => <article key={candidate.draft.draftId} data-artifact-candidate-id={candidate.draft.draftId} className="min-w-0 space-y-2 rounded border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h4 className="break-words text-sm font-medium">{candidate.draft.title}</h4><span className="text-xs text-ink-dim">{t("artifacts.draftCandidate")}</span></div>
      <p className="text-xs leading-relaxed text-ink-dim">{t(candidate.stale ? "artifacts.candidateStale" : candidate.compatible ? "artifacts.contractHint" : "artifacts.candidateSchema")}</p>
      {candidate.draft.previewDataSnapshotId !== null && candidate.draft.previewDataSnapshotId !== description.artifact.currentDataSnapshotId && <p className="text-xs leading-relaxed text-ink-dim">{t("artifacts.candidateOldData")}</p>}
      <details><summary className="cursor-pointer text-xs">{t("artifacts.schema")}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-ink-dim">{JSON.stringify(candidate.definition, null, 2)}</pre></details>
      <div className="flex flex-wrap items-center gap-2">
        {candidate.sourceTarget?.sessionId ? <Button disabled={busy !== null} onClick={() => { if (candidate.sourceTarget) void useStore.getState().openArtifactSource(candidate.sourceTarget); }}>{t("artifacts.openSource")}</Button> : <span className="text-xs text-ink-dim">{t("artifacts.sourceUnavailable")}</span>}
        <Button disabled={busy !== null} onClick={() => void discard(candidate.draft.draftId)}>{t(busy === candidate.draft.draftId ? "artifacts.loading" : "artifacts.discardCandidate")}</Button>
      </div>
    </article>)}
    {error && <p role="alert" className="text-sm text-rose">{error}</p>}
  </section>;
}
