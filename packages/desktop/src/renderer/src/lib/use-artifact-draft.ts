import { useCallback, useEffect } from "react";
import type { ArtifactReference, DraftArtifactReference } from "@omp-ui/core/artifacts";
import { useStore } from "../store";

const EMPTY: DraftArtifactReference[] = [];
/** Artifact grants live outside rpc state and survive composer remounts and dormant boot. */
export function useArtifactDraft(tabId: string, appendText: (text: string) => void) {
  const references = useStore(state => state.artifactDrafts[tabId] ?? EMPTY);
  const pendingText = useStore(state => state.artifactDraftText[tabId]);
  const attach = useStore(state => state.attachArtifactReference);
  const remove = useStore(state => state.removeArtifactReference);
  const clear = useStore(state => state.clearArtifactReferences);
  const drain = useStore(state => state.drainArtifactDraftText);
  useEffect(() => {
    if (!pendingText?.length) return;
    const text = drain(tabId).join("\n\n");
    if (text !== "") appendText(text);
  }, [tabId, pendingText, drain, appendText]);
  const addReferences = useCallback((incoming: readonly DraftArtifactReference[]) => {
    for (const reference of incoming) attach(tabId, reference);
  }, [tabId, attach]);
  const dropReference = useCallback((referenceId: string) => remove(tabId, referenceId), [tabId, remove]);
  const clearReferences = useCallback((submitted?: readonly ArtifactReference[]) => clear(tabId, submitted), [tabId, clear]);
  return { references, addReferences, dropReference, clearReferences };
}
