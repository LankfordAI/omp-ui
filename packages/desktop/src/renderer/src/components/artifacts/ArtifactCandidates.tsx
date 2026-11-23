import { useState } from "react";
import type { ArtifactDescription } from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { useStore } from "../../store";
import { Button } from "../ui";
import { ArtifactContractDiff } from "./ArtifactContractDiff";

/** Candidates remain draft metadata; review/Keep stays in the ordinary source session. */
export function ArtifactCandidates({description}: {description: ArtifactDescription}) {
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
  return <section aria-label="Draft candidates" className="min-w-0 space-y-3 border-b border-line pb-4">
    <h3 className="text-sm font-semibold">Draft candidates</h3>
    <p className="text-xs leading-relaxed text-ink-dim">Only kept versions enter the library. Accepting compatible code keeps existing saved state and data.</p>
    {description.candidates.map(candidate => <article key={candidate.draft.draftId} data-artifact-candidate-id={candidate.draft.draftId} className="min-w-0 space-y-2 rounded border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h4 className="break-words text-sm font-medium">{candidate.draft.title}</h4><span className="text-xs text-ink-dim">Draft candidate</span></div>
      <p className="text-xs leading-relaxed text-ink-dim">{candidate.stale ? "Based on older accepted code. Keep as new in the source session, or reference the current version to discuss another candidate." : candidate.compatible ? "Same declared data contract, not a verified migration. Accepting code retains the existing saved state and datasets." : "Different declared data contract. Keep as new; existing data will not be migrated."}</p>
      {candidate.stale && candidate.baseRevisionNumber !== null && <p className="break-words text-xs text-ink-dim">{`Based on v${candidate.baseRevisionNumber} — current is v${description.revisions[0]?.revisionNumber ?? 0}`}</p>}
      {candidate.draft.previewDataSnapshotId !== null && candidate.draft.previewDataSnapshotId !== description.artifact.currentDataSnapshotId && <p className="text-xs leading-relaxed text-ink-dim">The preview used an earlier data snapshot. Compatible acceptance retains current saved inputs and datasets.</p>}
      <details><summary className="cursor-pointer text-xs">Contract changes</summary><div className="text-xs text-ink-dim"><ArtifactContractDiff current={candidate.currentDefinition} candidate={candidate.definition} /></div></details>
      <div className="flex flex-wrap items-center gap-2">
        {candidate.sourceTarget?.sessionId ? <Button disabled={busy !== null} onClick={() => { if (candidate.sourceTarget) void useStore.getState().openArtifactSource(candidate.sourceTarget); }}>Open exact source</Button> : <span className="text-xs text-ink-dim">The exact source session is unavailable. Kept code and data remain available.</span>}
        <Button disabled={busy !== null} onClick={() => void discard(candidate.draft.draftId)}>{busy === candidate.draft.draftId ? "Loading…" : "Discard candidate"}</Button>
      </div>
    </article>)}
    {error && <p role="alert" className="text-sm text-rose">{error}</p>}
  </section>;
}
