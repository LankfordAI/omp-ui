import {
  actionChords,
  effectiveChord,
  type KeybindingActionId,
  type KeybindingOverrides,
} from "@omp-ui/core/keybindings";
import { useStore, type UiStore } from "../store";
import { formatHotkey, useHotkeys, type HotkeyMap } from "./hotkeys";

/**
 * The renderer side of configurable keybindings (issue #998). The registry's
 * `keybindings` overrides arrive with every state broadcast; every app action
 * reads its chord through here, so a rebind reaches dispatch, menu hints, and
 * palette chips in the same render.
 */

const NO_OVERRIDES: KeybindingOverrides = {};

/** The store selector: one function identity so zustand compares results, not closures. */
function overridesOf(s: UiStore): KeybindingOverrides {
  return s.state?.keybindings ?? NO_OVERRIDES;
}

/** The user's overrides; stable while unchanged. */
export function useKeybindingOverrides(): KeybindingOverrides {
  return useStore(overridesOf);
}

/** The chord `action` answers to now. */
export function useKeybinding(action: KeybindingActionId): string {
  return useStore((s) => effectiveChord(overridesOf(s), action));
}

/** The chord `action` answers to now, painted for this platform (`⌘K`, `Ctrl+K`). */
export function useKeybindingLabel(action: KeybindingActionId): string {
  return formatHotkey(useKeybinding(action));
}

/** `useHotkeys` keyed by action: each handler fires on its action's effective chords. */
export function useActionHotkeys(handlers: Partial<Record<KeybindingActionId, (e: KeyboardEvent) => void>>): void {
  const overrides = useKeybindingOverrides();
  const map: HotkeyMap = {};
  for (const [action, handler] of Object.entries(handlers) as [KeybindingActionId, (e: KeyboardEvent) => void][]) {
    for (const chord of actionChords(overrides, action)) map[chord] = handler;
  }
  useHotkeys(map);
}
