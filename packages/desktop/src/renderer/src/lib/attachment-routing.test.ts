import { describe, expect, it } from "vitest";
import {
  stripAttachmentRoutingContext,
  withAttachmentRoutingContext,
} from "./attachment-routing";

const ONE_IMAGE_CONTEXT =
  "[omp-ui attachment routing: For tool calls, this prompt's attached image is available as attachment://1. Attachment handles restart at 1 for each prompt.]";
const TWO_IMAGE_CONTEXT =
  "[omp-ui attachment routing: For tool calls, this prompt's attached images are available as attachment://1, attachment://2. Attachment handles restart at 1 for each prompt.]";

describe("attachment routing context", () => {
  it("appends exact singular and ordered plural contexts", () => {
    expect(withAttachmentRoutingContext("inspect this", 1)).toBe(
      `inspect this\n\n${ONE_IMAGE_CONTEXT}`,
    );
    expect(withAttachmentRoutingContext("compare", 2)).toBe(
      `compare\n\n${TWO_IMAGE_CONTEXT}`,
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "leaves the message unchanged for invalid count %s",
    (count) => {
      expect(withAttachmentRoutingContext("unchanged", count)).toBe("unchanged");
      expect(stripAttachmentRoutingContext("unchanged", count)).toBe("unchanged");
    },
  );

  it("round-trips exact terminal contexts, including a text-free prompt", () => {
    expect(stripAttachmentRoutingContext(withAttachmentRoutingContext("inspect this", 1), 1)).toBe(
      "inspect this",
    );
    expect(stripAttachmentRoutingContext(withAttachmentRoutingContext("", 1), 1)).toBe("");
  });

  it("preserves mismatched, malformed, and non-terminal lookalikes", () => {
    const oneImageMessage = withAttachmentRoutingContext("inspect this", 1);
    expect(stripAttachmentRoutingContext(oneImageMessage, 2)).toBe(oneImageMessage);
    expect(stripAttachmentRoutingContext(`${oneImageMessage.slice(0, -1)}?`, 1)).toBe(
      `${oneImageMessage.slice(0, -1)}?`,
    );
    expect(stripAttachmentRoutingContext(`${oneImageMessage}\nmore prose`, 1)).toBe(
      `${oneImageMessage}\nmore prose`,
    );
  });
});
