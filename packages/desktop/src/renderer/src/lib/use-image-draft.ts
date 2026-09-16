import { useCallback, useState, type ChangeEvent, type ClipboardEvent } from "react";
import type { ImageAttachment } from "@omp-ui/core/types";
import { hasClipboardImage, MAX_IMAGE_BYTES, readClipboardImages, readImageFiles } from "./clipboard-image";

/**
 * The image Attachment draft shared by the composer and the plan review's
 * refine notes (issue #299): paste and picker both append to the same list,
 * and refusals surface as one dismissible message.
 */
export interface ImageDraft {
  images: ImageAttachment[];
  /** Why an Attachment was refused (over omp's 20 MB ceiling, unreadable). */
  pasteError: string | null;
  /** Intercepts an image paste; text pastes pass through untouched. */
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Adds picker-selected Attachments through the same draft path as paste. */
  pickImages: (e: ChangeEvent<HTMLInputElement>) => void;
  /** Appends ready-made Attachments (the browser pane's hand-back) under the same size guard. */
  addImages: (images: ImageAttachment[]) => void;
  dropImage: (index: number) => void;
  /** Clears the images and any refusal message together (send / refine). */
  clearImages: () => void;
  /** Clears the refusal only — accepted images survive a dismissed warning. */
  dismissError: () => void;
}

export function useImageDraft(): ImageDraft {
  /**
   * Image Attachments in the draft, in the order they were pasted or picked.
   * They ride the same frame as the text and are cleared with it.
   */
  const [images, setImages] = useState<ImageAttachment[]>([]);
  /** Why an Attachment was refused (over omp's 20 MB ceiling, unreadable). */
  const [pasteError, setPasteError] = useState<string | null>(null);

  /**
   * Intercepts an image paste. Text pastes are left entirely alone — the
   * textarea's own handling is what the user expects, and a clipboard carrying
   * both (copying an image out of a rich editor) should still paste its text.
   */
  const onPaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!hasClipboardImage(e.clipboardData)) return;
    // Chromium would otherwise insert the image's *filename* as text.
    e.preventDefault();
    const { images: pasted, rejected } = await readClipboardImages(e.clipboardData);
    if (pasted.length > 0) setImages((prev) => [...prev, ...pasted]);
    setPasteError(rejected.length > 0 ? rejected.join("; ") : null);
  }, []);

  /** Adds picker-selected Attachments through the same draft path as paste. */
  const pickImages = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    // Clear before reading, including rejected selections, so selecting the
    // same file again always produces another change event.
    input.value = "";
    const { images: picked, rejected } = await readImageFiles(files);
    if (picked.length > 0) setImages((prev) => [...prev, ...picked]);
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

  const dropImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearImages = useCallback(() => {
    setImages([]);
    setPasteError(null);
  }, []);

  const dismissError = useCallback(() => setPasteError(null), []);

  return { images, pasteError, onPaste, pickImages, addImages, dropImage, clearImages, dismissError };
}
