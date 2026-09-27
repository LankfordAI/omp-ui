import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extensionToMime } from "./images";
import { inertBlock, keywordsIn, unclosedFence } from "./magic-keywords";
import type { ImageAttachment, ResolvedMentionContext } from "./types";

/**
 * Busy-route `@path` mention resolver.
 *
 * omp natively resolves mentions on the idle prompt path
 * (`AgentSession.#promptWithMessage` → `extractFileMentions`,
 * agent-session.ts:4993), but steer/follow_up queue through
 * `#queueUserMessage`, which never extracts — a mid-run `@file` would reach
 * the model as literal text. On those routes omp-ui resolves and inlines the
 * mention contents itself; idle/interrupt sends rely on omp's native path.
 *
 * The extraction policy below is a faithful port of omp v17.2.6
 * `src/utils/file-mentions.ts` — regexes, boundary rule, sanitizing, dedupe —
 * so a mention the composer's mirror paints is exactly a mention omp's idle
 * path would fire. The read policy diverges deliberately in two places:
 *
 * - paths are confined to projectCwd (the readPlanFile confinement pattern in
 *   desktop/main/backend.ts): renderer-supplied text must not turn this IPC
 *   into an arbitrary file reader. omp itself resolves anywhere.
 * - inline text is capped at 256 KiB, not omp's 5 MiB: on busy routes the
 *   content lands visibly inside the user's own transcript bubble, and a blob
 *   is not a message (branch-diff's MAX_UNTRACKED_BYTES is the precedent).
 *   Idle sends still get omp's native 5 MiB handling.
 */

// --- Ported verbatim from omp's file-mentions.ts ---------------------------

const FILE_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;
/** omp's DEFAULT_DIR_LIMIT. */
const DIR_LISTING_LIMIT = 500;
/** omp's MAX_AUTO_READ_IMAGE_BYTES. */
const OMP_MAX_AUTO_READ_IMAGE_BYTES = 25 * 1024 * 1024;

function isMentionBoundary(text: string, index: number): boolean {
  return index === 0 || MENTION_BOUNDARY_REGEX.test(text[index - 1] as string);
}

function sanitizeMentionPath(rawPath: string): string | null {
  let cleaned = rawPath.trim();
  cleaned = cleaned.replace(LEADING_PUNCTUATION_REGEX, "");
  cleaned = cleaned.replace(TRAILING_PUNCTUATION_REGEX, "");
  cleaned = cleaned.trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** omp's extractFileMentions: boundary check, quoted paths only trimmed. */
function extractMentions(text: string): string[] {
  FILE_MENTION_REGEX.lastIndex = 0; // a module-level /g regex is stateful
  const mentions: string[] = [];
  for (const match of text.matchAll(FILE_MENTION_REGEX)) {
    if (!isMentionBoundary(text, match.index ?? 0)) continue;
    const rawPath = match[1] ?? match[2] ?? match[3];
    if (!rawPath) continue;
    const cleaned =
      match[1] !== undefined || match[2] !== undefined
        ? rawPath.trim()
        : sanitizeMentionPath(rawPath);
    if (!cleaned) continue;
    mentions.push(cleaned);
  }
  return [...new Set(mentions)];
}

// --- omp-ui's own read policy ----------------------------------------------

/**
 * Inline text cap. Deliberately tighter than omp's 5 MiB
 * MAX_AUTO_READ_TEXT_BYTES — see the module header.
 */
const MAX_TEXT_BYTES = 256 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

function skipBody(reason: "binary file" | "too large", size: number): string {
  return `(skipped auto-read: ${reason}, ${formatBytes(size)})`;
}

/** omp's buildDirectoryListing, minus the mtime-age annotations. */
async function directoryListing(absDir: string): Promise<string> {
  let dirents;
  try {
    dirents = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return "(empty directory)";
  }
  dirents.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  if (dirents.length === 0) return "(empty directory)";
  const shown = dirents.slice(0, DIR_LISTING_LIMIT);
  let out = shown.map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).join("\n");
  if (dirents.length > DIR_LISTING_LIMIT) out += `\n[${DIR_LISTING_LIMIT} entries limit reached]`;
  return out;
}

/**
 * Resolves every `@path` mention in `message` against projectCwd and returns
 * the context to append plus any images to attach. Never rejects for content
 * reasons: a missing, moved, or unreadable file simply contributes nothing and
 * the mention stays literal — omp's exact behavior on the idle path.
 */
export async function resolveFileMentions(
  projectCwd: string,
  message: string,
): Promise<ResolvedMentionContext> {
  const root = path.resolve(projectCwd);
  const images: ImageAttachment[] = [];
  const blocks: { mention: string; body: string }[] = [];

  for (const mention of extractMentions(message)) {
    const resolved = path.resolve(root, mention);
    // Confined to the project: absolute paths and `../` escapes stay literal.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      continue; // missing or unreadable: contributes nothing, stays literal
    }

    try {
      if (stat.isDirectory()) {
        blocks.push({ mention, body: await directoryListing(resolved) });
        continue;
      }

      const mimeType = extensionToMime(path.extname(mention));
      if (mimeType !== undefined) {
        if (stat.size > OMP_MAX_AUTO_READ_IMAGE_BYTES) {
          blocks.push({ mention, body: skipBody("too large", stat.size) });
          continue;
        }
        const buf = await fs.readFile(resolved);
        images.push({ type: "image", data: buf.toString("base64"), mimeType });
        blocks.push({ mention, body: "[Image attached]" });
        continue;
      }

      // Size before the null-byte sniff: no read happens for an oversize file.
      if (stat.size > MAX_TEXT_BYTES) {
        blocks.push({ mention, body: skipBody("too large", stat.size) });
        continue;
      }
      const buf = await fs.readFile(resolved);
      if (buf.includes(0)) {
        blocks.push({ mention, body: skipBody("binary file", stat.size) });
        continue;
      }
      blocks.push({ mention, body: buf.toString("utf8") });
    } catch {
      // Deleted between stat and read — contributes nothing, like omp.
    }
  }

  const render = (body: (block: { body: string }) => string): string =>
    blocks.map((block) => `\n\n<file path="${block.mention}">\n${body(block)}\n</file>`).join("");
  // A body with an unclosed fence or an early `</file>` would turn a prose
  // line the user never typed into prose omp matches. When the blocks arm
  // anything beyond what the draft already armed, rebuild every body inert.
  const verbatim = render((block) => block.body);
  if (sameKeywords(keywordsIn(message), keywordsIn(message + verbatim))) {
    return { contextText: verbatim, images };
  }
  // A draft left inside an open fence would swallow the blocks and let a body
  // line close it, so close the draft's own fence first.
  const closer = unclosedFence(message);
  return {
    contextText: (closer === null ? "" : `\n${closer}`) + render((block) => inertBlock(block.body)),
    images,
  };
}

/** True when two keyword sets hold exactly the same words. */
function sameKeywords(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const keyword of a) {
    if (!b.has(keyword)) return false;
  }
  return true;
}
