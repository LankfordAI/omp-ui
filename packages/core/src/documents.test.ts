import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDocumentScratch,
  documentScratchDir,
  MAX_DOCUMENT_BYTES,
  resolveDocument,
} from "./documents";
import type { DocumentAttachment } from "./types";

// resolveDocument's data branch writes into the real scratch dir; the sweep
// under test doubles as the fixture teardown.
afterEach(() => clearDocumentScratch());

const PDF = { type: "document" as const, name: "spec.pdf", mimeType: "application/pdf" };

describe("resolveDocument", () => {
  it("writes decoded bytes to a fresh uuid-named .pdf", () => {
    const data = Buffer.from("%PDF-1.4 the bytes must round-trip");
    const file = resolveDocument({ ...PDF, data: data.toString("base64") });
    try {
      expect(file.startsWith(documentScratchDir())).toBe(true);
      expect(file.endsWith(".pdf")).toBe(true);
      expect(fs.readFileSync(file)).toEqual(data);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("never reuses a name, so two documents sharing a name cannot clobber each other", () => {
    const doc = { ...PDF, data: "AAAA" };
    const a = resolveDocument(doc);
    const b = resolveDocument(doc);
    try {
      expect(a).not.toBe(b);
    } finally {
      fs.rmSync(a, { force: true });
      fs.rmSync(b, { force: true });
    }
  });

  it("refuses bytes over the ceiling without touching the disk", () => {
    // base64Bytes is length arithmetic: just over 20 MB of decoded bytes.
    const doc: DocumentAttachment = {
      ...PDF,
      data: "A".repeat(Math.ceil(((MAX_DOCUMENT_BYTES + 1) / 3) * 4)),
    };
    expect(() => resolveDocument(doc)).toThrow(/over the 20 MB document limit/);
    expect(fs.existsSync(documentScratchDir())).toBe(false);
  });

  it("accepts an existing path verbatim — the rewind re-attach re-upload path", () => {
    const dir = fs.mkdtempSync(`${documentScratchDir()}-probe-`);
    try {
      const target = `${dir}/kept.pdf`;
      fs.writeFileSync(target, "%PDF");
      expect(resolveDocument({ ...PDF, path: target })).toBe(target);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a swept path instead of silently prompting with a dead reference", () => {
    expect(() => resolveDocument({ ...PDF, path: "/tmp/omp-ui-attach/gone.pdf" })).toThrow(
      "document not found: /tmp/omp-ui-attach/gone.pdf",
    );
  });

  it("treats both-or-neither data/path as a caller bug", () => {
    expect(() => resolveDocument({ ...PDF })).toThrow("document attachment needs exactly one of data/path");
    expect(() => resolveDocument({ ...PDF, data: "AAAA", path: "/tmp/x.pdf" })).toThrow(
      "document attachment needs exactly one of data/path",
    );
  });
});

describe("clearDocumentScratch", () => {
  it("removes the whole scratch dir and survives a missing one", () => {
    const doc = { ...PDF, data: "AAAA" };
    const file = resolveDocument(doc);
    expect(fs.existsSync(file)).toBe(true);
    clearDocumentScratch();
    expect(fs.existsSync(documentScratchDir())).toBe(false);
    expect(() => clearDocumentScratch()).not.toThrow();
  });
});
