import { useCallback } from "react";
import type { ArtifactRefreshEntry, ArtifactReference, DraftArtifactReference } from "@omp-ui/core/artifacts";
import { useStore } from "../store";

const EMPTY: DraftArtifactReference[] = [];
const EMPTY_REFRESHES: ArtifactRefreshEntry[] = [];
/** Artifact grants live outside rpc state and survive composer remounts and dormant boot. */
export function useArtifactDraft(tabId: string) {
  const references = useStore(state => state.artifactDrafts[tabId] ?? EMPTY);
  const refreshes = useStore(state => state.artifactRefreshDrafts[tabId] ?? EMPTY_REFRESHES);
  const attach = useStore(state => state.attachArtifactReference);
  const remove = useStore(state => state.removeArtifactReference);
  const clear = useStore(state => state.clearArtifactReferences);
  const removeRefresh = useStore(state => state.removeArtifactRefresh);
  const clearRefresh = useStore(state => state.clearArtifactRefreshes);
  const addReferences = useCallback((incoming: readonly DraftArtifactReference[]) => {
    for (const reference of incoming) attach(tabId, reference);
  }, [tabId, attach]);
  const dropReference = useCallback((referenceId: string) => remove(tabId, referenceId), [tabId, remove]);
  const clearReferences = useCallback((submitted?: readonly ArtifactReference[]) => clear(tabId, submitted), [tabId, clear]);
  const dropRefresh = useCallback((refreshRequestId: string) => removeRefresh(tabId, refreshRequestId), [tabId, removeRefresh]);
  const clearRefreshes = useCallback(() => clearRefresh(tabId), [tabId, clearRefresh]);
  return { references, addReferences, dropReference, clearReferences, refreshes, dropRefresh, clearRefreshes };
}
