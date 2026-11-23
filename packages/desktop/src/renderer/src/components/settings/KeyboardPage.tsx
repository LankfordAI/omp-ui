import { useState, type KeyboardEvent } from "react";
import {
  chordProblem,
  effectiveChord,
  KEYBINDING_ACTIONS,
  keybindingConflicts,
  normalizeKeybindingOverrides,
  type KeybindingActionId,
  type KeybindingOverrides,
} from "@omp-ui/core/keybindings";
import { displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { chordFromEvent, formatHotkey } from "../../lib/hotkeys";
import { useKeybindingOverrides } from "../../lib/keybindings";
import { useStore } from "../../store";
import { Button } from "../ui";

/** Row label per bindable action, in the core table's order. */
const ACTION_LABEL: Record<KeybindingActionId, string> = {
  commandPalette: "Open the command palette",
  newSession: "New session (project quick-open)",
  newChat: "New chat",
  newSessionDialog: "New session dialog",
  togglePlanMode: "Switch Build / Plan",
  toggleConsole: "Show or hide the console",
  findInSession: "Find in session",
  modelPicker: "Open the model picker",
  textLarger: "Larger transcript text",
  textSmaller: "Smaller transcript text",
  textReset: "Reset transcript text size",
  openSettings: "Open Settings",
  undoSettle: "Undo settle",
  stashDraft: "Stash draft / open stashed drafts",
  sendInBackground: "Start in background",
  holdToTalk: "Hold to talk (dictation and live voice)",
};

/** A refused recording, shown under its row until the next attempt. */
interface Refusal {
  action: KeybindingActionId;
  message: string;
}

/**
 * Settings → Keyboard (issue #998): every bindable app action with its chord.
 * Clicking a row records the next chord into a draft; conflicting rows are
 * marked and Save stays disabled until none is left. Save writes the whole
 * draft at once, and the host refuses any map that still conflicts.
 */
export function KeyboardPage() {
  const stored = useKeybindingOverrides();
  const setKeybindings = useStore((s) => s.setKeybindings);
  // null: no local edits, so the page follows the stored map (another window may change it).
  const [draft, setDraft] = useState<KeybindingOverrides | null>(null);
  const [recording, setRecording] = useState<KeybindingActionId | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const shown = draft ?? stored;
  // Both maps are normalized in table order, so equal maps serialize equally.
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);
  const conflicts = keybindingConflicts(shown);
  const conflictWith = (action: KeybindingActionId): KeybindingActionId[] =>
    conflicts.filter((c) => c.actions.includes(action)).flatMap((c) => c.actions.filter((a) => a !== action));

  const edit = (next: KeybindingOverrides): void => {
    setDraft(normalizeKeybindingOverrides(next));
    setSaveError(null);
  };

  const onRecorderKey = (action: KeybindingActionId, e: KeyboardEvent<HTMLButtonElement>): void => {
    // Every key belongs to the recorder: nothing may reach the app's shortcuts.
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      setRecording(null);
      return;
    }
    const chord = chordFromEvent(e.nativeEvent);
    if (chord === null) return;
    const problem = chordProblem(action, chord);
    if (problem !== null) {
      const kind = KEYBINDING_ACTIONS.find((a) => a.id === action)?.kind;
      setRefusal({
        action,
        message:
          problem === "reserved"
            ? `${formatHotkey(chord)} is reserved for text editing, the composer, or the window`
            : kind === "hold"
              ? `${formatHotkey(chord)} cannot be used: hold to talk takes one letter, digit, or function key with no modifiers`
              : `${formatHotkey(chord)} cannot be used: include ${formatHotkey("mod")} or use a function key`,
      });
      return;
    }
    setRefusal(null);
    setRecording(null);
    edit({ ...shown, [action]: chord });
  };

  const save = (): void => {
    if (draft === null) return;
    setSaving(true);
    setKeybindings(draft).then(
      () => {
        setDraft(null);
        setSaveError(null);
      },
      (err: unknown) => setSaveError(displayMessage(err)),
    ).finally(() => setSaving(false));
  };

  return (
    <div className="px-4 py-3">
      <p className="text-sm leading-relaxed text-ink-faint">Click a shortcut, then press the new chord. Press shortcuts need Ctrl (⌘ on macOS) or a function key; hold to talk takes one key with no modifiers. Escape cancels recording. Changes apply when you save.</p>

      <ul className="mt-2 divide-y divide-line-soft">
        {KEYBINDING_ACTIONS.map(({ id, kind }) => {
          const chord = effectiveChord(shown, id);
          const isDefault = chord === effectiveChord({}, id);
          const others = conflictWith(id);
          const label = ACTION_LABEL[id];
          const live = recording === id;
          return (
            <li key={id} className="py-2" data-keybinding-row={id}>
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-sm text-ink">{label}</span>
                <button
                  type="button"
                  data-key-recorder={live ? "" : undefined}
                  aria-label={`${label}: ${formatHotkey(chord)}. Press to record a new shortcut`}
                  aria-pressed={live}
                  onClick={() => {
                    setRefusal(null);
                    setRecording(live ? null : id);
                  }}
                  onKeyDown={live ? (e) => onRecorderKey(id, e) : undefined}
                  onBlur={() => {
                    if (live) setRecording(null);
                  }}
                  className={cn(
                    "min-w-24 rounded-md border px-2 py-1 text-center font-mono text-xs transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:border-line-strong",
                    live
                      ? "border-copper text-copper"
                      : others.length > 0
                        ? "border-rose text-rose"
                        : "border-line bg-raised text-ink-mid hover:border-line-strong hover:text-ink",
                  )}
                >
                  {live
                    ? kind === "hold"
                      ? "press a key…"
                      : "press a chord…"
                    : formatHotkey(chord)}
                </button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={isDefault}
                  aria-label={`Reset ${label} to its default`}
                  onClick={() => {
                    const { [id]: _dropped, ...rest } = shown;
                    setRefusal(null);
                    edit(rest);
                  }}
                >
                  reset
                </Button>
              </div>
              {others.length > 0 && (
                <p className="mt-1 text-xs text-rose">
                  {`Also bound to ${others.map((a) => ACTION_LABEL[a]).join(", ")}`}
                </p>
              )}
              {refusal?.action === id && (
                <p role="alert" className="mt-1 text-xs text-rose">
                  {refusal.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-sm leading-relaxed text-ink-faint">
        {`Composer keys stay fixed: Enter, Shift+Enter, ${formatHotkey("mod+enter")}, ${formatHotkey("mod+shift+enter")}, Escape, and the picker keys, as do ${`${formatHotkey("mod+1")}…${formatHotkey("mod+9")}`} in the project quick-open.`}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
        <Button
          size="xs"
          variant="ghost"
          disabled={Object.keys(shown).length === 0}
          onClick={() => {
            setRefusal(null);
            edit({});
          }}
        >
          Reset all
        </Button>
        <span className="flex-1" />
        {conflicts.length > 0 && <span className="text-xs text-rose">Resolve conflicts to save</span>}
        {dirty && conflicts.length === 0 && <span className="text-xs text-ink-faint">Unsaved changes</span>}
        <Button
          size="xs"
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(null);
            setRefusal(null);
            setSaveError(null);
          }}
        >
          Discard
        </Button>
        <Button size="xs" variant="solid" disabled={!dirty || saving || conflicts.length > 0} onClick={save}>
          Save
        </Button>
      </div>
      {saveError !== null && (
        <p role="alert" className="mt-2 text-xs text-rose">
          {saveError}
        </p>
      )}
    </div>
  );
}
