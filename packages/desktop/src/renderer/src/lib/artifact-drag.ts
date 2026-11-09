import type { ArtifactCreateReferenceRequest } from "@omp-ui/core/artifacts";
import { assertArtifactUuid } from "@omp-ui/core/artifacts";

export const ARTIFACT_DRAG_MIME = "application/x-omp-ui-artifact";
export const ARTIFACT_DRAG_EFFECT = "copy";
export interface ArtifactDrag extends Omit<ArtifactCreateReferenceRequest, "includeData"> { instanceId: string | null }

/** Drag bytes identify a version only: a drop must ask main for a fresh definition-only grant. */
export function parseArtifactDrag(raw: string): ArtifactDrag | null {
  if (raw.length > 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(key => !["artifactId", "codeRevisionId", "dataSnapshotId", "instanceId"].includes(key))) return null;
    assertArtifactUuid(v.artifactId); assertArtifactUuid(v.codeRevisionId); assertArtifactUuid(v.dataSnapshotId);
    if (v.instanceId !== null) assertArtifactUuid(v.instanceId);
    return { artifactId: v.artifactId, codeRevisionId: v.codeRevisionId, dataSnapshotId: v.dataSnapshotId, instanceId: v.instanceId as string | null };
  } catch { return null; }
}
