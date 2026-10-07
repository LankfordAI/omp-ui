import { describe, expect, it } from "vitest";
import { withAttachmentRoutingContext } from "./attachment-routing";
import { withDocumentContext } from "./document-context";
import {
  parseRestoreResult,
  parseRestoredMessage,
  projectImages,
  splitQueuedWireText,
} from "./queue-restore";

const TWO_IMAGE_CONTEXT =
  "[omp-ui attachment routing: For tool calls, this prompt's attached images are available as attachment://1, attachment://2. Attachment handles restart at 1 for each prompt.]";

describe("splitQueuedWireText", () => {
  it("recovers prose and document refs from a full wire frame", () => {
    const wire = withAttachmentRoutingContext(
      withDocumentContext("compare these", [
        { name: "a.pdf", path: "/tmp/a.pdf" },
        { name: "Q3: budget.pdf", path: "/tmp/q3.pdf" },
      ]),
      2,
    );
    expect(splitQueuedWireText(wire)).toEqual({
      text: "compare these",
      documents: [
        { name: "a.pdf", path: "/tmp/a.pdf" },
        { name: "Q3: budget.pdf", path: "/tmp/q3.pdf" },
      ],
    });
  });

  it("leaves bare prose untouched", () => {
    expect(splitQueuedWireText("just words")).toEqual({ text: "just words", documents: [] });
  });

  it("keeps raw @tokens and strips only the resolved mention blocks", () => {
    // Same block shape mentions.test.ts's splitter parses; the prose keeps
    // its tokens so the draft re-resolves them at send.
    const wire =
      "read @src/a.ts and @src/b.ts\n\n" +
      '<file path="src/a.ts">\ncontents of a\n</file>\n\n' +
      '<file path="src/b.ts">\ncontents of b\n</file>';
    expect(splitQueuedWireText(wire)).toEqual({
      text: "read @src/a.ts and @src/b.ts",
      documents: [],
    });
  });

  it("keeps a malformed document lookalike as prose", () => {
    const lookalike = "notes\n\n<attached documents>\nnot a pair line\n</attached documents>";
    expect(splitQueuedWireText(lookalike)).toEqual({ text: lookalike, documents: [] });
  });

  it("strips the routing suffix even when it is the whole frame", () => {
    expect(splitQueuedWireText(TWO_IMAGE_CONTEXT)).toEqual({ text: "", documents: [] });
  });

  it("splits all three suffixes in wire order", () => {
    const wire = withAttachmentRoutingContext(
      withDocumentContext(
        'ship @src/a.ts\n\n<file path="src/a.ts">\nbody\n</file>',
        [{ name: "spec.pdf", path: "/p/spec.pdf" }],
      ),
      2,
    );
    expect(splitQueuedWireText(wire)).toEqual({
      text: "ship @src/a.ts",
      documents: [{ name: "spec.pdf", path: "/p/spec.pdf" }],
    });
  });
});

describe("projectImages", () => {
  it("projects type/data/mimeType and drops omp's extra fields", () => {
    expect(
      projectImages([
        { type: "image", data: "QUJD", mimeType: "image/png", detail: "low", url: "x" },
      ]),
    ).toEqual([{ type: "image", data: "QUJD", mimeType: "image/png" }]);
  });

  it("drops non-image blocks and blocks missing a field", () => {
    expect(
      projectImages([
        { type: "text", data: "QUJD", mimeType: "image/png" },
        { type: "image", data: "QUJD" },
        { type: "image", mimeType: 5 },
        "not an object",
      ]),
    ).toEqual([]);
  });

  it("reads a non-array as empty", () => {
    expect(projectImages(undefined)).toEqual([]);
    expect(projectImages({ 0: { type: "image", data: "a", mimeType: "b" } })).toEqual([]);
  });
});

describe("parseRestoredMessage", () => {
  it("requires a string text and projects its images", () => {
    expect(
      parseRestoredMessage({ text: "hello", images: [{ type: "image", data: "QQ==", mimeType: "image/jpeg" }] }),
    ).toEqual({ text: "hello", images: [{ type: "image", data: "QQ==", mimeType: "image/jpeg" }] });
  });

  it("returns null for a non-object or missing text", () => {
    expect(parseRestoredMessage(null)).toBeNull();
    expect(parseRestoredMessage("text")).toBeNull();
    expect(parseRestoredMessage({ images: [] })).toBeNull();
  });

  it("keeps the text when the images list is present-but-malformed", () => {
    expect(parseRestoredMessage({ text: "keep me", images: "oops" })).toEqual({
      text: "keep me",
      images: [],
    });
  });
});

describe("parseRestoreResult", () => {
  it("reads a good envelope with both lists oldest-first", () => {
    const result = parseRestoreResult({
      steering: [{ text: "s1" }],
      followUp: [{ text: "f1", images: [{ type: "image", data: "QQ==", mimeType: "image/png" }] }],
    });
    expect(result).toEqual({
      steering: [{ text: "s1", images: [] }],
      followUp: [{ text: "f1", images: [{ type: "image", data: "QQ==", mimeType: "image/png" }] }],
      imagesDropped: false,
      truncated: false,
    });
  });

  it("reads the two only-ever-true flags", () => {
    const result = parseRestoreResult({ steering: [], followUp: [], imagesDropped: true, truncated: true });
    expect(result?.imagesDropped).toBe(true);
    expect(result?.truncated).toBe(true);
  });

  it("returns null when the envelope or an entry is malformed — restore nothing", () => {
    expect(parseRestoreResult(null)).toBeNull();
    expect(parseRestoreResult([])).toBeNull();
    expect(parseRestoreResult({ steering: [] })).toBeNull();
    expect(parseRestoreResult({ steering: [{ text: "ok" }, { nope: 1 }], followUp: [] })).toBeNull();
  });
});
