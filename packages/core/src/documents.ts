import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { base64Bytes, imageExtension, MAX_IMAGE_BYTES } from "./images";
import type { DocumentAttachment, ImageAttachment } from "./types";

/**
 * Document-Attachment plumbing (ADR-0044): the omp rpc protocol carries no
 * document field, so a PDF is materialized to a scratch file on the machine
 * that owns the session and referenced by absolute path in the prompt text,
 * where omp's `read` tool converts it to text. Same scratch-dir discipline
 * as images.ts: one dir per app, swept on quit.
 */
export type { DocumentAttachment };

/** Per-file ceiling; mirrors the image UX ceiling rather than a wire limit. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * Base64-bytes ceiling per `session:attachDocument` request. The remote WS
 * transport caps a client frame at 64 MiB (server/index.ts); keeping the
 * batch under 48 MiB leaves room for JSON framing overhead.
 */
export const MAX_DOCUMENT_BATCH_BYTES = 48 * 1024 * 1024;

/** The one document type handled today; the extension point for later ones. */
export const DOCUMENT_MIME = "application/pdf";

/**
 * Where Document Attachments and native-prompt image copies (issue #993)
 * materialize; swept on quit like the PTY paste dir.
 */
export function documentScratchDir(): string {
  return path.join(os.tmpdir(), "omp-ui-attach");
}

/**
 * Writes a native prompt's image to a fresh uuid-named scratch file on THIS
 * machine and returns its absolute path (issue #993). The image still rides
 * the prompt frame's `images`; this copy is the file the agent's tools work
 * with, named in the attachment routing suffix. Same ceiling as the frame.
 */
export function writeImageAttachment(image: ImageAttachment): string {
  if (base64Bytes(image.data) > MAX_IMAGE_BYTES) {
    throw new Error(`image is over omp's ${MAX_IMAGE_BYTES / (1024 * 1024)} MB input limit`);
  }
  const dir = documentScratchDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.${imageExtension(image.mimeType)}`);
  fs.writeFileSync(file, Buffer.from(image.data, "base64"));
  return file;
}

/**
 * Resolves one document to an absolute path on THIS machine: writes `data`
 * to a fresh uuid-named file, or verifies an existing `path` (the rewind
 * prefill re-sends a path already on this host — no re-upload). Exactly one
 * of the two fields must be set; both/neither is a caller bug, not input.
 */
export function resolveDocument(doc: DocumentAttachment): string {
  if ((doc.data === undefined) === (doc.path === undefined)) {
    throw new Error("document attachment needs exactly one of data/path");
  }
  if (doc.path !== undefined) {
    if (!fs.existsSync(doc.path)) throw new Error(`document not found: ${doc.path}`);
    return doc.path;
  }
  const data = doc.data!;
  if (base64Bytes(data) > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `${doc.name} is ${(base64Bytes(data) / (1024 * 1024)).toFixed(1)} MB — over the 20 MB document limit`,
    );
  }
  const dir = documentScratchDir();
  fs.mkdirSync(dir, { recursive: true });
  // A fresh uuid, never the clipboard's name: two documents sharing a name
  // must not collide, same reasoning as writeImageToScratch.
  const file = path.join(dir, `${randomUUID()}.pdf`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

/**
 * Reads a materialized Document Attachment back as base64 (issue #989): a
 * stashed draft must outlive the quit sweep and travel to another host, so a
 * path-only chip (rewind prefill, restored queue entry) is re-captured as
 * bytes. Only a `.pdf` inside THIS machine's scratch dir is readable — the
 * channel must not become a general file read.
 */
export function readScratchDocument(file: string): string {
  let real: string;
  let root: string;
  try {
    real = fs.realpathSync(file);
    root = fs.realpathSync(documentScratchDir());
  } catch {
    throw new Error(`document not found: ${file}`);
  }
  if (path.dirname(real) !== root || path.extname(real).toLowerCase() !== ".pdf") {
    throw new Error(`not an attached document: ${file}`);
  }
  const size = fs.statSync(real).size;
  if (size > MAX_DOCUMENT_BYTES) {
    throw new Error(`${path.basename(real)} is ${(size / (1024 * 1024)).toFixed(1)} MB — over the 20 MB document limit`);
  }
  return fs.readFileSync(real).toString("base64");
}

/** Best-effort sweep of the scratch dir on quit; failure is not worth surfacing. */
export function clearDocumentScratch(): void {
  try {
    fs.rmSync(documentScratchDir(), { recursive: true, force: true });
  } catch {
    // Left for the OS to reap.
  }
}
