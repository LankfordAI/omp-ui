/**
 * The attached-documents block (ADR-0044): the pdf Document Attachments
 * ride the prompt as a trailing block naming the scratch path materialized
 * on the machine that owns the session — the rpc frame has no document
 * field, so the path IS the channel. Like the image routing suffix the
 * block is omp-ui-authored prose the transcript derivation parses back out
 * into chips; unlike the image suffix it cannot be reconstructed (the
 * uuid paths exist nowhere else), so the split is parse-shaped.
 */

export interface DocumentRef {
  name: string;
  path: string;
}

const BLOCK_OPEN = "<attached documents>";
const BLOCK_CLOSE = "</attached documents>";

/** Strips the block-shaping characters a display name could smuggle. */
export function sanitizeDocumentName(name: string): string {
  return name.replace(/[<>\r\n]/g, "").trim() || "document.pdf";
}

export function withDocumentContext(message: string, docs: readonly DocumentRef[]): string {
  if (docs.length === 0) return message;
  const block = `${BLOCK_OPEN}\n${docs.map((doc) => `${sanitizeDocumentName(doc.name)}: ${doc.path}`).join("\n")}\n${BLOCK_CLOSE}`;
  return message === "" ? block : `${message}\n\n${block}`;
}

/**
 * Removes only the proven terminal attached-documents block, mirroring
 * `splitResolvedMentionContext`: a lookalike anywhere else — or a block
 * whose lines don't parse as `name: path` pairs — passes through untouched.
 * `(?:^|\n\n)` so a documents-only prompt — where withDocumentContext emits
 * the bare block — round-trips to empty prose.
 */
const BLOCK_RE = /(?:^|\n\n)<attached documents>\n((?:[^\n]*\n?)*?)<\/attached documents>$/;
export function splitDocumentContext(text: string): { text: string; documents: DocumentRef[] } {
  const match = BLOCK_RE.exec(text);
  if (match === null) return { text, documents: [] };
  const lines = match[1]!.split("\n").filter((line) => line !== "");
  const documents: DocumentRef[] = [];
  for (const line of lines) {
    // Last separator: display names like "Q3: budget.pdf" are common, and a
    // path carrying ": " essentially is not (scratch paths are uuid files).
    const sep = line.lastIndexOf(": ");
    if (sep <= 0 || sep + 2 >= line.length) return { text, documents: [] };
    documents.push({ name: line.slice(0, sep), path: line.slice(sep + 2) });
  }
  if (documents.length === 0) return { text, documents: [] };
  return { text: text.slice(0, match.index), documents };
}
