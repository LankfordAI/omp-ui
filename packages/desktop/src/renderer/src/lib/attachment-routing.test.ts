import { describe, expect, it } from "vitest";
import {
  stripAttachmentRoutingContext,
  stripTrailingAttachmentRoutingContext,
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

  it("lists each image's scratch file in frame order and strips it back off", () => {
    const files = ["/tmp/omp-ui-attach/a.png", "/tmp/omp-ui-attach/b b.webp"];
    const wire = withAttachmentRoutingContext("save these", 2, files);
    expect(wire).toBe(
      `save these\n\n${TWO_IMAGE_CONTEXT.slice(0, -1)} The same images are saved as files, in the same order:\n${files[0]}\n${files[1]}\n]`,
    );
    expect(stripAttachmentRoutingContext(wire, 2)).toBe("save these");
    expect(stripTrailingAttachmentRoutingContext(wire)).toBe("save these");
    const solo = withAttachmentRoutingContext("", 1, [files[0]!]);
    expect(solo).toBe(`${ONE_IMAGE_CONTEXT.slice(0, -1)} The same image is saved as a file:\n${files[0]}\n]`);
    expect(stripAttachmentRoutingContext(solo, 1)).toBe("");
  });

  it("falls back to handles only when the file list does not match the images", () => {
    expect(withAttachmentRoutingContext("x", 2, ["/tmp/only-one.png"])).toBe(`x\n\n${TWO_IMAGE_CONTEXT}`);
  });

  it("keeps a file-list lookalike whose count or shape is wrong visible", () => {
    const wire = withAttachmentRoutingContext("save", 2, ["/a.png", "/b.png"]);
    expect(stripAttachmentRoutingContext(wire, 1)).toBe(wire);
    const missingFile = wire.replace("\n/b.png", "");
    expect(stripAttachmentRoutingContext(missingFile, 2)).toBe(missingFile);
    const blankFile = wire.replace("/b.png", " ");
    expect(stripTrailingAttachmentRoutingContext(blankFile)).toBe(blankFile);
    expect(stripAttachmentRoutingContext(`${wire}\nmore prose`, 2)).toBe(`${wire}\nmore prose`);
  });
});
