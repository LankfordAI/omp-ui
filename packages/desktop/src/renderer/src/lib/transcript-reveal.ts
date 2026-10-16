/**
 * Scroll requests aimed at a tab's native transcript from outside it
 * (Vault notes, issue #767). The transcript owns its window (issue #867), so a
 * requester names an item and the transcript brings it into view.
 */
type RevealListener = (itemId: string) => void;
const listeners = new Map<string, Set<RevealListener>>();

/** Asks `tabId`'s mounted transcript to reveal `itemId`; a no-op when none is mounted. */
export function requestTranscriptReveal(tabId: string, itemId: string): void {
  for (const listener of listeners.get(tabId) ?? []) listener(itemId);
}

/** Subscribes a transcript; returns the unsubscribe. */
export function onTranscriptReveal(tabId: string, listener: RevealListener): () => void {
  let set = listeners.get(tabId);
  if (set === undefined) {
    set = new Set();
    listeners.set(tabId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(tabId);
  };
}
