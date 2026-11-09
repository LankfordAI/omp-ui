// Type-only contract: sandbox preloads deliberately inline their literal IPC names.
import type { ArtifactProvenance } from "@omp-ui/core";
export type ArtifactRuntimeJson = null | boolean | number | string | ArtifactRuntimeJson[] | { [key: string]: ArtifactRuntimeJson };
export type ArtifactSurfaceSource =
  | { draftId: string }
  | { artifactId: string; codeRevisionId: string; dataSnapshotId: string };
export interface ArtifactSurfaceTheme {
  tokens: Record<string, string>;
  dark: boolean;
}
export interface ArtifactPreparedSurface {
  surfaceId: string;
  url: string;
  partition: string;
  managed: boolean;
  readOnly: boolean;
}
export type ArtifactSurfaceNotice =
  | { surfaceId: string; reason: "changed" | "disabled" | "released" | "crashed"; reloadRequired: true }
  | { surfaceId: string; reason: "saving" | "saved" | "not-saved"; reloadRequired: false; stateRevision?: number; dataSnapshotId?: string }
  | { surfaceId: string; reason: "escape"; reloadRequired: false };
export interface ArtifactHostBridge {
  prepareSurface(source: ArtifactSurfaceSource, theme: ArtifactSurfaceTheme): Promise<ArtifactPreparedSurface>;
  updateTheme(surfaceId: string, theme: ArtifactSurfaceTheme): Promise<void>;
  releaseSurface(surfaceId: string): Promise<void>;
  onSurfaceNotice(listener: (notice: ArtifactSurfaceNotice) => void): () => void;
}
export interface ArtifactRuntimeDataset {
  value: ArtifactRuntimeJson;
  provenance: ArtifactProvenance;
}
export interface ArtifactRuntimeSnapshot {
  codeRevisionId: string | null;
  dataSnapshotId: string | null;
  stateRevision: number;
  readOnly: boolean;
  state: Record<string, ArtifactRuntimeJson>;
  datasets: Record<string, ArtifactRuntimeDataset>;
}
export interface ArtifactStatePatch {
  expectedStateRevision: number;
  set: Record<string, ArtifactRuntimeJson>;
  remove?: string[];
}
export interface ArtifactStateReceipt {
  stateRevision: number;
  dataSnapshotId: string;
}
export interface ArtifactGuestBridge {
  load(): Promise<ArtifactRuntimeSnapshot>;
  saveState(patch: ArtifactStatePatch): Promise<ArtifactStateReceipt>;
}
