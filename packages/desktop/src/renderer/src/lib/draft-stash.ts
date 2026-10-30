import { useSyncExternalStore } from "react";
import type { DocumentAttachment, ImageAttachment } from "@omp-ui/core/types";
import type { Annotation } from "./annotations";
import type { DraftSessionReference } from "./session-references";
import { randomId } from "./random-id";

/**
 * The draft stash (issue #989): composer drafts parked app-wide, outside any
 * tab, so one can be moved into another session's composer. A stashed draft
 * carries everything the composer draft does — text, image Attachments,
 * Document Attachments, annotations, session references — and every document carries its bytes:
 * a scratch path is valid only on the host that wrote it and only until the
 * quit sweep (ADR-0044), so applying re-materializes on the target's host at
 * send like any picked PDF.
 *
 * Kept in this client's IndexedDB, not localStorage: images and PDFs run to
 * 20 MB each, far past localStorage's quota. Without IndexedDB (a test DOM)
 * the stash lives in memory for the page's life.
 */
export interface StashedDraft {
  id: string;
  /** Epoch ms; the picker lists newest first. */
  stashedAt: number;
  text: string;
  images: ImageAttachment[];
  /** Every entry has `data`, never `path`. */
  documents: DocumentAttachment[];
  annotations: Annotation[];
  /**
   * Session references with their owning instance (issue #984). Absent on a
   * draft stashed before them. Applying them to a session on another
   * instance refuses them, like dropping a row there would.
   */
  references?: DraftSessionReference[];
}

export type DraftContent = Omit<StashedDraft, "id" | "stashedAt">;

const DB_NAME = "omp-ui-draft-stash";
const STORE = "drafts";

let drafts: readonly StashedDraft[] = [];
const listeners = new Set<() => void>();
let db: Promise<IDBDatabase | null> | null = null;

function emit(next: readonly StashedDraft[]): void {
  drafts = next;
  for (const listener of listeners) listener();
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error("draft stash storage failed"));
  return promise;
}

/** Opens the store once and seeds the list from it; null = memory only. A failed open retries next time. */
function open(): Promise<IDBDatabase | null> {
  db ??= (async () => {
    if (typeof indexedDB === "undefined") return null;
    const opening = indexedDB.open(DB_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE, { keyPath: "id" });
    const handle = await request(opening);
    const stored = await request(handle.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<StashedDraft[]>);
    emit(sortNewestFirst(stored));
    return handle;
  })().catch((err: unknown) => {
    db = null;
    throw err;
  });
  return db;
}

function sortNewestFirst(list: StashedDraft[]): StashedDraft[] {
  return list.sort((a, b) => b.stashedAt - a.stashedAt);
}

async function write(mutate: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  const handle = await open();
  if (handle === null) return;
  await request(mutate(handle.transaction(STORE, "readwrite").objectStore(STORE)));
}

/** Stashed drafts, newest first; the first read starts loading the store. */
export function useDraftStash(): readonly StashedDraft[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      void open().catch(() => {});
      return () => listeners.delete(cb);
    },
    () => drafts,
  );
}

/** Persists before it lists, so a failed write never reports a draft as stashed. */
export async function stashDraft(content: DraftContent): Promise<StashedDraft> {
  const draft: StashedDraft = { id: randomId(), stashedAt: Date.now(), ...content };
  await write((store) => store.put(draft));
  emit(sortNewestFirst([draft, ...drafts]));
  return draft;
}

/**
 * Removes a draft and hands it back — apply and delete are the same move;
 * null when another composer took it first.
 */
export async function takeStashedDraft(id: string): Promise<StashedDraft | null> {
  const draft = drafts.find((d) => d.id === id) ?? null;
  if (draft === null) return null;
  emit(drafts.filter((d) => d.id !== id));
  await write((store) => store.delete(id));
  return draft;
}
