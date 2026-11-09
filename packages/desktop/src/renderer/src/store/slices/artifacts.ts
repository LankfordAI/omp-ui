import type { ArtifactDescribeRequest } from "@omp-ui/core/artifacts";
import type { GetState, SetState } from "./shared";
import { bumpNavigationGeneration, findOwner, getNavigationGeneration } from "./view";
import { t } from "../../lib/i18n";

export interface ArtifactsSlice {
  artifacts: ({ artifactId: string | null; codeRevisionId?: string; dataSnapshotId?: string; captureId?: string }) | null;
  artifactLibraryRevision: number;
  artifactSourceFocus: { tabId: string; sessionId: string | null; toolCallId: string | null; nonce: number } | null;
  openArtifactSource(target: { tabId: string; sessionId: string | null; toolCallId: string | null }): Promise<void>;
  openArtifacts(selection?: ArtifactDescribeRequest & { captureId?: string }): void;
  closeArtifacts(): void;
  invalidateArtifactLibrary(): void;
}

export function createArtifactsSlice(set: SetState, get: GetState): ArtifactsSlice {
  return {
    artifacts: null,
    artifactLibraryRevision: 0,
    artifactSourceFocus: null,
    async openArtifactSource(target) {
      const owner = findOwner(get().state, target.tabId);
      if (owner === undefined || owner.instanceId !== null || target.sessionId === null || owner.record.sessionId !== target.sessionId) { get().reportError(new Error(t("artifacts.sourceUnavailable"))); return; }
      const navigation = bumpNavigationGeneration();
      try { await get().openSession(target.tabId, { activate: false }); }
      catch (reason) { get().reportError(reason); return; }
      if (getNavigationGeneration() !== navigation) return;
      if (!get().tabs.some((tab) => tab.tabId === target.tabId) || findOwner(get().state, target.tabId)?.record.sessionId !== target.sessionId) { get().reportError(new Error(t("artifacts.sourceUnavailable"))); return; }
      set((s) => ({ artifactSourceFocus: { ...target, nonce: (s.artifactSourceFocus?.nonce ?? 0) + 1 } }));
      get().focusTab(target.tabId);
    },
    openArtifacts(selection) {
      if (get().state?.artifactLibraryEnabled !== true) return;
      bumpNavigationGeneration();
      if (get().lab !== null) get().closeLab();
      set({ artifacts: selection ?? { artifactId: null }, stats: null, fleet: null, fleetTerminal: null, compactSurface: null });
    },
    closeArtifacts() {
      bumpNavigationGeneration();
      set({ artifacts: null });
    },
    invalidateArtifactLibrary() {
      set((s) => ({ artifactLibraryRevision: s.artifactLibraryRevision + 1 }));
    },
  };
}
