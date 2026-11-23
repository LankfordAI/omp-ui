import { diffArtifactDefinitions, type ArtifactDefinition } from "@omp-ui/core/artifacts";

/**
 * Field-level contract difference between the accepted code version and a
 * candidate. Dataset titles/order are compatibility-neutral and never render
 * as changes. Strings shown here are agent-authored: plain React text nodes,
 * never HTML.
 */
export function ArtifactContractDiff({ current, candidate }: { current: ArtifactDefinition | null; candidate: ArtifactDefinition | null }) {
  const diff = diffArtifactDefinitions(current, candidate);
  const empty = diff.protocol === null && diff.stateSchema === null && diff.datasetsAdded.length === 0 && diff.datasetsRemoved.length === 0 && diff.datasetsChanged.length === 0;
  if (empty) return <p className="break-words">Same managed contract as the current version.</p>;
  return <ul className="space-y-1">
    {diff.protocol !== null && <li className="break-words">{`Protocol version: ${String(diff.protocol.current ?? "—")} → ${String(diff.protocol.candidate ?? "—")}`}</li>}
    {diff.stateSchema !== null && <li className="break-words">{`State schema: ${diff.stateSchema.current ?? "—"} → ${diff.stateSchema.candidate ?? "—"}`}</li>}
    {diff.datasetsAdded.map((dataset) => <li key={`add-${dataset.id}`} className="break-words">{`Dataset added: ${dataset.id} (${dataset.schema})`}</li>)}
    {diff.datasetsRemoved.map((dataset) => <li key={`remove-${dataset.id}`} className="break-words">{`Dataset removed: ${dataset.id} (${dataset.schema})`}</li>)}
    {diff.datasetsChanged.map((dataset) => <li key={`change-${dataset.id}`} className="break-words">{`Dataset ${dataset.id} schema changed: ${dataset.currentSchema} → ${dataset.candidateSchema}`}</li>)}
  </ul>;
}
