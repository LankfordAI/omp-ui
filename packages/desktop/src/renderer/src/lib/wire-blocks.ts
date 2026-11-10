/**
 * The one canonical order the renderer peels omp-ui's leading wire blocks off
 * a prompt (ADR-0092): artifact refresh, then session references (ADR-0085),
 * then artifact references (ADR-0090), then annotations (ADR-0077). Assembly
 * (`promptWireText`, store/slices/session-params.ts) wraps in exactly this
 * order, outermost first; before this helper the same order was hand-duplicated
 * across three strip chains and core's admission peel, and that drift is how
 * the refresh block fell out of the transcript. Every surface — transcript
 * rows, queue restores, queue-chip display — calls this instead of re-listing
 * the order. Document-terminal blocks, resolved mentions, and the image
 * routing suffix stay per-surface: they strip for different reasons and at
 * different positions, so callers run those peels themselves (routing suffix
 * and documents before the stack, exactly as before).
 *
 * After the reference peels comes the end-anchored legacy refresh peel
 * (`splitLegacyArtifactRefreshRequest`): the pre-ADR-0092 wire wrapped the
 * instruction paragraph and its terminal `<artifact refresh>` block INSIDE the
 * references blocks, so it is recognized here, after references come off and
 * before annotations. A lookalike missing either half stays prose, and
 * admission never binds either form of a lookalike.
 */
import { splitArtifactRefreshContext, splitArtifactReferenceContext, splitLegacyArtifactRefreshRequest } from "@omp-ui/core/artifact-references";
import type { ArtifactReference, ArtifactRefreshEntry } from "@omp-ui/core/artifacts";
import type { SessionReference } from "@omp-ui/core/types";
import { splitAnnotationContext, type Annotation } from "./annotations";
import { splitSessionReferenceContext } from "./session-references";

export interface WireBlocks {
  /** The text with every recognized block peeled off. */
  text: string;
  refreshes: ArtifactRefreshEntry[];
  references: SessionReference[];
  artifactReferences: ArtifactReference[];
  annotations: Annotation[];
  /** Request id of a pre-ADR-0092 refresh prompt, or null for any other text. */
  legacyRefreshRequestId: string | null;
}

export function splitWireBlockStack(text: string): WireBlocks {
  const refreshes = splitArtifactRefreshContext(text);
  const sessions = splitSessionReferenceContext(refreshes.text);
  const artifactRefs = splitArtifactReferenceContext(sessions.text);
  const legacy = splitLegacyArtifactRefreshRequest(artifactRefs.text);
  const annotations = splitAnnotationContext(legacy.text);
  return {
    text: annotations.text,
    refreshes: refreshes.refreshes,
    references: sessions.references,
    artifactReferences: artifactRefs.references,
    annotations: annotations.annotations,
    legacyRefreshRequestId: legacy.refreshRequestId,
  };
}
