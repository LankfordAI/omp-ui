// Shared ComposerEditor drivers for component tests (issue #1222). The composer's
// draft box is a CodeMirror surface (components/ComposerEditor.tsx), not a
// textarea: every test that finds the session composer or types into its draft
// goes through these helpers — no test file may reach for a `textarea` selector
// or the HTMLTextAreaElement value setter for the composer. Build one harness
// per file over that file's TAB constant so call sites keep the bare-helper
// shape Composer.test.tsx introduced; nothing here adds React act() surprises:
// typeDraft/selectDraft wrap act exactly like the original local helpers.
import { act } from "react";
import { EditorView } from "@codemirror/view";

export interface ComposerEditorHarness {
  /** The composer's draft surface, or null when no composer is mounted. */
  findComposer(): HTMLElement | null;
  /** The composer input, failing loudly when it is absent. */
  composerInput(): HTMLElement;
  /** The CodeMirror view behind a composer input element. */
  editor(input?: HTMLElement): EditorView;
  /** The draft text the editor currently holds. */
  draftText(input?: HTMLElement): string;
  /** Move the caret (anchor) inside the draft. */
  selectDraft(input: HTMLElement, anchor: number): void;
  /** Replace the whole draft the way typing does, caret at the end. */
  typeDraft(value: string): HTMLElement;
}

export function composerEditorHarness(tabId: string): ComposerEditorHarness {
  const findComposer = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"] [data-composer-input]`);
  const composerInput = (): HTMLElement => findComposer()!;
  const editor = (input = composerInput()): EditorView =>
    EditorView.findFromDOM(input.closest<HTMLElement>(".cm-editor")!)!;
  return {
    findComposer,
    composerInput,
    editor,
    draftText: (input = composerInput()) => editor(input).state.doc.toString(),
    selectDraft(input, anchor) {
      act(() => editor(input).dispatch({ selection: { anchor } }));
    },
    typeDraft(value) {
      const input = composerInput();
      const view = editor(input);
      act(() =>
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: value },
          selection: { anchor: value.length },
          userEvent: "input.type",
        }),
      );
      return input;
    },
  };
}
