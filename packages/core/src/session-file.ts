import * as fs from "node:fs";
import type { SessionStatus } from "./types";

export type { SessionStatus };

export interface SessionHead {
  id?: string;
  cwd?: string;
  title?: string;
  created?: string;
}

interface TitleSlotEntry {
  type?: string;
  title?: unknown;
}

interface SessionHeaderEntry {
  type?: string;
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  title?: unknown;
}

/**
 * Parses the 4 KiB prefix window. The fixed-width title slot (line 1 when
 * present) is OPTIONAL, so the header is the first line whose parsed type is
 * "session" — never a fixed offset. Lines not starting with `{` and lines cut
 * by the read window fail cheap and are skipped.
 */
export function parseSessionPrefix(prefix: string): SessionHead {
  let slotTitle: string | undefined;
  for (const line of prefix.split("\n")) {
    if (line.charCodeAt(0) !== 123) continue; // "{"
    let entry: TitleSlotEntry & SessionHeaderEntry;
    try {
      // JSON.parse returns any; every field read below is typeof-guarded.
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "title") {
      if (slotTitle === undefined && typeof entry.title === "string") slotTitle = entry.title;
    } else if (entry.type === "session") {
      const head: SessionHead = {};
      if (typeof entry.id === "string") head.id = entry.id;
      if (typeof entry.cwd === "string") head.cwd = entry.cwd;
      if (typeof entry.timestamp === "string") head.created = entry.timestamp;
      const headerTitle = typeof entry.title === "string" ? entry.title : undefined;
      const title = headerTitle ?? slotTitle;
      if (title !== undefined) head.title = title;
      return head;
    }
  }
  const head: SessionHead = {};
  if (slotTitle !== undefined) head.title = slotTitle;
  return head;
}

interface TailMessage {
  role?: string;
  stopReason?: string;
  content?: unknown;
}

function isToolCallBlock(block: unknown): boolean {
  return typeof block === "object" && block !== null && "type" in block && block.type === "toolCall";
}

// Literal port of statusFromTailMessage (session-listing.ts:197-226).
function statusFromTailMessage(message: TailMessage): SessionStatus {
  switch (message.role) {
    case "assistant": {
      switch (message.stopReason) {
        case "error":
          return "error";
        case "aborted":
          return "aborted";
        case "length":
          return "interrupted";
      }
      // A turn that ends without unanswered tool calls means the agent yielded
      // control back to the user — complete. Trailing tool calls (no tool
      // results after) mean the loop was cut off before running them.
      const content = message.content;
      if (Array.isArray(content) && content.some(isToolCallBlock)) return "interrupted";
      return "complete";
    }
    case "toolResult":
      // Tools ran but the agent never produced the following assistant turn.
      return "interrupted";
    case "user":
      // User message with no assistant reply persisted after it.
      return "pending";
    default:
      return "unknown";
  }
}

/**
 * Literal port of deriveSessionStatus (session-listing.ts:163-190): walk the
 * tail window backwards; the first `message` entry classifies. Within the
 * window only the first line can be a partial fragment — it fails to parse
 * and is skipped.
 */
export function deriveStatusFromTail(tail: string): SessionStatus {
  if (!tail) return "unknown";
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.charCodeAt(0) !== 123) continue;
    let entry: { type?: string; message?: TailMessage };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "message" && entry.message) {
      return statusFromTailMessage(entry.message);
    }
  }
  return "unknown";
}

export async function readSessionHead(filePath: string, prefixBytes = 4096): Promise<string> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(prefixBytes);
    const { bytesRead } = await handle.read(buf, 0, prefixBytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readSessionTail(filePath: string, tailBytes = 32768): Promise<string> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    if (length === 0) return "";
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function hydrateSessionFile(filePath: string): Promise<{
  id?: string;
  title?: string;
  cwd?: string;
  created?: string;
  status: SessionStatus;
  mtime: Date;
}> {
  const [prefix, tail, stat] = await Promise.all([
    readSessionHead(filePath),
    readSessionTail(filePath),
    fs.promises.stat(filePath),
  ]);
  const head = parseSessionPrefix(prefix);
  return { ...head, status: deriveStatusFromTail(tail), mtime: stat.mtime };
}
