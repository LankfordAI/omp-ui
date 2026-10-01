import { useCallback, useState, type ChangeEvent, type ClipboardEvent } from "react";
import type { DocumentAttachment, ImageAttachment } from "@omp-ui/core/types";
import {
  hasClipboardDocument,
  hasClipboardImage,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  readClipboardDocuments,
  readClipboardImages,
  readDocumentFiles,
  readImageFiles,
} from "./clipboard-image";
import { sanitizeDocumentName } from "./document-context";

/**
 * The Attachment draft shared by the composer and the plan review's refine
 * notes (issue #299, PDFs per ADR-0044): paste and picker both append to the
 * same lists — images and PDF Document Attachments — and refusals surface as
 * one dismissible message.
 */
export interface ImageDraft {
  images: ImageAttachment[];
  /** PDF Document Attachments, materialized to paths at send (ADR-0044). */
  documents: DocumentAttachment[];
  /** Why an Attachment was refused (over a size ceiling, unreadable). */
  pasteError: string | null;
  /** Intercepts an image or PDF paste; text pastes pass through untouched. */
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Adds picker-selected Attachments through the same draft path as paste. */
  pickFiles: (e: ChangeEvent<HTMLInputElement>) => void;
  /** Appends ready-made image Attachments (the browser pane's hand-back) under the same size guard. */
  addImages: (images: ImageAttachment[]) => void;
  /** Appends ready-made Documents (rewind prefill re-sends by path) under the same size guard. */
  addDocuments: (documents: DocumentAttachment[]) => void;
  dropImage: (index: number) => void;
  dropDocument: (index: number) => void;
  /** Clears both Attachment lists and any refusal message together (send / refine). */
  clearDraft: () => void;
  /** Surfaces a send-time refusal (materialization failed) beside the draft. */
  setPasteError: (message: string) => void;
  /** Clears the refusal only — accepted Attachments survive a dismissed warning. */
  dismissError: () => void;
}

export function useImageDraft(): ImageDraft {
  /**
   * Image Attachments in the draft, in the order they were pasted or picked.
   * They ride the same frame as the text and are cleared with it.
   */
  const [images, setImages] = useState<ImageAttachment[]>([]);
  /** PDF Documents in the draft; they ride the message text, not the frame. */
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  /** Why an Attachment was refused (over a size ceiling, unreadable). */
  const [pasteError, setPasteError] = useState<string | null>(null);

  /**
   * Intercepts an image or PDF paste. Text pastes are left entirely alone —
   * the textarea's own handling is what the user expects, and a clipboard
   * carrying both (copying an image out of a rich editor) should still paste
   * its text.
   */
  const onPaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const hasImage = hasClipboardImage(e.clipboardData);
    const hasDocument = hasClipboardDocument(e.clipboardData);
    if (!hasImage && !hasDocument) return;
    // Chromium would otherwise insert the file's *name* as text.
    e.preventDefault();
    const rejected: string[] = [];
    if (hasImage) {
      const { images: pasted, rejected: imageRejected } = await readClipboardImages(e.clipboardData);
      if (pasted.length > 0) setImages((prev) => [...prev, ...pasted]);
      rejected.push(...imageRejected);
    }
    if (hasDocument) {
      const { documents: pasted, rejected: docRejected } = await readClipboardDocuments(e.clipboardData);
      if (pasted.length > 0) setDocuments((prev) => [...prev, ...pasted]);
      rejected.push(...docRejected);
    }
    setPasteError(rejected.length > 0 ? rejected.join("; ") : null);
  }, []);

  /** Adds picker-selected Attachments through the same draft path as paste. */
  const pickFiles = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    // Clear before reading, including rejected selections, so selecting the
    // same file again always produces another change event.
    input.value = "";
    const [pickedImages, pickedDocuments] = await Promise.all([
      readImageFiles(files),
      readDocumentFiles(files),
    ]);
    if (pickedImages.images.length > 0) setImages((prev) => [...prev, ...pickedImages.images]);
    if (pickedDocuments.documents.length > 0)
      setDocuments((prev) => [...prev, ...pickedDocuments.documents]);
    const rejected = [...pickedImages.rejected, ...pickedDocuments.rejected];
    setPasteError(rejected.length > 0 ? rejected.join("; ") : null);
  }, []);

  const addImages = useCallback((incoming: ImageAttachment[]) => {
    const accepted: ImageAttachment[] = [];
    const rejected: string[] = [];
    for (const image of incoming) {
      // Base64 carries 3 bytes per 4 characters; the ceiling is omp's, not ours.
      const bytes = Math.floor((image.data.length * 3) / 4);
      if (bytes > MAX_IMAGE_BYTES) {
        rejected.push(`${image.mimeType} attachment is ${(bytes / (1024 * 1024)).toFixed(1)} MB — over omp's 20 MB image limit`);
        continue;
      }
      accepted.push(image);
    }
    if (accepted.length > 0) setImages((prev) => [...prev, ...accepted]);
    setPasteError(rejected.length > 0 ? rejected.join("; ") : null);
  }, []);

  const addDocuments = useCallback((incoming: DocumentAttachment[]) => {
    const accepted: DocumentAttachment[] = [];
    const rejected: string[] = [];
    for (const document of incoming) {
      const name = sanitizeDocumentName(document.name);
      if (document.data !== undefined) {
        // Base64 carries 3 bytes per 4 characters; the ceiling mirrors images.
        const bytes = Math.floor((document.data.length * 3) / 4);
        if (bytes > MAX_DOCUMENT_BYTES) {
          rejected.push(`${name} is ${(bytes / (1024 * 1024)).toFixed(1)} MB — over the 20 MB document limit`);
          continue;
        }
      }
      accepted.push({ ...document, name });
    }
    if (accepted.length > 0) setDocuments((prev) => [...prev, ...accepted]);
    setPasteError(rejected.length > 0 ? rejected.join("; ") : null);
  }, []);

  const dropImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const dropDocument = useCallback((index: number) => {
    setDocuments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearDraft = useCallback(() => {
    setImages([]);
    setDocuments([]);
    setPasteError(null);
  }, []);

  const dismissError = useCallback(() => setPasteError(null), []);

  return {
    images,
    documents,
    pasteError,
    setPasteError,
    onPaste,
    pickFiles,
    addImages,
    addDocuments,
    dropImage,
    dropDocument,
    clearDraft,
    dismissError,
  };
}
