// The Needs-attention stack's marks (issue #1037): one per session with a
// reply that arrived while nobody was looking. The mark is renderer-local view
// state — never a count, never on the session record, never synced across
// renderers (CONTEXT.md) — so it lives outside the registry in its own
// localStorage key, in the best-effort style of lib/sidebar-section-open.ts:
// only the newest unseen atMs persists; the snippet is a live-session nicety.
//
// Known v1 gaps, all consequences of raising from this renderer's own frame
// feed: a stalled session answers no message_end, so it never joins the stack
// until its next reply; PTY tabs have no rpc frames and never raise; remote
// instance rows never raise, because their frames belong to the owning
// instance's feed. And the flag is per-renderer — a web client clearing a mark
// clears only its own copy, exactly like every other view preference here.
import type { StateCreator } from "zustand";
import type { UiStore } from "../types";

/** localStorage key: `Record<tabId, atMs>`, mirrors of the in-memory marks. */
const UNREAD_STORAGE_KEY = "omp-ui.unreadSessions";

/** Marks kept; the oldest drop first. A cap, not a design surface. */
const UNREAD_CAP = 200;

/** The stack row's one-line preview; longer replies truncate here. */
const SNIPPET_MAX_CHARS = 140;

export interface UnreadMark {
  /** Epoch ms of the newest unseen reply. */
  atMs: number;
  /** Truncated first text block of that reply; null after a restart (never persisted). */
  snippet: string | null;
}

export interface UnreadSlice {
  unread: Record<string, UnreadMark>;
  markUnread(tabId: string, snippet: string | null): void; // newest-wins overwrite
  clearUnread(tabId: string): void;
  pruneUnread(liveTabIds: ReadonlySet<string>): void;
}

/** This renderer's storage, or null when there is none (node tests, private
 *  mode) — then the stack simply never persists, same split as section-open. */
function unreadStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The persisted shape: every surviving mark's atMs, snippets absent. */
function mirroredMarks(unread: Record<string, UnreadMark>): Record<string, number> {
  const mirror: Record<string, number> = {};
  for (const [tabId, mark] of Object.entries(unread)) mirror[tabId] = mark.atMs;
  return mirror;
}

/** Persist best-effort; storage failures never take a stack update down. */
function mirrorUnread(unread: Record<string, UnreadMark>): void {
  try {
    unreadStorage()?.setItem(UNREAD_STORAGE_KEY, JSON.stringify(mirroredMarks(unread)));
  } catch {
    // Storage unavailable or full: the in-memory stack still applies.
  }
}

/** Cap 200, oldest atMs first. A tie (same ms) resolves by key order. */
function capUnread(unread: Record<string, UnreadMark>): Record<string, UnreadMark> {
  const entries = Object.entries(unread);
  if (entries.length <= UNREAD_CAP) return unread;
  entries.sort((a, b) => a[1].atMs - b[1].atMs || (a[0] < b[0] ? -1 : 1));
  const kept: Record<string, UnreadMark> = {};
  for (const [tabId, mark] of entries.slice(entries.length - UNREAD_CAP)) {
    kept[tabId] = mark;
  }
  return kept;
}

/** Hydrate at slice creation: the persisted atMs values come back snippetless. */
function hydrateUnread(): Record<string, UnreadMark> {
  const storage = unreadStorage();
  if (storage === null) return {};
  let parsedRaw: string | null;
  try {
    parsedRaw = storage.getItem(UNREAD_STORAGE_KEY);
  } catch {
    return {};
  }
  if (parsedRaw === null) return {};
  try {
    const parsed: unknown = JSON.parse(parsedRaw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const unread: Record<string, UnreadMark> = {};
    for (const [tabId, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        unread[tabId] = { atMs: value, snippet: null };
      }
    }
    return capUnread(unread);
  } catch {
    return {};
  }
}

export const createUnreadSlice: StateCreator<UiStore, [], [], UnreadSlice> = (
  set,
  get,
  api,
) => {
  /** The one clear-on-view hook (issue #1037): when a tab becomes the active
   *  tab, its unseen replies are seen. Keyed on the activeTabId transition
   *  rather than on callers so it covers every writer at once — including
   *  restoreSavedTabs and focusOn — without each needing its own clear. */
  // Seeded null, not get().activeTabId: zustand has no state yet while the
  // slice factories run, and a fresh store's activeTabId is null anyway.
  let wasActive: string | null = null;
  api.subscribe((state) => {
    const active = state.activeTabId;
    if (active === wasActive) return;
    wasActive = active;
    if (active !== null && state.unread[active] !== undefined) get().clearUnread(active);
  });

  return {
    unread: hydrateUnread(),

    markUnread(tabId, snippet) {
      // Newest wins: a re-arrival re-stamps atMs and replaces the preview.
      // Mid-turn toolUse ends also raise (frame-reduction's hook); the
      // stack's state filter hides working sessions until the final end.
      set((s) => ({
        unread: capUnread({ ...s.unread, [tabId]: { atMs: Date.now(), snippet } }),
      }));
      mirrorUnread(get().unread);
    },

    clearUnread(tabId) {
      if (get().unread[tabId] === undefined) return;
      const next = { ...get().unread };
      delete next[tabId];
      set({ unread: next });
      mirrorUnread(next);
    },

    pruneUnread(liveTabIds) {
      let changed = false;
      const next: Record<string, UnreadMark> = {};
      for (const [tabId, mark] of Object.entries(get().unread)) {
        if (liveTabIds.has(tabId)) next[tabId] = mark;
        else changed = true;
      }
      if (!changed) return;
      set({ unread: next });
      mirrorUnread(next);
    },
  };
};

/**
 * Whether a reply in `tabId` is unseen: raise only when the tab is NOT both
 * the active tab AND inside a focused, visible window — the same out-of-view
 * gate #271's desktop notification uses. No DOM (node tests): treat as
 * out-of-view and raise.
 */
export function unreadRaisePredicate(tabId: string, activeTabId: string | null): boolean {
  if (typeof document === "undefined") return true;
  return !(tabId === activeTabId && document.hasFocus() && !document.hidden);
}

/**
 * The other half of returning-to-view (issue #1037): focus the window, or make
 * it visible, and the tab you land on is being looked at — clear its mark
 * ("I came back and was already looking at it"). Installed once from init();
 * returns the disposer. Guards missing DOM like every other renderer global
 * here (themes.ts).
 */
export function installUnreadViewListeners(
  get: () => Pick<UiStore, "activeTabId" | "clearUnread">,
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const clearViewed = (): void => {
    if (!document.hasFocus() || document.hidden) return;
    const tabId = get().activeTabId;
    if (tabId !== null) get().clearUnread(tabId);
  };
  window.addEventListener("focus", clearViewed);
  document.addEventListener("visibilitychange", clearViewed);
  return () => {
    window.removeEventListener("focus", clearViewed);
    document.removeEventListener("visibilitychange", clearViewed);
  };
}

/**
 * The stack row's preview: the first non-empty text block of a message_end
 * payload (content is a string or an array of `{ type: "text", text }`
 * blocks), trimmed and capped at 140 chars; null when it holds no text.
 */
export function firstAssistantText(content: unknown): string | null {
  const blocks: unknown[] =
    typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    if (!("type" in block) || block.type !== "text") continue;
    if (!("text" in block) || typeof block.text !== "string") continue;
    const trimmed = block.text.trim();
    if (trimmed === "") continue;
    return trimmed.length > SNIPPET_MAX_CHARS ? trimmed.slice(0, SNIPPET_MAX_CHARS) : trimmed;
  }
  return null;
}
