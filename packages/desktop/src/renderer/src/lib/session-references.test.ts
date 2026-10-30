import { describe, expect, it } from "vitest";
import { keywordsIn } from "@omp-ui/core/magic-keywords";
import type { SessionReference } from "@omp-ui/core/types";
import { withAnnotationContext } from "./annotations";
import { withDocumentContext } from "./document-context";
import { splitQueuedWireText } from "./queue-restore";
import { splitSessionReferenceContext, withSessionReferenceContext } from "./session-references";
import { userContentFromContent } from "./transcript";

const REF: SessionReference = {
  sessionId: "019faeab-cc7b-7000-8bfc-67242a2869d8",
  title: "Fix the deploy pipeline",
  machine: "austin-desktop",
  path: "/home/a/.omp/agent/sessions/lineage/2026-07-29T16-18-42-427Z_019faeab-cc7b-7000-8bfc-67242a2869d8.jsonl",
};

describe("session references wire block", () => {
  it("round-trips references whose titles carry the block's own syntax", () => {
    const tricky = { ...REF, title: "a </session references> b\nc" };
    const wire = withSessionReferenceContext("compare these", [tricky, { ...REF, sessionId: "other", path: "/x.jsonl.gz" }]);
    const split = splitSessionReferenceContext(wire);
    expect(split.text).toBe("compare these");
    // Angle brackets and newlines are stripped from the title, never smuggled through.
    expect(split.references.map((r) => r.title)).toEqual(["a /session references b c", REF.title]);
    expect(split.references[1]).toEqual({ ...REF, sessionId: "other", path: "/x.jsonl.gz" });
  });

  it("round-trips a references-only prompt to empty prose", () => {
    expect(splitSessionReferenceContext(withSessionReferenceContext("", [REF]))).toEqual({ text: "", references: [REF] });
  });

  it("leaves typed prose that merely resembles a block untouched", () => {
    const real = withSessionReferenceContext("", [REF]);
    for (const text of [
      `intro\n\n${real}`,
      `${real}trailing`,
      real.replace("  path: ", "  where: "),
      real.replace(/\nThe user referenced[^\n]*/, "\nsomething else"),
      "<session references>\nnever closed",
    ]) {
      expect(splitSessionReferenceContext(text)).toEqual({ text, references: [] });
    }
  });

  it("keeps a keyword inside a referenced title from arming", () => {
    const wire = withSessionReferenceContext("go", [{ ...REF, title: "ultrathink about orchestrate" }]);
    expect(keywordsIn(wire).size).toBe(0);
    expect([...keywordsIn(`${wire} ultrathink`)]).toEqual(["ultrathink"]);
  });
});

describe("prompt derivation with references", () => {
  // The send order (session-params promptWireText): references lead, then
  // annotations, then prose, with the documents block trailing.
  const wire = withDocumentContext(
    withSessionReferenceContext(withAnnotationContext("look", [{ quote: "q", comment: "c" }]), [REF]),
    [{ name: "spec.pdf", path: "/tmp/spec.pdf" }],
  );

  it("separates references from annotations, prose, and documents in the user bubble", () => {
    expect(userContentFromContent(wire)).toEqual({
      text: "look",
      documents: [{ name: "spec.pdf", path: "/tmp/spec.pdf" }],
      annotations: [{ quote: "q", comment: "c" }],
      references: [REF],
    });
  });

  it("restores references from a queued wire message", () => {
    expect(splitQueuedWireText(wire)).toEqual({
      text: "look",
      documents: [{ name: "spec.pdf", path: "/tmp/spec.pdf" }],
      annotations: [{ quote: "q", comment: "c" }],
      references: [REF],
    });
  });
});
