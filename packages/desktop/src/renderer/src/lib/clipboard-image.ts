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

/** The one document mime handled today; the picker's accept attribute mirrors it. */
export const DOCUMENT_MIME = "application/pdf";

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

/**
 * Reads picker/paste PDF files, preserving input order. An empty MIME type
 * is accepted when the name ends in .pdf — some Chromium paths report none
 * for file-manager items. Non-PDF files are skipped silently: the dialog's
 * accept attribute already filters, and the images' silent-skip precedent
 * applies (readImageFiles:55).
 */
export async function readDocumentFiles(files: Iterable<File>): Promise<ClipboardDocuments> {
  const out: ClipboardDocuments = { documents: [], rejected: [] };
  for (const file of files) {
    if (file.type !== DOCUMENT_MIME && !(file.type === "" && /\.pdf$/i.test(file.name))) continue;
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
        name: sanitizeDocumentName(file.name || "document.pdf"),
        data: bytesToBase64(new Uint8Array(buffer)),
        mimeType: DOCUMENT_MIME,
      });
    } catch {
      out.rejected.push(`could not read ${file.name || "the pasted document"}`);
    }
  }
  return out;
}

/** Whether a paste/drop carries at least one PDF, without reading the bytes. */
export function hasClipboardDocument(data: DataTransfer | null): boolean {
  if (data === null) return false;
  for (const item of data.items) {
    if (item.kind === "file" && documentFile(item.type, item.getAsFile()?.name ?? "")) return true;
  }
  for (const file of data.files) {
    if (documentFile(file.type, file.name)) return true;
  }
  return false;
}

function documentFile(type: string, name: string): boolean {
  return type === DOCUMENT_MIME || (type === "" && /\.pdf$/i.test(name));
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
    if (item.kind !== "file" || !documentFile(item.type, item.getAsFile()?.name ?? "")) continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  if (files.length === 0) {
    for (const file of data.files) {
      if (documentFile(file.type, file.name)) files.push(file);
    }
  }
  return readDocumentFiles(files);
}
