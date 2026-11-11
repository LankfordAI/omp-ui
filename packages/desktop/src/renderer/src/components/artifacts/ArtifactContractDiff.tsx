import { diffArtifactDefinitions, type ArtifactDefinition } from "@omp-ui/core/artifacts";
import { useT } from "../../lib/i18n";

/**
 * Field-level contract difference between the accepted code version and a
 * candidate. Dataset titles/order are compatibility-neutral and never render
 * as changes. Strings shown here are agent-authored: plain React text nodes,
 * never HTML.
 */
export function ArtifactContractDiff({ current, candidate }: { current: ArtifactDefinition | null; candidate: ArtifactDefinition | null }) {
  const t = useT();
  const diff = diffArtifactDefinitions(current, candidate);
  const empty = diff.protocol === null && diff.stateSchema === null && diff.datasetsAdded.length === 0 && diff.datasetsRemoved.length === 0 && diff.datasetsChanged.length === 0;
  if (empty) return <p className="break-words">{t("artifacts.contractCompatible")}</p>;
  return <ul className="space-y-1">
    {diff.protocol !== null && <li className="break-words">{t("artifacts.diffProtocol", { current: String(diff.protocol.current ?? "—"), candidate: String(diff.protocol.candidate ?? "—") })}</li>}
    {diff.stateSchema !== null && <li className="break-words">{t("artifacts.diffStateSchema", { current: diff.stateSchema.current ?? "—", candidate: diff.stateSchema.candidate ?? "—" })}</li>}
    {diff.datasetsAdded.map((dataset) => <li key={`add-${dataset.id}`} className="break-words">{t("artifacts.diffDatasetAdded", { id: dataset.id, schema: dataset.schema })}</li>)}
    {diff.datasetsRemoved.map((dataset) => <li key={`remove-${dataset.id}`} className="break-words">{t("artifacts.diffDatasetRemoved", { id: dataset.id, schema: dataset.schema })}</li>)}
    {diff.datasetsChanged.map((dataset) => <li key={`change-${dataset.id}`} className="break-words">{t("artifacts.diffDatasetChanged", { id: dataset.id, currentSchema: dataset.currentSchema, candidateSchema: dataset.candidateSchema })}</li>)}
  </ul>;
}
