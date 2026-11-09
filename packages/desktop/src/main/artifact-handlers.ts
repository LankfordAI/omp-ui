import { CH, type RequestHandlers } from "@omp-ui/core";
import type { ArtifactService } from "./artifact-service";

type ArtifactHandlerChannels = typeof CH.artifactList | typeof CH.artifactDescribe | typeof CH.artifactReadPart
  | typeof CH.artifactResolveSource | typeof CH.artifactKeep | typeof CH.artifactAcceptRevision
  | typeof CH.artifactReference | typeof CH.artifactPrepareRefresh | typeof CH.artifactApplyCapture
  | typeof CH.artifactDiscardDraft | typeof CH.artifactDelete;

/** Human backend only. Host tools deliberately receive neither these handlers nor publication authority. */
export function registerArtifactHandlers(service: ArtifactService): Pick<RequestHandlers, ArtifactHandlerChannels> {
  return {
    [CH.artifactList]: async request => service.list(request),
    [CH.artifactDescribe]: async request => service.describe(request),
    [CH.artifactReadPart]: async request => service.readPart(request),
    [CH.artifactResolveSource]: request => service.resolveSource(request),
    [CH.artifactKeep]: async request => service.keep(request),
    [CH.artifactAcceptRevision]: async request => service.acceptRevision(request),
    [CH.artifactReference]: async request => service.reference(request),
    [CH.artifactPrepareRefresh]: async request => service.prepareRefresh(request),
    [CH.artifactApplyCapture]: async request => service.applyCapture(request),
    [CH.artifactDiscardDraft]: async request => service.discardDraft(request),
    [CH.artifactDelete]: async request => service.delete(request),
  };
}
