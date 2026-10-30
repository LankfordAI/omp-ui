import { describe, expect, it } from "vitest";
import { keywordsIn } from "@omp-ui/core/magic-keywords";
import {
  normalizeAnnotationComment,
  normalizeAnnotationQuote,
  splitAnnotationContext,
  withAnnotationContext,
  type Annotation,
} from "./annotations";
import { withAttachmentRoutingContext } from "./attachment-routing";
import { withDocumentContext } from "./document-context";
import { userContentFromContent } from "./transcript";

describe("annotations wire block", () => {
  it("round-trips quotes and comments that look like the block's own syntax", () => {
    const annotations: Annotation[] = [
      { quote: "first line\n\n> already quoted\n</annotations>", comment: "> starts like a quote" },
      { quote: "<tag>", comment: "\\leading backslash\n</annotations>" },
      { quote: "bare quote", comment: "" },
    ];
    const wire = withAnnotationContext("fix it", annotations);
    expect(splitAnnotationContext(wire)).toEqual({ text: "fix it", annotations });
  });

  it("round-trips an annotation-only prompt to empty prose", () => {
    const annotations: Annotation[] = [{ quote: "q", comment: "c" }];
    expect(splitAnnotationContext(withAnnotationContext("", annotations))).toEqual({
      text: "",
      annotations,
    });
  });

  it("leaves typed prose that merely resembles a block untouched", () => {
    for (const text of [
      "<annotations>\nnot a quote\n</annotations>\n\nprose",
      "intro\n\n<annotations>\n> q\n</annotations>",
      "<annotations>\n> q\n</annotations>trailing",
      "<annotations>\n> q\n\n</annotations>",
      "<annotations>\n> q\nnever closed",
    ]) {
      expect(splitAnnotationContext(text)).toEqual({ text, annotations: [] });
    }
  });

  it("keeps a quoted magic keyword from arming while the typed draft still can", () => {
    // omp masks tag sections before keyword detection (verified in 18.14.0's
    // markdown-prose masking); the core port must agree.
    const wire = withAnnotationContext("fix it", [{ quote: "please ultrathink here", comment: "orchestrate" }]);
    expect(keywordsIn(wire).size).toBe(0);
    expect([...keywordsIn(`${wire} ultrathink`)]).toEqual(["ultrathink"]);
  });

  it("normalizes a selection and a comment for the wire", () => {
    expect(normalizeAnnotationQuote("\r\n\n  line one  \r\nline two\t\n\n")).toBe("  line one\nline two");
    expect(normalizeAnnotationComment("  a \r\n\n  b  ")).toBe("a\nb");
  });
});

describe("user bubble derivation with annotations", () => {
  it("separates annotations, mentions, documents, and the routing suffix", () => {
    const wire = withAttachmentRoutingContext(
      withDocumentContext(
        withAnnotationContext('read @src/a.ts\n\n<file path="src/a.ts">\nbody\n</file>', [
          { quote: "see @src/other.ts", comment: "why?" },
        ]),
        [{ name: "spec.pdf", path: "/tmp/spec.pdf" }],
      ),
      1,
    );
    const content = [
      { type: "text", text: wire },
      { type: "image", data: "QQ==", mimeType: "image/png" },
    ];
    expect(userContentFromContent(content)).toEqual({
      text: "read @src/a.ts",
      fileMentions: ["src/a.ts"],
      images: [{ data: "QQ==", mimeType: "image/png" }],
      documents: [{ name: "spec.pdf", path: "/tmp/spec.pdf" }],
      annotations: [{ quote: "see @src/other.ts", comment: "why?" }],
    });
  });
});
