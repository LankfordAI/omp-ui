/**
 * Configurable keybindings (issue #998): the bindable app actions, their
 * default chords, and the rules a user's chord must pass. Pure data and
 * logic, shared by the host (which validates every write) and the renderer
 * (which dispatches and paints the effective chords).
 *
 * A chord is a lowercase `+`-joined string in the fixed order
 * `mod` → `alt` → `shift` → key (`mod+shift+p`, `mod+alt+s`, `f5`, `r`).
 * `mod` is Cmd on macOS and Ctrl elsewhere. Shifted punctuation is written
 * with its unshifted base (`mod+shift+=`, never `mod++`).
 *
 * The registry stores overrides only: an action absent from the map uses its
 * default. Composer-local keys (Enter, Mod+Enter, Mod+Shift+Enter, Escape,
 * the picker keys) and the project quick-open's Mod+1…9 stay fixed.
 */

/**
 * `press` fires on keydown and needs Mod (Ctrl/Cmd) or a function key, so a
 * bare letter never steals typing. `hold` is held down and released — one
 * key with no modifiers, as hold-to-talk needs a clean keyup.
 */
export type KeybindingKind = "press" | "hold";

export interface KeybindingAction {
  id: string;
  defaultChord: string;
  kind: KeybindingKind;
  /** Extra chords that fire only while the action keeps its default. */
  defaultAlternates?: readonly string[];
}

export const KEYBINDING_ACTIONS = [
  { id: "commandPalette", defaultChord: "mod+k", kind: "press" },
  { id: "newSession", defaultChord: "mod+shift+n", kind: "press" },
  { id: "newChat", defaultChord: "mod+shift+o", kind: "press" },
  { id: "newSessionDialog", defaultChord: "mod+o", kind: "press" },
  { id: "togglePlanMode", defaultChord: "mod+shift+p", kind: "press" },
  { id: "toggleConsole", defaultChord: "mod+j", kind: "press" },
  { id: "findInSession", defaultChord: "mod+f", kind: "press" },
  // Ctrl+Shift+= is how many keyboards type "+", so the default also takes it.
  { id: "textLarger", defaultChord: "mod+=", kind: "press", defaultAlternates: ["mod+shift+="] },
  { id: "textSmaller", defaultChord: "mod+-", kind: "press" },
  { id: "textReset", defaultChord: "mod+0", kind: "press" },
  { id: "openSettings", defaultChord: "mod+,", kind: "press" },
  { id: "undoSettle", defaultChord: "mod+z", kind: "press" },
  { id: "stashDraft", defaultChord: "mod+alt+s", kind: "press" },
  { id: "sendInBackground", defaultChord: "mod+alt+enter", kind: "press" },
  { id: "holdToTalk", defaultChord: "r", kind: "hold" },
] as const satisfies readonly KeybindingAction[];

export type KeybindingActionId = (typeof KEYBINDING_ACTIONS)[number]["id"];

/** Action id → chord, for the actions the user rebound. */
export type KeybindingOverrides = Partial<Record<KeybindingActionId, string>>;

const BY_ID = Object.fromEntries(KEYBINDING_ACTIONS.map((a) => [a.id, a])) as Record<
  KeybindingActionId,
  KeybindingAction
>;

export function isKeybindingActionId(value: string): value is KeybindingActionId {
  return Object.hasOwn(BY_ID, value);
}

const MODIFIERS = ["mod", "alt", "shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

const NAMED_KEYS: Record<string, true> = {
  enter: true,
  escape: true,
  tab: true,
  backspace: true,
  delete: true,
  insert: true,
  home: true,
  end: true,
  pageup: true,
  pagedown: true,
  arrowup: true,
  arrowdown: true,
  arrowleft: true,
  arrowright: true,
  " ": true,
};

const FUNCTION_KEY = /^f([1-9]|1\d|2[0-4])$/;
const PRINTABLE_KEY = /^[a-z0-9`\-=[\]\\;',./]$/;
const LETTER_OR_DIGIT = /^[a-z0-9]$/;

/** Whether `key` (a lowercased, unshifted `KeyboardEvent.key`) can end a chord. */
export function isChordKey(key: string): boolean {
  return Object.hasOwn(NAMED_KEYS, key) || FUNCTION_KEY.test(key) || PRINTABLE_KEY.test(key);
}

/**
 * Chords no rebinding may take: the fixed composer and quick-open keys, text
 * editing, and the window's own close/quit. An action may still keep its own
 * default even when it is listed here (undo settle's `mod+z`, send in
 * background's `mod+alt+enter`): every Mod+Enter variant is the composer's.
 */
const RESERVED: Record<string, true> = {
  "mod+enter": true,
  "mod+shift+enter": true,
  "mod+alt+enter": true,
  "mod+alt+shift+enter": true,
  "mod+a": true,
  "mod+c": true,
  "mod+v": true,
  "mod+x": true,
  "mod+z": true,
  "mod+shift+z": true,
  "mod+y": true,
  "mod+q": true,
  "mod+w": true,
  // Electron's default menu on Linux and Windows: reload, force reload,
  // developer tools, full screen.
  "mod+r": true,
  "mod+shift+r": true,
  "mod+shift+i": true,
  f11: true,
  "mod+1": true,
  "mod+2": true,
  "mod+3": true,
  "mod+4": true,
  "mod+5": true,
  "mod+6": true,
  "mod+7": true,
  "mod+8": true,
  "mod+9": true,
};

interface ParsedChord {
  mods: Modifier[];
  key: string;
}

/** Splits a canonical chord; null when it is not one. */
function parseChord(chord: string): ParsedChord | null {
  if (chord.length === 0 || chord.length > 32) return null;
  // The key may itself be " " but never "+": split from the right once.
  const cut = chord.lastIndexOf("+", chord.length - 2);
  const key = cut === -1 ? chord : chord.slice(cut + 1);
  const head = cut === -1 ? [] : chord.slice(0, cut).split("+");
  const mods: Modifier[] = [];
  let order = -1;
  for (const part of head) {
    // Strictly increasing table order: no duplicates, no reordering.
    const at = MODIFIERS.indexOf(part as Modifier);
    if (at <= order) return null;
    order = at;
    mods.push(MODIFIERS[at]!);
  }
  if (!isChordKey(key)) return null;
  return { mods, key };
}

export type ChordProblem = "invalid" | "reserved";

/**
 * Why `chord` cannot be bound to `action`, or null when it can. Conflicts
 * with other actions are a separate check (`keybindingConflicts`).
 */
export function chordProblem(action: KeybindingActionId, chord: string): ChordProblem | null {
  const spec = BY_ID[action];
  if (chord === spec.defaultChord) return null;
  const parsed = parseChord(chord);
  if (parsed === null) return "invalid";
  if (spec.kind === "hold") {
    const ok = parsed.mods.length === 0 && (LETTER_OR_DIGIT.test(parsed.key) || FUNCTION_KEY.test(parsed.key));
    return ok ? null : "invalid";
  }
  if (!parsed.mods.includes("mod") && !FUNCTION_KEY.test(parsed.key)) return "invalid";
  return Object.hasOwn(RESERVED, chord) ? "reserved" : null;
}

export function defaultChord(action: KeybindingActionId): string {
  return BY_ID[action].defaultChord;
}

/** The chord `action` answers to under `overrides`. */
export function effectiveChord(overrides: KeybindingOverrides, action: KeybindingActionId): string {
  return overrides[action] ?? defaultChord(action);
}

/** Every chord `action` fires on: its effective chord plus default alternates while unchanged. */
export function actionChords(overrides: KeybindingOverrides, action: KeybindingActionId): string[] {
  const spec = BY_ID[action];
  const chord = effectiveChord(overrides, action);
  return chord === spec.defaultChord ? [chord, ...(spec.defaultAlternates ?? [])] : [chord];
}

/** Every action's effective chord. */
export function effectiveKeybindings(overrides: KeybindingOverrides): Record<KeybindingActionId, string> {
  return Object.fromEntries(
    KEYBINDING_ACTIONS.map((a) => [a.id, effectiveChord(overrides, a.id)]),
  ) as Record<KeybindingActionId, string>;
}

export interface KeybindingConflict {
  chord: string;
  /** Two or more actions, in table order. */
  actions: KeybindingActionId[];
}

/** Chords two or more actions answer to under `overrides`. */
export function keybindingConflicts(overrides: KeybindingOverrides): KeybindingConflict[] {
  const owners = new Map<string, KeybindingActionId[]>();
  for (const { id } of KEYBINDING_ACTIONS) {
    for (const chord of actionChords(overrides, id)) {
      const list = owners.get(chord) ?? [];
      if (!list.includes(id)) list.push(id);
      owners.set(chord, list);
    }
  }
  return [...owners]
    .filter(([, actions]) => actions.length > 1)
    .map(([chord, actions]) => ({ chord, actions }));
}

/** Overrides minus entries equal to their default, in table order. */
export function normalizeKeybindingOverrides(overrides: KeybindingOverrides): KeybindingOverrides {
  const out: KeybindingOverrides = {};
  for (const { id, defaultChord: fallback } of KEYBINDING_ACTIONS) {
    const chord = overrides[id];
    if (chord !== undefined && chord !== fallback) out[id] = chord;
  }
  return out;
}

/**
 * The host's gate on a write: unknown actions, invalid or reserved chords,
 * and conflicts are refused with a reason; null means the map can be stored.
 */
export function keybindingOverridesError(overrides: Record<string, string>): string | null {
  for (const [id, chord] of Object.entries(overrides)) {
    if (!isKeybindingActionId(id)) return `unknown keybinding action: ${id}`;
    const problem = chordProblem(id, chord);
    if (problem !== null) return `${id}: ${chord} is ${problem === "reserved" ? "reserved" : "not a valid chord"}`;
  }
  const conflict = keybindingConflicts(overrides as KeybindingOverrides)[0];
  if (conflict !== undefined) return `${conflict.chord} is bound to ${conflict.actions.join(" and ")}`;
  return null;
}

/**
 * Reads persisted overrides from untrusted storage: unknown actions and
 * invalid chords drop, and overrides caught in a conflict fall back to their
 * defaults until none is left — so dispatch never sees one chord twice.
 */
export function parseKeybindingOverrides(value: unknown): KeybindingOverrides {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  let out: KeybindingOverrides = {};
  for (const [id, chord] of Object.entries(value as Record<string, unknown>)) {
    if (typeof chord !== "string" || !isKeybindingActionId(id)) continue;
    if (chordProblem(id, chord) === null) out[id] = chord;
  }
  out = normalizeKeybindingOverrides(out);
  for (;;) {
    const clashing = new Set(keybindingConflicts(out).flatMap((c) => c.actions));
    const drop = [...clashing].filter((id) => out[id] !== undefined);
    if (drop.length === 0) return out;
    for (const id of drop) delete out[id];
  }
}
