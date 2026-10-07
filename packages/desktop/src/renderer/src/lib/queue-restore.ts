// Pure helpers behind Esc-restores-the-queue (issue #776): split one queued
// wire message back into draft parts, and validate omp's
// `abort_and_restore_queue` / `remove_queued_message` payloads. No React, no
// store — the slice composes them.
import type { ImageAttachment } from "@omp-ui/core/types";
import { stripTrailingAttachmentRoutingContext } from "./attachment-routing";
import { splitDocumentContext, type DocumentRef } from "./document-context";
import { boolField, field, isObj, strField } from "./fields";
import { splitResolvedMentionContext } from "./mentions";

/**
 * Splits one queued wire message back into draft prose plus the documents its
 * block names. Mirror image of `queueEntryDisplayText`'s order (queue-chip.ts):
 * routing suffix, document block, resolved mention blocks. The prose keeps its
 * raw `@` tokens — `splitResolvedMentionContext` only removes the terminal
 * blocks — and images come from the response, never the text. The routing
 * suffix is stripped by construction: the restored draft gets one fresh,
 * correctly numbered suffix at send time, so per-entry handle offsets never
 * need renumbering.
 */
export function splitQueuedWireText(raw: string): {
  text: string;
  documents: DocumentRef[];
} {
  const { text: docless, documents } = splitDocumentContext(
    stripTrailingAttachmentRoutingContext(raw),
  );
  return { text: splitResolvedMentionContext(docless).text, documents };
}

/** Projects a bare `ImageContent[]` — what `remove_queued_message` returns —
 *  to draft attachments. A block counts only as an image carrying string
 *  `data`/`mimeType`; omp's extra fields (`detail`, `url`, `providerFile`)
 *  are projected away so they never leak into the draft wire frame. */
export function projectImages(value: unknown): ImageAttachment[] {
  const images: ImageAttachment[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const data = strField(entry, "data");
    const mimeType = strField(entry, "mimeType");
    if (field(entry, "type") !== "image" || data === undefined || mimeType === undefined)
      continue;
    images.push({ type: "image", data, mimeType });
  }
  return images;
}

/** One `RestoredQueuedMessage`, validated. `null` for anything that is not an
 *  object with a string `text`; entries whose `images` list is
 *  present-but-malformed keep their text and lose the images — never the
 *  message. */
export function parseRestoredMessage(value: unknown): {
  text: string;
  images: ImageAttachment[];
} | null {
  const text = strField(value, "text");
  if (text === undefined) return null;
  return { text, images: projectImages(field(value, "images")) };
}

/** An `AbortAndRestoreQueueResult`: the two entry lists plus the two
 *  "only ever true" flags. `null` when the envelope is malformed — a
 *  malformed result must restore nothing, not half a queue. */
export function parseRestoreResult(value: unknown): {
  steering: Array<{ text: string; images: ImageAttachment[] }>;
  followUp: Array<{ text: string; images: ImageAttachment[] }>;
  imagesDropped: boolean;
  truncated: boolean;
} | null {
  if (!isObj(value)) return null;
  const steering = parseEntries(field(value, "steering"));
  const followUp = parseEntries(field(value, "followUp"));
  if (steering === null || followUp === null) return null;
  return {
    steering,
    followUp,
    imagesDropped: boolField(value, "imagesDropped") === true,
    truncated: boolField(value, "truncated") === true,
  };
}

function parseEntries(value: unknown): Array<{ text: string; images: ImageAttachment[] }> | null {
  if (!Array.isArray(value)) return null;
  const entries: Array<{ text: string; images: ImageAttachment[] }> = [];
  for (const entry of value) {
    const parsed = parseRestoredMessage(entry);
    if (parsed === null) return null;
    entries.push(parsed);
  }
  return entries;
}
