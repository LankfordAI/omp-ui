import type { ArtifactDescribeRequest, ArtifactLibraryChanged } from "@omp-ui/core/artifacts";
import { backend } from "../../backend";
import type { GetState, SetState } from "./shared";
import { bumpNavigationGeneration, findOwner, getNavigationGeneration } from "./view";

export interface ArtifactsSlice {
  artifacts: ({ artifactId: string | null; codeRevisionId?: string; dataSnapshotId?: string; captureId?: string; panel?: "preview" | "data" | "history" }) | null;
  artifactLibraryRevision: number;
  artifactLastChange: ArtifactLibraryChanged | null;
  artifactPendingReviewCount: number;
  artifactSourceFocus: { tabId: string; sessionId: string | null; toolCallId: string | null; nonce: number } | null;
  openArtifactSource(target: { tabId: string; sessionId: string | null; toolCallId: string | null }): Promise<void>;
  openArtifacts(selection?: ArtifactDescribeRequest & { captureId?: string; panel?: "preview" | "data" | "history" }): void;
  closeArtifacts(): void;
  invalidateArtifactLibrary(event?: ArtifactLibraryChanged): void;
  refreshArtifactSummary(): Promise<void>;
}

export function createArtifactsSlice(set: SetState, get: GetState): ArtifactsSlice {
  let summaryGeneration = 0;
  return {
    artifacts: null,
    artifactLibraryRevision: 0,
    artifactLastChange: null,
    artifactPendingReviewCount: 0,
    artifactSourceFocus: null,
    async openArtifactSource(target) {
      const owner = findOwner(get().state, target.tabId);
      if (owner === undefined || owner.instanceId !== null || target.sessionId === null || owner.record.sessionId !== target.sessionId) { get().reportError(new Error("The exact source session is unavailable. Kept code and data remain available.")); return; }
      const navigation = bumpNavigationGeneration();
      try { await get().openSession(target.tabId, { activate: false, forkCheck: false }); }
      catch (reason) { get().reportError(reason); return; }
      if (getNavigationGeneration() !== navigation) return;
      if (!get().tabs.some((tab) => tab.tabId === target.tabId) || findOwner(get().state, target.tabId)?.record.sessionId !== target.sessionId) { get().reportError(new Error("The exact source session is unavailable. Kept code and data remain available.")); return; }
      set((s) => ({ artifactSourceFocus: { ...target, nonce: (s.artifactSourceFocus?.nonce ?? 0) + 1 } }));
      get().focusTab(target.tabId);
    },
    openArtifacts(selection) {
      if (get().state?.artifactLibraryEnabled !== true) return;
      bumpNavigationGeneration();
      if (get().lab !== null) get().closeLab();
      set({ artifacts: selection ?? { artifactId: null }, stats: null, fleet: null, fleetTerminal: null, compactSurface: null, routinesOpen: false });
    },
    closeArtifacts() {
      bumpNavigationGeneration();
      set({ artifacts: null });
    },
    invalidateArtifactLibrary(event) {
      set((s) => ({
        artifactLibraryRevision: s.artifactLibraryRevision + 1,
        artifactLastChange: event ?? null,
      }));
    },
    async refreshArtifactSummary() {
      const generation = ++summaryGeneration;
      if (get().state?.artifactLibraryEnabled !== true) {
        set({ artifactPendingReviewCount: 0 });
        return;
      }
      try {
        const page = await backend.artifactList({ limit: 1 });
        if (generation !== summaryGeneration || get().state?.artifactLibraryEnabled !== true) return;
        set({ artifactPendingReviewCount: page.pendingReviewCount });
      } catch {
        // Best-effort badge refresh: never surface background summary noise as an alert.
      }
    },
  };
}
