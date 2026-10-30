import { useEffect } from "react";
import { useStore } from "../store";
import { isTypingTarget, matchesHotkey } from "./hotkeys";
import { useKeybinding } from "./keybindings";

/**
 * The undo-settle chord (`Mod+Z` unless rebound in Settings → Keyboard, issue
 * #998) undoes the newest Settle (issue #980) while focus is outside a text
 * field. Deliberately NOT a `useHotkeys` entry: `isAppHotkey` would then claim
 * every `Mod+Z` from the browser pane, whose page keeps its own undo (#519).
 * A typing target keeps native undo — the composer, inputs, and xterm's
 * textarea, so a terminal tab still receives Ctrl+Z. With nothing to undo the
 * key passes through untouched.
 */
export function useSettleUndoHotkey(): void {
  const chord = useKeybinding("undoSettle");
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat || e.defaultPrevented || !matchesHotkey(e, chord)) return;
      if (isTypingTarget(e.target)) return;
      if (useStore.getState().undoSettle()) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chord]);
}
