import { describe, expect, it } from "vitest";
import {
  sanitizeDocumentName,
  splitDocumentContext,
  withDocumentContext,
  type DocumentRef,
} from "./document-context";

const REFS: DocumentRef[] = [
  { name: "spec.pdf", path: "/tmp/omp-ui-attach/aaa.pdf" },
  { name: "invoice 2026.pdf", path: "/tmp/omp-ui-attach/bbb.pdf" },
];

describe("withDocumentContext", () => {
  it("leaves a document-free message untouched", () => {
    expect(withDocumentContext("hello", [])).toBe("hello");
  });

  it("appends the block after a blank line", () => {
    expect(withDocumentContext("read this", [REFS[0]!])).toBe(
      "read this\n\n<attached documents>\nspec.pdf: /tmp/omp-ui-attach/aaa.pdf\n</attached documents>",
    );
  });

  it("emits the bare block for a documents-only prompt", () => {
    expect(withDocumentContext("", [REFS[0]!])).toBe(
      "<attached documents>\nspec.pdf: /tmp/omp-ui-attach/aaa.pdf\n</attached documents>",
    );
  });
});

describe("splitDocumentContext", () => {
  it("round-trips a composed message back to prose plus refs, in order", () => {
    const wire = withDocumentContext("compare these", REFS);
    expect(splitDocumentContext(wire)).toEqual({ text: "compare these", documents: REFS });
  });

  it("round-trips a documents-only prompt to empty prose", () => {
    const wire = withDocumentContext("", REFS);
    expect(splitDocumentContext(wire)).toEqual({ text: "", documents: REFS });
  });

  it("keeps a name containing a colon intact — the split is on the first separator", () => {
    const refs = [{ name: "Q3: budget.pdf", path: "/tmp/x.pdf" }];
    expect(splitDocumentContext(withDocumentContext("look", refs))).toEqual({
      text: "look",
      documents: refs,
    });
  });

  it("passes a prose-embedded lookalike block through untouched", () => {
    const text = "the tag <attached documents>\nname: /p.pdf\n</attached documents> is markup";
    expect(splitDocumentContext(text)).toEqual({ text, documents: [] });
  });

  it("passes a malformed terminal block through untouched", () => {
    const text = "note\n\n<attached documents>\nnot a pair line\n</attached documents>";
    expect(splitDocumentContext(text)).toEqual({ text, documents: [] });
  });

  it("passes an empty terminal block through untouched", () => {
    const text = "note\n\n<attached documents>\n</attached documents>";
    expect(splitDocumentContext(text)).toEqual({ text, documents: [] });
  });
});

describe("sanitizeDocumentName", () => {
  it("strips the characters that would shape the block", () => {
    expect(sanitizeDocumentName("a<b>c\r\nd.pdf")).toBe("abcd.pdf");
  });

  it("falls back when nothing survives the strip", () => {
    expect(sanitizeDocumentName("<> \n")).toBe("document.pdf");
  });
});
