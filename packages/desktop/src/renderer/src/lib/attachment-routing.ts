const ROUTING_PREFIX = "[omp-ui attachment routing: For tool calls, this prompt's attached ";
const ROUTING_RESTART = " Attachment handles restart at 1 for each prompt.]";

function routingContext(imageCount: number): string | null {
  if (!Number.isSafeInteger(imageCount) || imageCount <= 0) return null;
  const handles = Array.from(
    { length: imageCount },
    (_, index) => `attachment://${index + 1}`,
  ).join(", ");
  const subject = imageCount === 1 ? "image is" : "images are";
  return `${ROUTING_PREFIX}${subject} available as ${handles}.${ROUTING_RESTART}`;
}

export function withAttachmentRoutingContext(message: string, imageCount: number): string {
  const context = routingContext(imageCount);
  if (context === null) return message;
  return message === "" ? context : `${message}\n\n${context}`;
}

export function stripAttachmentRoutingContext(message: string, imageCount: number): string {
  const context = routingContext(imageCount);
  if (context === null) return message;
  if (message === context) return "";
  const suffix = `\n\n${context}`;
  return message.endsWith(suffix) ? message.slice(0, -suffix.length) : message;
}

/** Strips a proven terminal routing context whose image count is unknown. */
export function stripTrailingAttachmentRoutingContext(message: string): string {
  const at = message.lastIndexOf(ROUTING_PREFIX);
  if (at === -1) return message;
  // routingContext(n) lists exactly n `attachment://` handles and its fixed
  // text has none, so the tail's handle count is the only candidate n.
  const count = message.slice(at).split("attachment://").length - 1;
  return stripAttachmentRoutingContext(message, count);
}
