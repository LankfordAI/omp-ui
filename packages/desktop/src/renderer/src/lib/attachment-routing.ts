const ROUTING_PREFIX = "[omp-ui attachment routing: For tool calls, this prompt's attached ";
const ROUTING_RESTART = " Attachment handles restart at 1 for each prompt.";
const ROUTING_CLOSE = "]";

/** The handle sentence every routing context opens with, minus its close. */
function routingHead(imageCount: number): string | null {
  if (!Number.isSafeInteger(imageCount) || imageCount <= 0) return null;
  const handles = Array.from(
    { length: imageCount },
    (_, index) => `attachment://${index + 1}`,
  ).join(", ");
  const subject = imageCount === 1 ? "image is" : "images are";
  return `${ROUTING_PREFIX}${subject} available as ${handles}.${ROUTING_RESTART}`;
}

/**
 * The lead-in of the scratch-file list (issue #993). It names no
 * `attachment://` handle, so the head line stays the only place handles
 * appear and stripTrailingAttachmentRoutingContext can count them.
 */
function filesLead(imageCount: number): string {
  return imageCount === 1
    ? " The same image is saved as a file:"
    : " The same images are saved as files, in the same order:";
}

/**
 * The routing context for `imageCount` images. `files`, when given, are the
 * absolute scratch paths materialized on the session's host, one per image
 * in frame order — one per line, so a path needs no quoting.
 */
function routingContext(imageCount: number, files?: readonly string[]): string | null {
  const head = routingHead(imageCount);
  if (head === null) return null;
  if (files === undefined || files.length !== imageCount) return `${head}${ROUTING_CLOSE}`;
  return `${head}${filesLead(imageCount)}\n${files.join("\n")}\n${ROUTING_CLOSE}`;
}

/** True when `tail` is exactly a routing context for `imageCount` images. */
function isRoutingContext(tail: string, imageCount: number): boolean {
  const head = routingHead(imageCount);
  if (head === null) return false;
  if (tail === `${head}${ROUTING_CLOSE}`) return true;
  const lead = `${head}${filesLead(imageCount)}\n`;
  const close = `\n${ROUTING_CLOSE}`;
  if (!tail.startsWith(lead) || !tail.endsWith(close) || tail.length < lead.length + close.length) {
    return false;
  }
  const files = tail.slice(lead.length, -close.length).split("\n");
  return files.length === imageCount && files.every((file) => file.trim() !== "");
}

export function withAttachmentRoutingContext(
  message: string,
  imageCount: number,
  files?: readonly string[],
): string {
  const context = routingContext(imageCount, files);
  if (context === null) return message;
  return message === "" ? context : `${message}\n\n${context}`;
}

/**
 * Removes a terminal routing context canonical for exactly `imageCount`
 * images, with or without its scratch-file list. A lookalike that is
 * malformed, count-mismatched, or followed by more prose stays visible.
 */
export function stripAttachmentRoutingContext(message: string, imageCount: number): string {
  const at = message.lastIndexOf(ROUTING_PREFIX);
  if (at === -1) return message;
  if (at !== 0 && message.slice(at - 2, at) !== "\n\n") return message;
  if (!isRoutingContext(message.slice(at), imageCount)) return message;
  return at === 0 ? "" : message.slice(0, at - 2);
}

/** Strips a proven terminal routing context whose image count is unknown. */
export function stripTrailingAttachmentRoutingContext(message: string): string {
  const at = message.lastIndexOf(ROUTING_PREFIX);
  if (at === -1) return message;
  // The head line lists exactly n `attachment://` handles and the fixed text
  // and file list have none, so the head line's handle count is the only
  // candidate n.
  const head = message.slice(at).split("\n", 1)[0]!;
  const count = head.split("attachment://").length - 1;
  return stripAttachmentRoutingContext(message, count);
}
