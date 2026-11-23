import type { DocumentAttachment, ImageAttachment } from "@omp-ui/core/types";
import { sanitizeDocumentName } from "./document-context";

/**
 * Reads image files from paste, drop, or picker input.
 *
 * omp accepts four input mime types and silently re-encodes anything else. We
 * forward image MIME types (and files with no reported type) while enforcing
 * omp's own 20 MB input ceiling, which omp does *not* apply to the rpc `images`
 * field: without it a 200 MB image becomes a 270 MB JSON line on omp's stdin.
 */

/** omp's `MAX_IMAGE_INPUT_BYTES`, mirrored here so the renderer can pre-check. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ClipboardImages {
  images: ImageAttachment[];
  /** Human-readable reasons items were dropped, for the composer to surface. */
  rejected: string[];
}

function tooLarge(name: string, bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `${name} is ${mb} MB — over omp's 20 MB image limit`;
}

/** Bytes → bare base64, chunked so a large image cannot blow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  // String.fromCharCode is variadic; 32k arguments is comfortably under every
  // engine's spread limit while keeping the loop short.
  const CHUNK = 32768;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Bare base64 → bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Reads picker-selected image files, preserving their input order.
 *
 * An empty MIME type is accepted because some browser-provided image files do
 * not report one; omp converts unknown image formats to PNG on ingest.
 */
export async function readImageFiles(files: Iterable<File>): Promise<ClipboardImages> {
  const out: ClipboardImages = { images: [], rejected: [] };
  for (const file of files) {
    if (file.type !== "" && !file.type.startsWith("image/")) continue;
    if (file.size > MAX_IMAGE_BYTES) {
      out.rejected.push(tooLarge(file.name || "pasted image", file.size));
      continue;
    }
    try {
      const buffer = await file.arrayBuffer();
      // Re-check post-read: `size` is advisory for some virtual clipboard files.
      if (buffer.byteLength > MAX_IMAGE_BYTES) {
        out.rejected.push(tooLarge(file.name || "pasted image", buffer.byteLength));
        continue;
      }
      out.images.push({
        type: "image",
        data: bytesToBase64(new Uint8Array(buffer)),
        // A browser-provided image can arrive with an empty type; omp converts
        // unknown formats to PNG anyway, so claiming PNG is the useful guess.
        mimeType: file.type || "image/png",
      });
    } catch {
      out.rejected.push(`could not read ${file.name || "the pasted image"}`);
    }
  }
  return out;
}

/** The default document mime; video rides the same route (issue #1310). */
export const DOCUMENT_MIME = "application/pdf";

/**
 * Video mimes accepted as Document Attachments (issue #1310): omp's `read`
 * tool decodes these through ffmpeg from a scratch path, so they materialize
 * exactly like PDFs — no base64 on the rpc frame, same ceilings.
 */
export const VIDEO_MIMES = ["video/mp4", "video/webm", "video/quicktime"] as const;

/** Extension fallback for empty-type files, keyed without a leading dot. */
const EXTENSION_MIMES: Readonly<Record<string, string>> = {
  pdf: DOCUMENT_MIME,
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/** The document mime a materialized path's extension implies. */
export function mimeForDocumentPath(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return EXTENSION_MIMES[ext] ?? DOCUMENT_MIME;
}

/** Per-document ceiling; main re-checks it at materialization. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

function tooLargeDocument(name: string, bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `${name} is ${mb} MB — over the 20 MB document limit`;
}

export interface ClipboardDocuments {
  documents: DocumentAttachment[];
  /** Human-readable reasons items were dropped, for the composer to surface. */
  rejected: string[];
}

/** Scratch extension for an accepted document mime (mirrors core's mapping). */
export function fileExtension(mimeType: string): string {
  if (mimeType === "video/mp4") return "mp4";
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "video/quicktime") return "mov";
  return "pdf";
}

/**
 * The accepted document mime for a file, or null: an exact mime match, or —
 * for the empty type some Chromium paths report on file-manager items — the
 * extension. Unknown types stay null so they fall through to other handlers.
 */
export function documentMime(type: string, name: string): string | null {
  if (type === DOCUMENT_MIME || (VIDEO_MIMES as readonly string[]).includes(type)) return type;
  if (type !== "") return null;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return EXTENSION_MIMES[ext] ?? null;
}

/**
 * Reads picker/paste document files — PDFs and accepted videos (issue #1310)
 * — preserving input order. An empty MIME type is accepted when the name ends
 * in an accepted extension — some Chromium paths report none for file-manager
 * items. Other files are skipped silently: the dialog's accept attribute
 * already filters, and the images' silent-skip precedent applies
 * (readImageFiles:55).
 */
export async function readDocumentFiles(files: Iterable<File>): Promise<ClipboardDocuments> {
  const out: ClipboardDocuments = { documents: [], rejected: [] };
  for (const file of files) {
    const mimeType = documentMime(file.type, file.name);
    if (mimeType === null) continue;
    if (file.size > MAX_DOCUMENT_BYTES) {
      out.rejected.push(tooLargeDocument(file.name || "pasted document", file.size));
      continue;
    }
    try {
      const buffer = await file.arrayBuffer();
      // Re-check post-read: `size` is advisory for some virtual clipboard files.
      if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
        out.rejected.push(tooLargeDocument(file.name || "pasted document", buffer.byteLength));
        continue;
      }
      out.documents.push({
        type: "document",
        name: sanitizeDocumentName(file.name, `document.${fileExtension(mimeType)}`),
        data: bytesToBase64(new Uint8Array(buffer)),
        mimeType,
      });
    } catch {
      out.rejected.push(`could not read ${file.name || "the pasted document"}`);
    }
  }
  return out;
}

/** Whether a paste/drop carries at least one accepted document (PDF or video), without reading the bytes. */
export function hasClipboardDocument(data: DataTransfer | null): boolean {
  if (data === null) return false;
  for (const item of data.items) {
    if (item.kind === "file" && documentMime(item.type, item.getAsFile()?.name ?? "") !== null) return true;
  }
  for (const file of data.files) {
    if (documentMime(file.type, file.name) !== null) return true;
  }
  return false;
}

/**
 * Every image file on a DataTransfer, in clipboard order.
 *
 * Reads `items` rather than `files`: a screenshot pasted from the system
 * clipboard arrives as an item with an empty `files` list in some Chromium
 * paths, and `getAsFile()` is the only accessor that sees it.
 */
export async function readClipboardImages(data: DataTransfer | null): Promise<ClipboardImages> {
  if (data === null) return { images: [], rejected: [] };

  const files: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  // Fall back to `files` when `items` yielded nothing — drag-and-drop from a
  // file manager populates one or the other depending on the source.
  if (files.length === 0) {
    for (const file of data.files) {
      if (file.type.startsWith("image/")) files.push(file);
    }
  }

  return readImageFiles(files);
}

/** Whether a paste/drop carries at least one image, without reading the bytes. */
export function hasClipboardImage(data: DataTransfer | null): boolean {
  if (data === null) return false;
  for (const item of data.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) return true;
  }
  for (const file of data.files) {
    if (file.type.startsWith("image/")) return true;
  }
  return false;
}

/**
 * Every PDF file on a DataTransfer, in clipboard order — the document twin
 * of readClipboardImages, with the same items-before-files fallback.
 */
export async function readClipboardDocuments(
  data: DataTransfer | null,
): Promise<ClipboardDocuments> {
  if (data === null) return { documents: [], rejected: [] };
  const files: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file" || documentMime(item.type, item.getAsFile()?.name ?? "") === null) continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  if (files.length === 0) {
    for (const file of data.files) {
      if (documentMime(file.type, file.name) !== null) files.push(file);
    }
  }
  return readDocumentFiles(files);
}
