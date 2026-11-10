// Pure helpers behind Esc-restores-the-queue (issue #776): split one queued
// wire message back into draft parts, and validate omp's
// `abort_and_restore_queue` / `remove_queued_message` payloads. No React, no
// store — the slice composes them.
import type { ImageAttachment, SessionReference } from "@omp-ui/core/types";
import type { ArtifactReference, ArtifactRefreshEntry } from "@omp-ui/core/artifacts";
import { type Annotation } from "./annotations";
import { splitWireBlockStack } from "./wire-blocks";
import { stripTrailingAttachmentRoutingContext } from "./attachment-routing";
import { splitDocumentContext, type DocumentRef } from "./document-context";
import { boolField, field, isObj, strField } from "./fields";
import { splitResolvedMentionContext } from "./mentions";

/**
 * Splits one queued wire message back into draft prose plus the documents its
 * block names, everything else off `splitWireBlockStack`'s canonical order
 * (ADR-0092): the leading artifact refresh block (ADR-0092) leads, then the
 * session references block (ADR-0085), then artifact references (ADR-0090);
 * after the reference peels the stack recognizes the pre-ADR-0092 legacy
 * refresh form — its paragraph and terminal block sat INSIDE the references
 * blocks, so it can only be matched once those come off — and annotations
 * (ADR-0077) close the stack. Mirror image of `queueEntryDisplayText`'s order
 * (queue-chip.ts): routing suffix, document block, the stack, resolved
 * mention blocks. The prose keeps its
 * raw `@` tokens — `splitResolvedMentionContext` only removes the terminal
 * blocks — and images come from the response, never the text. The routing
 * suffix is stripped by construction: the restored draft gets one fresh,
 * correctly numbered suffix at send time, so per-entry handle offsets never
 * need renumbering. `refreshes` and `legacyRefreshRequestId` are returned raw
 * — no legacy synthesis here; the caller restores exactly what was queued.
 */
export function splitQueuedWireText(raw: string): {
  text: string;
  documents: DocumentRef[];
  annotations: Annotation[];
  references: SessionReference[];
  artifactReferences: ArtifactReference[];
  refreshes: ArtifactRefreshEntry[];
  legacyRefreshRequestId: string | null;
} {
  const { text: docless, documents } = splitDocumentContext(
    stripTrailingAttachmentRoutingContext(raw),
  );
  const stack = splitWireBlockStack(docless);
  return {
    text: splitResolvedMentionContext(stack.text).text,
    documents,
    annotations: stack.annotations,
    references: stack.references,
    artifactReferences: stack.artifactReferences,
    refreshes: stack.refreshes,
    legacyRefreshRequestId: stack.legacyRefreshRequestId,
  };
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
