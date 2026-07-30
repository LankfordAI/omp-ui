import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageAttachment } from "./types";

/**
 * Pasted-image plumbing shared by both modes.
 *
 * omp accepts exactly four input mime types and re-encodes anything else
 * (pi-utils `SUPPORTED_IMAGE_MIME_TYPES`, v17.1.8). omp-ui does no decoding of
 * its own: it forwards the clipboard's bytes and lets omp normalize, so a
 * format omp would accept is never rejected here for lack of a codec.
 *
 * The two modes need different shapes of the same bytes:
 * - rpc-ui takes them inline as `images: ImageContent[]` on the prompt frame.
 *   The advertised 1 MiB `maxFrameBytes` is outbound-only — omp's stdin reader
 *   applies no cap — so an image goes as one JSON line, never chunked
 *   (`rpc_chunk` is an outbound-only frame and would parse as an unknown
 *   command).
 * - the PTY has no byte channel at all, so the bytes are written to a temp file
 *   and the *path* is delivered as a bracketed paste, which omp's TUI editor
 *   recognises and loads itself.
 */
export type { ImageAttachment };

/** omp's four accepted input types; anything else it re-encodes to PNG. */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/**
 * omp's own `MAX_IMAGE_INPUT_BYTES`. omp does not enforce it on the rpc
 * `images` field, so omp-ui enforces it instead of letting a 200 MB paste
 * become a 270 MB JSON line.
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** The extension omp's bracketed-paste detector requires, per mime type. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * omp's TUI only treats a pasted path as an image when it ends in a known
 * extension, so an unrecognised mime type gets `.png` — the format omp itself
 * converts to, and the one its detector is most likely to accept.
 */
export function imageExtension(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? "png";
}

export function isSupportedImageMime(mimeType: string): boolean {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Byte length of a base64 payload without allocating the decoded buffer. */
export function base64Bytes(data: string): number {
  const len = data.length;
  if (len === 0) return 0;
  let padding = 0;
  if (data[len - 1] === "=") padding += 1;
  if (len > 1 && data[len - 2] === "=") padding += 1;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Where PTY-mode pastes are materialized: one dir per app run, so a crash
 * leaves a single sweepable directory rather than files scattered in $TMPDIR.
 */
export function imageScratchDir(): string {
  return path.join(os.tmpdir(), "omp-ui-paste");
}

/**
 * Writes an attachment to the scratch dir and returns its absolute path.
 *
 * The name is a fresh uuid, never the clipboard's: two pastes of different
 * screenshots that happen to share a name must not collide, and omp reads the
 * file after the paste is delivered — an overwritten path would attach the
 * wrong image.
 */
export function writeImageToScratch(image: ImageAttachment): string {
  const dir = imageScratchDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.${imageExtension(image.mimeType)}`);
  fs.writeFileSync(file, Buffer.from(image.data, "base64"));
  return file;
}

/** Best-effort sweep of the scratch dir on quit; failure is not worth surfacing. */
export function clearImageScratch(): void {
  try {
    fs.rmSync(imageScratchDir(), { recursive: true, force: true });
  } catch {
    // Left for the OS to reap.
  }
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * The PTY payload for one pasted image: omp's TUI editor scans bracketed-paste
 * content for a single explicit path with an image extension and loads it as an
 * image block (`extractBracketedImagePastePath`, v17.1.8).
 *
 * One path per paste, deliberately: omp refuses a payload carrying two path
 * anchors — `/tmp/a.png /tmp/b.png` attaches nothing — so a multi-image paste
 * must be delivered as separate bracketed pastes.
 */
export function bracketedImagePaste(filePath: string): string {
  return `${BRACKETED_PASTE_START}${filePath}${BRACKETED_PASTE_END}`;
}
