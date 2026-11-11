import { ARTIFACT_LIMITS, type ArtifactPartResult, type ArtifactReadRequest } from "@omp-ui/core/artifacts";
import { backend } from "../backend";

/** Assemble a complete stored part by paging reads to `nextOffset === null`, bounded by the dataset cap. */
export async function readAllPart(request: Omit<ArtifactReadRequest, "offset" | "limit">): Promise<string> {
  let text = "";
  let offset = 0;
  for (;;) {
    const page: ArtifactPartResult = await backend.artifactReadPart({ ...request, offset, limit: 65536 });
    if (page.totalBytes > ARTIFACT_LIMITS.datasetBytes) throw new Error("Dataset exceeds the export bound");
    text += page.text;
    if (page.nextOffset === null) return text;
    if (page.nextOffset <= offset) throw new Error("Invalid artifact page");
    offset = page.nextOffset;
  }
}

/** Trusted blob: download for browser clients and Android; never a save dialog there. */
export function downloadBlob(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Suggested export filename from human/agent text; the browser has no path authority, so strip separators outright. */
export function safeDownloadName(value: string, extension: string): string {
  const stripped = value
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${(stripped || "artifact").slice(0, 120)}.${extension}`;
}
