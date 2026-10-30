import { useEffect } from "react";
import { useStore } from "../store";
import { isTypingTarget } from "./hotkeys";

/**
 * `Mod+Z` undoes the newest Settle (issue #980) while focus is outside a text
 * field. Deliberately NOT a `useHotkeys` entry: `isAppHotkey` would then claim
 * every `Mod+Z` from the browser pane, whose page keeps its own undo (#519).
 * A typing target keeps native undo — the composer, inputs, and xterm's
 * textarea, so a terminal tab still receives Ctrl+Z. With nothing to undo the
 * key passes through untouched.
 */
export function useSettleUndoHotkey(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing || e.repeat || e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "z" || isTypingTarget(e.target)) return;
      if (useStore.getState().undoSettle()) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
