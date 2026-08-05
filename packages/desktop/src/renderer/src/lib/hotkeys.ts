import { useEffect, useRef } from "react";
import { IS_MAC } from "./platform";

/**
 * Window-level keyboard shortcuts.
 *
 * A combo is a lowercase `+`-joined string in the fixed order
 * `mod` → `alt` → `shift` → key: `mod+k`, `mod+shift+p`, `mod+1`,
 * `alt+arrowleft`. `mod` collapses Cmd and Ctrl so one map serves every
 * platform.
 */
export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

/**
 * Shifted punctuation reports the *shifted* glyph in `e.key` (`mod+shift+]`
 * arrives as `}`), so every combo is also probed with the unshifted base
 * character. Callers get to write the key they can actually see on the cap.
 */
const UNSHIFT: Record<string, string> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

const GLYPH: Record<string, string> = {
  mod: IS_MAC ? "⌘" : "Ctrl",
  shift: IS_MAC ? "⇧" : "Shift",
  alt: IS_MAC ? "⌥" : "Alt",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "↵",
  escape: "Esc",
  backspace: "⌫",
  " ": "Space",
};

/** `mod+k` → `⌘K` on darwin, `Ctrl+K` elsewhere. */
export function formatHotkey(key: string): string {
  const parts = key
    .split("+")
    .map((part) => GLYPH[part] ?? (part.length === 1 ? part.toUpperCase() : part));
  return IS_MAC ? parts.join("") : parts.join("+");
}

function comboCandidates(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.metaKey || e.ctrlKey) mods.push("mod");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  const key = e.key.toLowerCase();
  const combos = [[...mods, key].join("+")];
  const base = UNSHIFT[key];
  if (base !== undefined) combos.push([...mods, base].join("+"));
  return combos;
}

/** Bare letters belong to whatever the user is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function useHotkeys(map: HotkeyMap): void {
  // Latest-ref so call sites can pass a fresh object literal every render.
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing) return;
      for (const combo of comboCandidates(e)) {
        const handler = mapRef.current[combo];
        if (!handler) continue;
        if (!combo.startsWith("mod") && isTypingTarget(e.target)) return;
        handler(e);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
