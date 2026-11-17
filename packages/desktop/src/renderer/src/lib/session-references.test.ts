import { describe, expect, it } from "vitest";
import { keywordsIn } from "@omp-ui/core/magic-keywords";
import { SESSION_REFERENCE_HINT, SESSION_REFERENCE_HINT_V2 } from "@omp-ui/core/artifact-references";
import type { SessionReference } from "@omp-ui/core/types";
import { withAnnotationContext } from "./annotations";
import { withDocumentContext } from "./document-context";
import { splitQueuedWireText } from "./queue-restore";
import { sessionReferenceHint, splitSessionReferenceContext, withSessionReferenceContext } from "./session-references";
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

// Issue #1189: omp 18.20.3 removed the seance agent, so the hint must name a
// route the harness actually has — while blocks saved under the old hint line
// keep parsing forever.
describe("hint form follows the harness (issue #1189)", () => {
  it("emits the seance line only inside the seance window", () => {
    expect(sessionReferenceHint("18.11.3")).toBe(SESSION_REFERENCE_HINT);
    expect(sessionReferenceHint("18.20.2")).toBe(SESSION_REFERENCE_HINT);
    expect(sessionReferenceHint("18.20.3")).toBe(SESSION_REFERENCE_HINT_V2);
    expect(sessionReferenceHint("18.22.0")).toBe(SESSION_REFERENCE_HINT_V2);
    // Unknown harness: byte-stable with every older build — only a positively
    // known removal rewrites the wire.
    expect(sessionReferenceHint(null)).toBe(SESSION_REFERENCE_HINT);
  });

  it("writes the v2 hint for a removed harness and none of the seance grammar", () => {
    const wire = withSessionReferenceContext("compare", [REF], "18.21.0");
    expect(wire.startsWith(`<session references>\n${SESSION_REFERENCE_HINT_V2}\n`)).toBe(true);
    expect(wire).not.toContain("seance");
    expect(wire).not.toContain("sourceSession");
  });

  it("defaults to the legacy hint line when no version is given", () => {
    expect(withSessionReferenceContext("", [REF]).startsWith(`<session references>\n${SESSION_REFERENCE_HINT}\n`)).toBe(true);
  });

  it("parses both hint forms back into the same references", () => {
    const legacy = withSessionReferenceContext("go", [REF]);
    const v2 = withSessionReferenceContext("go", [REF], "18.22.0");
    expect(splitSessionReferenceContext(legacy).references).toEqual([REF]);
    expect(splitSessionReferenceContext(v2).references).toEqual([REF]);
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
      artifactReferences: [],
      refreshes: [],
      legacyRefreshRequestId: null,
    });
  });
});
