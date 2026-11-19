import { defaultKeymap, history, historyKeymap, isolateHistory } from "@codemirror/commands";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Range,
  type TransactionSpec,
} from "@codemirror/state";
import { BlockWrapper, Decoration, EditorView, keymap, placeholder, WidgetType } from "@codemirror/view";
import { useImperativeHandle, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import { composerBacktickEdit, parseComposerCode, type ComposerCode, type ComposerEdit } from "../lib/composer-code";
import type { ComposerPaintRun } from "../lib/composer-paint";

interface ComposerSnapshot {
  text: string;
  from: number;
  to: number;
  composing: boolean;
}

export interface ComposerEditorHandle {
  focus(options?: FocusOptions): void;
  element(): HTMLElement | null;
  read(): ComposerSnapshot;
  edit(change: ComposerEdit, options?: { noteEdit?: boolean }): void;
}

interface ComposerEditorProps {
  ref?: Ref<ComposerEditorHandle>;
  text: string;
  disabled: boolean;
  placeholder: string;
  compact: boolean;
  literal: boolean;
  runs: ComposerPaintRun[];
  ghostSuffix: string | null;
  /** Inline hint painted after the ghost (issue #1030): ` Tab N more`. */
  ghostHint?: string | null;
  recall?: boolean;
  onEdit(text: string, from: number, to: number, noteEdit?: boolean): void;
  onSelection(from: number, to: number): void;
  onFocusChange(focused: boolean): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onPaste(event: ClipboardEvent<HTMLElement>): void;
  onCodeChange(code: ComposerCode): void;
}

interface SurfaceOptions {
  text: string;
  disabled: boolean;
  literal: boolean;
  runs: ComposerEditorProps["runs"];
  ghostSuffix: string | null;
  ghostHint: string | null;
}

const setOptions = StateEffect.define<SurfaceOptions>();
const setFocused = StateEffect.define<boolean>();
const externalText = Annotation.define<boolean>();
const noteEdited = Annotation.define<boolean>();
const placeholderConfig = new Compartment();
const historyConfig = new Compartment();
const editorHistory = history();

const optionsField = StateField.define<SurfaceOptions>({
  create: () => ({ text: "", disabled: false, literal: false, runs: [], ghostSuffix: null, ghostHint: null }),
  update(options, transaction) {
    return transaction.effects.find(effect => effect.is(setOptions))?.value ?? options;
  },
});

const focusedField = StateField.define({
  create: () => false,
  update(focused, transaction) {
    return transaction.effects.find(effect => effect.is(setFocused))?.value ?? focused;
  },
});

const fenceWrapper = BlockWrapper.create({ tagName: "div", attributes: { class: "composer-editor-code-fence" } });
const literalCode: ComposerCode = { inline: [], fences: [] };

function parseDraft(text: string, literal: boolean) {
  const code = literal ? literalCode : parseComposerCode(text);
  return {
    text,
    literal,
    code,
    // Include the last physical line start, even when it is a zero-length
    // line at EOF. CodeMirror's wrapper builder checks `start <= to`.
    wrappers: BlockWrapper.set(
      code.fences.map(({ openLine, lastLine }) => fenceWrapper.range(openLine.from, lastLine.to)),
      true,
    ),
  };
}

const parsedField = StateField.define({
  create(state) {
    return parseDraft(state.doc.toString(), state.field(optionsField).literal);
  },
  update(parsed, transaction) {
    const literal = transaction.state.field(optionsField).literal;
    if (!transaction.docChanged && literal === parsed.literal) return parsed;
    return parseDraft(transaction.docChanged ? transaction.newDoc.toString() : parsed.text, literal);
  },
  provide: field => EditorView.blockWrappers.from(field, parsed => parsed.wrappers),
});

class GhostSuffix extends WidgetType {
  constructor(readonly suffix: string, readonly hint: string | null) { super(); }

  eq(other: GhostSuffix) { return this.suffix === other.suffix && this.hint === other.hint; }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.contentDOM.ownerDocument;
    const anchor = doc.createElement("span");
    anchor.className = "composer-editor-ghost";
    anchor.setAttribute("aria-hidden", "true");
    if (this.suffix !== "") {
      const text = doc.createElement("span");
      text.className = "composer-editor-ghost-text text-ink-faint";
      text.setAttribute("data-ghost-suffix", "");
      text.textContent = this.suffix;
      anchor.append(text);
    }
    if (this.hint !== null && this.hint !== "") {
      const hint = doc.createElement("span");
      hint.className = "composer-editor-ghost-text text-ink-faint whitespace-pre";
      hint.setAttribute("data-ghost-hint", "");
      hint.textContent = this.hint;
      anchor.append(hint);
    }
    return anchor;
  }
}

const inlineCode = Decoration.mark({ class: "composer-editor-inline-code" });
const shownMark = Decoration.mark({ class: "composer-editor-code-literal" });
const hiddenMark = Decoration.replace({});
const irisMark = Decoration.mark({ class: "text-iris" });

const paintDecorations = EditorView.decorations.compute([parsedField, optionsField, focusedField, "selection"], state => {
  const { text, code } = state.field(parsedField);
  const options = state.field(optionsField);
  const focused = state.field(focusedField) && !options.disabled;
  const selection = state.selection.main;
  const touches = (from: number, to: number) => focused && selection.from <= to && from <= selection.to;
  const ranges: Range<Decoration>[] = [];
  for (const { open, close } of code.inline) {
    if (open.to < close.from) ranges.push(inlineCode.range(open.to, close.from));
    const mark = touches(open.from, close.to) ? shownMark : hiddenMark;
    ranges.push(mark.range(open.from, open.to), mark.range(close.from, close.to));
  }
  for (const { open, close, openLine, lastLine } of code.fences) {
    ranges.push((touches(openLine.from, openLine.to) ? shownMark : hiddenMark).range(open.from, open.to));
    if (close) ranges.push((touches(lastLine.from, lastLine.to) ? shownMark : hiddenMark).range(close.from, close.to));
  }
  // React paint belongs to one exact draft; an editor transaction can be
  // rendered before its controlled value and paint runs come back from React.
  if (text === options.text) {
    let from = 0;
    for (const run of options.runs) {
      const to = from + normalizedText(run.text).length;
      if (to > from && to <= text.length) {
        if (run.color !== undefined) ranges.push(Decoration.mark({ attributes: { style: `color: ${run.color}` } }).range(from, to));
        else if (run.iris) ranges.push(irisMark.range(from, to));
      }
      from = to;
    }
    if (focused && options.ghostSuffix !== null && selection.empty && selection.head === text.length) {
      ranges.push(Decoration.widget({ widget: new GhostSuffix(options.ghostSuffix, options.ghostHint), side: 1 }).range(text.length));
    } else if (focused && options.ghostHint !== null && selection.empty && selection.head === text.length) {
      // Hint-only ghost (issue #1030): the buffer equals a prediction, so
      // there is no suffix to paint — only ` Tab N more` after the caret.
      ranges.push(Decoration.widget({ widget: new GhostSuffix("", options.ghostHint), side: 1 }).range(text.length));
    }
  }
  return Decoration.set(ranges, true);
});

const typedBacktick = EditorView.inputHandler.of((view, from, to, text, insert) => {
  const state = view.state;
  if (text !== "`" || from !== to || state.readOnly || view.compositionStarted ||
      !state.selection.main.empty || state.selection.main.head !== from) return false;
  const draft = state.field(parsedField);
  if (draft.literal || draft.text.slice(from - 2, from) !== "``") return false;
  const proposed = insert();
  if (!proposed.isUserEvent("input.type") || proposed.isUserEvent("input.type.compose")) return false;
  const edit = composerBacktickEdit(draft.text, from, to, draft.code);
  if (!edit) return false;
  const transaction = state.update({ ...editTransaction(state, edit, true, "input.type"), scrollIntoView: true });
  // History otherwise derives the redo caret by mapping the pre-edit cursor
  // through the insertion, which lands after the paired closer.
  view.dispatch([transaction, transaction.state.update({ selection: transaction.state.selection })]);
  return true;
});

const extensions = [
  optionsField,
  focusedField,
  parsedField,
  paintDecorations,
  typedBacktick,
  keymap.of([...defaultKeymap, ...historyKeymap]),
  EditorView.lineWrapping,
  EditorState.readOnly.compute([optionsField], state => state.field(optionsField).disabled),
  EditorView.editable.compute([optionsField], state => !state.field(optionsField).disabled),
  EditorView.contentAttributes.of(view => ({
    "data-composer-input": "",
    "aria-disabled": String(view.state.readOnly),
    spellcheck: "true",
    tabindex: view.state.readOnly ? "-1" : "0",
  })),
];

function normalizedText(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

function editTransaction(state: EditorState, { from, to, insert, caret }: ComposerEdit, noteEdit: boolean, userEvent: string): TransactionSpec {
  const changes = state.changes({ from, to, insert });
  return {
    changes,
    selection: EditorSelection.cursor(Math.max(0, Math.min(caret, changes.newLength))),
    annotations: [isolateHistory.of("full"), noteEdited.of(noteEdit)],
    userEvent,
  };
}

function replacement(before: string, after: string) {
  let from = 0, to = before.length, end = after.length;
  while (from < to && from < end && before[from] === after[from]) from++;
  while (to > from && end > from && before[to - 1] === after[end - 1]) { to--; end--; }
  return { from, to, insert: after.slice(from, end) };
}

function canFocus(view: EditorView): boolean {
  if (view.state.readOnly || !view.contentDOM.isConnected) return false;
  const win = view.contentDOM.ownerDocument.defaultView;
  if (!win) return false;
  // Do not use offsetParent or layout rects: jsdom (and some positioned
  // content in browsers) exposes no geometry for otherwise focusable nodes.
  for (let element: HTMLElement | null = view.contentDOM; element; element = element.parentElement) {
    if (element.hidden || element.hasAttribute("inert")) return false;
    const style = win.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}

// Paste targets the caret's .cm-line, not the content root; keys target the root.
function editableTarget(view: EditorView | null, target: EventTarget): view is EditorView {
  return view !== null && target instanceof Node && view.contentDOM.contains(target) && !view.state.readOnly;
}

export function ComposerEditor(props: ComposerEditorProps) {
  const { ref, text, disabled, literal, placeholder: hint, compact, runs, ghostSuffix, ghostHint, recall } = props;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props);
  const appliedHint = useRef(hint);
  const appliedRecall = useRef(recall);

  useLayoutEffect(() => { latest.current = props; });

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const initial = latest.current;
    const doc = normalizedText(initial.text);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(initial.recall ? doc.length : 0),
        extensions: [
          extensions,
          optionsField.init(() => ({ text: doc, disabled: initial.disabled, literal: initial.literal, runs: initial.runs, ghostSuffix: initial.ghostSuffix, ghostHint: initial.ghostHint ?? null })),
          placeholderConfig.of(placeholder(initial.placeholder)),
          historyConfig.of(editorHistory),
          EditorView.updateListener.of(update => {
            const callbacks = latest.current;
            const { from, to } = update.state.selection.main;
            const parsed = update.state.field(parsedField);
            const edit = update.transactions.find(tr => tr.docChanged && !tr.annotation(externalText));
            if (edit) callbacks.onEdit(parsed.text, from, to, edit.annotation(noteEdited));
            else if (!update.state.selection.eq(update.startState.selection)) callbacks.onSelection(from, to);
            if (parsed.code !== update.startState.field(parsedField).code) callbacks.onCodeChange(parsed.code);
            const focused = update.state.field(focusedField);
            if (focused !== update.startState.field(focusedField)) callbacks.onFocusChange(focused);
          }),
        ],
      }),
    });
    editor.current = view;
    appliedHint.current = initial.placeholder;
    appliedRecall.current = initial.recall;
    initial.onCodeChange(view.state.field(parsedField).code);
    const { from, to } = view.state.selection.main;
    initial.onSelection(from, to);
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, []);

  const restoringFocus = useRef(false);
  useImperativeHandle(ref, () => ({
    focus() {
      const view = editor.current;
      if (!view || view.root.activeElement === view.contentDOM || !canFocus(view)) return;
      // CodeMirror synchronizes the DOM selection during focus(). Don't run a
      // decoration update from React's focus event in the middle of that sync.
      restoringFocus.current = true;
      try {
        view.focus();
      } finally {
        restoringFocus.current = false;
      }
      if (view.root.activeElement === view.contentDOM && !view.state.field(focusedField)) {
        view.dispatch({ effects: setFocused.of(true) });
      }
    },
    element: () => editor.current?.contentDOM ?? null,
    read() {
      const view = editor.current;
      if (!view) return { text: normalizedText(latest.current.text), from: 0, to: 0, composing: false };
      const { from, to } = view.state.selection.main;
      return { text: view.state.field(parsedField).text, from, to, composing: view.compositionStarted };
    },
    edit(change, options) {
      const view = editor.current;
      if (view && !view.state.readOnly) {
        view.dispatch({
          ...editTransaction(view.state, change, options?.noteEdit ?? true, "input.composer"),
          scrollIntoView: view.root.activeElement === view.contentDOM,
        });
      }
    },
  }), []);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    const state = view.state;
    const before = state.field(parsedField).text;
    const next = normalizedText(text);
    const enteringRecall = recall && !appliedRecall.current;
    appliedRecall.current = recall;
    const previous = state.field(optionsField);
    const effects: StateEffect<unknown>[] = [];
    if (next !== previous.text || disabled !== previous.disabled || literal !== previous.literal ||
        runs !== previous.runs || ghostSuffix !== previous.ghostSuffix || (ghostHint ?? null) !== previous.ghostHint) {
      effects.push(setOptions.of({ text: next, disabled, literal, runs, ghostSuffix, ghostHint: ghostHint ?? null }));
    }
    if (hint !== appliedHint.current) {
      effects.push(placeholderConfig.reconfigure(placeholder(hint)));
      appliedHint.current = hint;
    }
    if (before !== next) {
      const main = state.selection.main;
      const changes = state.changes(replacement(before, next));
      const resetHistory = next.length === 0;
      if (resetHistory) effects.push(historyConfig.reconfigure([]));
      const transaction = state.update({
        changes,
        selection: recall ? EditorSelection.cursor(next.length) : main.map(changes),
        effects,
        annotations: [externalText.of(true), Transaction.addToHistory.of(false)],
        scrollIntoView: recall && view.root.activeElement === view.contentDOM,
      });
      // Reinstall a fresh history field without constructing a new view or
      // leaving an intermediate DOM update with history turned off.
      if (resetHistory) view.dispatch([transaction, transaction.state.update({ effects: historyConfig.reconfigure(editorHistory) })]);
      else view.dispatch(transaction);
    } else if (enteringRecall && (!state.selection.main.empty || state.selection.main.head !== next.length)) {
      view.dispatch({
        selection: EditorSelection.cursor(next.length),
        effects,
        scrollIntoView: view.root.activeElement === view.contentDOM,
      });
    } else if (effects.length) {
      view.dispatch({ effects });
    }
    if (disabled && view.root.activeElement === view.contentDOM) view.contentDOM.blur();
  }, [text, disabled, literal, hint, runs, ghostSuffix, ghostHint, recall]);

  useLayoutEffect(() => {
    const element = host.current;
    const win = element?.ownerDocument.defaultView;
    if (!compact || !element || !win) return;
    const viewport = win.visualViewport;
    const resize = () => element.style.setProperty("--composer-editor-viewport-height", `${viewport?.height ?? win.innerHeight}px`);
    const target = viewport ?? win;
    resize();
    target.addEventListener("resize", resize);
    return () => {
      target.removeEventListener("resize", resize);
      element.style.removeProperty("--composer-editor-viewport-height");
    };
  }, [compact]);

  const handleFocus = (target: EventTarget, focused: boolean) => {
    if (restoringFocus.current && focused) return;
    const view = editor.current;
    if (view && target === view.contentDOM && (!focused || !view.state.readOnly) && view.state.field(focusedField) !== focused) {
      view.dispatch({ effects: setFocused.of(focused) });
    }
  };

  return (
    <div
      ref={host}
      className="composer-editor"
      data-compact={compact || undefined}
      onFocus={event => handleFocus(event.target, true)}
      onBlur={event => handleFocus(event.target, false)}
      onKeyDownCapture={event => {
        const view = editor.current;
        if (event.defaultPrevented || !editableTarget(view, event.target) || event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 || view.compositionStarted) return;
        latest.current.onKeyDown(event);
        if (event.defaultPrevented) event.stopPropagation();
      }}
      onPasteCapture={event => {
        if (event.defaultPrevented || !editableTarget(editor.current, event.target)) return;
        latest.current.onPaste(event);
        if (event.defaultPrevented) event.stopPropagation();
      }}
    />
  );
}
