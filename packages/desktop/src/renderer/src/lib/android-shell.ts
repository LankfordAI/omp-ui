import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { desktopViewStorage, DESKTOP_VIEW_STORAGE_KEY, type ViewStorage } from "./desktop-view-state";
import { randomUuid } from "./random-id";

/** Injected at document start on the configured host origin only. Values are CSS pixels. */
declare global {
  interface Window {
    __ompAndroidViewport?: { bookSplitX: number | null };
  }
}

export const ANDROID_VIEW_STORAGE_KEY = "omp-ui.androidView.v1";
const DRAFT_STORAGE_KEY = "omp-ui.androidDrafts.v1";
const PENDING_STORAGE_KEY = "omp-ui.androidPending.v1";
const MAX_DRAFTS = 16;
const MAX_DRAFT_CHARS = 32_768;
const MAX_VIEW_CHARS = 65_536;
const MAX_DRAFT_STORAGE_CHARS = MAX_DRAFTS * (MAX_DRAFT_CHARS * 6 + 1_024);

type TextDraft = { tabId: string; text: string };
type PendingText = TextDraft & { id: string };
type ComposerTextState = TextDraft & { pending: PendingText[]; recoveryInserted: boolean };

export interface AndroidSubmissionRecovery {
  pendingText: string | null;
  recoveryInserted: boolean;
  recover: () => void;
  dismiss: () => void;
  beginSubmission: (text: string) => ((accepted: boolean) => void) | null;
}

export function isAndroidShell(): boolean {
  return typeof window !== "undefined" && window.__ompAndroidViewport !== undefined;
}

/** Reuse the view schema without sharing the desktop/browser snapshot key. */
export function androidViewStorage(): ViewStorage | null {
  if (!isAndroidShell()) return null;
  const storage = desktopViewStorage();
  if (storage === null) return null;
  return {
    getItem: () => {
      const raw = storage.getItem(ANDROID_VIEW_STORAGE_KEY);
      return raw !== null && raw.length <= MAX_VIEW_CHARS ? raw : null;
    },
    setItem: (key, value) => {
      if (key === DESKTOP_VIEW_STORAGE_KEY && value.length <= MAX_VIEW_CHARS) {
        storage.setItem(ANDROID_VIEW_STORAGE_KEY, value);
      }
    },
  };
}

function readDrafts(storage: ViewStorage): TextDraft[] {
  const raw = storage.getItem(DRAFT_STORAGE_KEY);
  if (raw === null || raw.length > MAX_DRAFT_STORAGE_CHARS) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > MAX_DRAFTS) return [];
  const result: TextDraft[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null ||
      typeof entry.tabId !== "string" || entry.tabId.length > 512 ||
      typeof entry.text !== "string" || entry.text.length > MAX_DRAFT_CHARS) return [];
    result.push({ tabId: entry.tabId, text: entry.text });
  }
  return result;
}

export function loadAndroidDraft(tabId: string): string {
  if (!isAndroidShell()) return "";
  try {
    const storage = desktopViewStorage();
    return storage === null ? "" : (readDrafts(storage).find((entry) => entry.tabId === tabId)?.text ?? "");
  } catch {
    return "";
  }
}

function saveAndroidDraft(tabId: string, text: string): void {
  if (!isAndroidShell()) return;
  try {
    const storage = desktopViewStorage();
    if (storage === null) return;
    let drafts: TextDraft[];
    try { drafts = readDrafts(storage); } catch { drafts = []; }
    drafts = drafts.filter((entry) => entry.tabId !== tabId);
    // Do not silently truncate a prompt: oversized drafts remain memory-only.
    if (text !== "" && text.length <= MAX_DRAFT_CHARS && tabId.length <= 512) {
      drafts.unshift({ tabId, text });
    }
    if (drafts.length === 0) storage.removeItem?.(DRAFT_STORAGE_KEY);
    else storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts.slice(0, MAX_DRAFTS)));
  } catch {
    // Quota, corruption, or disabled storage must never block typing/sending.
  }
}

function readPending(storage: ViewStorage): PendingText[] {
  const raw = storage.getItem(PENDING_STORAGE_KEY);
  if (raw === null || raw.length > MAX_DRAFT_STORAGE_CHARS) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > MAX_DRAFTS) return [];
  const rows: PendingText[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null ||
      typeof row.id !== "string" || row.id.length === 0 || row.id.length > 64 ||
      typeof row.tabId !== "string" || row.tabId.length > 512 ||
      typeof row.text !== "string" || row.text.length > MAX_DRAFT_CHARS) return [];
    rows.push({ id: row.id, tabId: row.tabId, text: row.text });
  }
  return rows;
}

function pendingForTab(tabId: string): PendingText[] {
  if (!isAndroidShell()) return [];
  try {
    const storage = desktopViewStorage();
    return storage === null ? [] : readPending(storage).filter((row) => row.tabId === tabId);
  } catch {
    return [];
  }
}

function removePending(ids: ReadonlySet<string>): void {
  if (!isAndroidShell()) return;
  try {
    const storage = desktopViewStorage();
    if (storage === null) return;
    const rows = readPending(storage).filter((row) => !ids.has(row.id));
    if (rows.length === 0) storage.removeItem?.(PENDING_STORAGE_KEY);
    else storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // A storage failure must not claim delivery or trigger a replay.
  }
}

function retainedSubmission(tabId: string, text: string): string | null {
  if (!isAndroidShell() || text === "" || text.length > MAX_DRAFT_CHARS || tabId.length > 512) return null;
  try {
    const storage = desktopViewStorage();
    if (storage === null) return null;
    let rows: PendingText[];
    try { rows = readPending(storage); } catch { rows = []; }
    const id = randomUuid();
    storage.setItem(PENDING_STORAGE_KEY, JSON.stringify([{ id, tabId, text }, ...rows].slice(0, MAX_DRAFTS)));
    return id;
  } catch {
    return null;
  }
}

function composerTextState(tabId: string): ComposerTextState {
  return { tabId, text: loadAndroidDraft(tabId), pending: pendingForTab(tabId), recoveryInserted: false };
}

/** The actual composer text path; attachments and the RPC store never enter storage. */
export function useComposerText(tabId: string): [string, Dispatch<SetStateAction<string>>, AndroidSubmissionRecovery] {
  const [value, setValue] = useState(() => composerTextState(tabId));
  const current = useRef(value);
  if (value.tabId !== tabId) {
    const next = composerTextState(tabId);
    current.current = next;
    setValue(next);
  } else {
    current.current = value;
  }
  const setText = useCallback<Dispatch<SetStateAction<string>>>((action) => {
    const text = typeof action === "function" ? action(current.current.text) : action;
    current.current = { ...current.current, tabId, text };
    // Normal drafts clear synchronously; unconfirmed submissions have their own bounded store.
    saveAndroidDraft(tabId, text);
    setValue(current.current);
  }, [tabId]);
  const pendingText = useMemo(() => value.pending.length === 0 ? null :
    [...value.pending].reverse().map((row) => row.text).join("\n\n"), [value.pending]);
  const recover = useCallback(() => {
    const state = current.current;
    if (state.recoveryInserted || state.pending.length === 0) return;
    const recovered = [...state.pending].reverse().map((row) => row.text).join("\n\n");
    const text = state.text === "" ? recovered : `${state.text}\n\n${recovered}`;
    saveAndroidDraft(tabId, text);
    const persisted = loadAndroidDraft(tabId) === text;
    if (persisted) removePending(new Set(state.pending.map((row) => row.id)));
    current.current = { ...state, text, pending: persisted ? [] : state.pending, recoveryInserted: true };
    setValue(current.current);
  }, [tabId]);
  const dismiss = useCallback(() => {
    const state = current.current;
    removePending(new Set(state.pending.map((row) => row.id)));
    current.current = { ...state, pending: [], recoveryInserted: false };
    setValue(current.current);
  }, []);
  const beginSubmission = useCallback((text: string) => {
    const id = retainedSubmission(tabId, text);
    if (id === null) return null;
    return (accepted: boolean) => {
      if (accepted) removePending(new Set([id]));
      else if (current.current.tabId === tabId) {
        current.current = { ...current.current, pending: pendingForTab(tabId), recoveryInserted: false };
        setValue(current.current);
      }
    };
  }, [tabId]);
  return [current.current.text, setText, { pendingText, recoveryInserted: value.recoveryInserted, recover, dismiss, beginSubmission }];
}
