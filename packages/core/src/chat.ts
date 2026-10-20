import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isWithin } from "./worktree";

/** One level under the chats root (ADR-0059); nothing else there is ours to delete. */
export const CHAT_DIR_RE = /^chat-[0-9a-f-]{36}$/;

/** A fresh scratch path for a chat. Pure: the dir is created only after the record is written. */
export function chatDirPath(chatsRoot: string): string {
  return path.join(chatsRoot, `chat-${randomUUID()}`);
}

/** The chats root itself or anything inside it: never registrable as a Project. */
export function isInChatsRoot(chatsRoot: string, candidate: string): boolean {
  return path.resolve(candidate) === path.resolve(chatsRoot) || isWithin(chatsRoot, candidate);
}

/** A canonical chat dir: a direct child of the root with the minted name shape. */
function isCanonicalChatDir(chatsRoot: string, dir: string): boolean {
  const abs = path.resolve(dir);
  return path.dirname(abs) === path.resolve(chatsRoot) && CHAT_DIR_RE.test(path.basename(abs));
}

/**
 * Creates the root and the chat dir, both idempotently: resume recreates a
 * dir the user deleted, and the UUID leaf rules out a name collision. Throws
 * for a non-canonical path, so nothing is ever created outside the root.
 */
export function createChatDir(chatsRoot: string, dir: string): void {
  if (!isCanonicalChatDir(chatsRoot, dir)) throw new Error(`not a chat directory: ${dir}`);
  fs.mkdirSync(chatsRoot, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

/** Deletes one canonical chat dir. false = refused (not canonical); rm failures reject. */
export async function removeChatDir(chatsRoot: string, dir: string): Promise<boolean> {
  if (!isCanonicalChatDir(chatsRoot, dir)) return false;
  await fs.promises.rm(path.resolve(dir), { recursive: true, force: true });
  return true;
}

/**
 * Removes canonical chat dirs no record references (issue #894 boot hygiene).
 * `isReferenced` reads the live registry per entry; chat dirs are created only
 * after their record is written, so a mid-spawn dir is always referenced.
 * Never throws: a missing root resolves to []; per-entry failures are skipped.
 */
export async function sweepOrphanChatDirs(
  chatsRoot: string,
  isReferenced: (absPath: string) => boolean,
): Promise<string[]> {
  const root = path.resolve(chatsRoot);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !CHAT_DIR_RE.test(entry.name)) continue;
    const abs = path.join(root, entry.name);
    if (isReferenced(abs)) continue;
    try {
      await fs.promises.rm(abs, { recursive: true, force: true });
      removed.push(abs);
    } catch {
      // Hygiene only; the next boot retries.
    }
  }
  return removed;
}
