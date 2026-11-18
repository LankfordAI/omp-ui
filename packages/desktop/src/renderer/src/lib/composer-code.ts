import { parser } from "@lezer/markdown";

interface Range {
  readonly from: number;
  readonly to: number;
}

interface InlineCode {
  readonly open: Range;
  readonly close: Range;
}

export interface ComposerFence {
  readonly open: Range;
  readonly close: Range | null;
  readonly openLine: Range;
  readonly lastLine: Range;
}

export interface ComposerCode {
  readonly inline: readonly InlineCode[];
  readonly fences: readonly ComposerFence[];
}

export interface ComposerEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly caret: number;
}

const literalCode: ComposerCode = { inline: [], fences: [] };

function physicalLine(text: string, pos: number): Range {
  const from = pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
  const newline = text.indexOf("\n", pos);
  const end = newline < 0 ? text.length : newline;
  return { from, to: newline >= 0 && text[end - 1] === "\r" ? end - 1 : end };
}

function afterLine(text: string, line: Range): number {
  const newline = text.indexOf("\n", line.to);
  return newline < 0 ? text.length : newline + 1;
}

export function parseComposerCode(text: string, literal = false): ComposerCode {
  if (literal) return literalCode;
  const inline: InlineCode[] = [];
  const fences: ComposerFence[] = [];
  parser.parse(text).iterate({
    enter(ref) {
      if (ref.name !== "InlineCode" && ref.name !== "FencedCode") return;
      const node = ref.node;
      const open = node.getChild("CodeMark");
      if (!open) return false;
      const last = node.lastChild;
      const close = last?.name === "CodeMark" && last.from > open.from ? last : null;
      const opening = { from: open.from, to: open.to };
      const closing = close && { from: close.from, to: close.to };
      const openLine = physicalLine(text, open.from);
      if (ref.name === "InlineCode") {
        if (closing && closing.to <= openLine.to) inline.push({ open: opening, close: closing });
      } else if (node.parent?.name === "Document") {
        fences.push({
          open: opening,
          close: closing,
          openLine,
          lastLine: closing ? physicalLine(text, closing.from) : physicalLine(text, text.length),
        });
      }
      return false;
    },
  });
  return { inline, fences };
}

/** Fence membership includes the caret at the end of a physical line. */
export function composerFenceAt(code: ComposerCode, pos: number): ComposerFence | null {
  return code.fences.find((fence) => fence.openLine.from <= pos && pos <= fence.lastLine.to) ?? null;
}

export function composerCodeAt(code: ComposerCode, pos: number): boolean {
  return composerFenceAt(code, pos) !== null ||
    code.inline.some(({ open, close }) => open.from <= pos && pos < close.to);
}

/** Compute a structural edit for typing a single backtick at a collapsed caret. */
export function composerBacktickEdit(text: string, from: number, to: number, code: ComposerCode): ComposerEdit | null {
  if (code === literalCode || from !== to || from < 2 || from > text.length) return null;
  const line = physicalLine(text, from);
  if (line.from !== from - 2 || line.to !== from || text.slice(line.from, from) !== "``") return null;

  const newline = text.startsWith("\r\n", from) ? "\r\n" : "\n";
  const fence = composerFenceAt(code, from);
  const next = afterLine(text, line);
  if (!fence) {
    const prospective = text.slice(0, from) + "`" + text.slice(from);
    const opener = composerFenceAt(parseComposerCode(prospective), from);
    if (opener?.open.from !== line.from || opener.open.to !== from + 1) return null;
    return { from, to, insert: "`" + newline + newline + "```", caret: from + 1 + newline.length };
  }

  if (line.from <= fence.openLine.from || (fence.close && line.from >= fence.lastLine.from)) return null;
  if (fence.close) {
    const closer = fence.lastLine;
    if (next !== closer.from || text.slice(closer.from, closer.to) !== "```") return null;
    const exit = afterLine(text, closer);
    if (exit === closer.to) {
      // At EOF, replace both lines in one edit to add the missing exit newline.
      return { from: line.from, to: exit, insert: "```" + newline, caret: line.from + 3 + newline.length };
    }
    return { from: line.from, to: closer.from, insert: "", caret: exit - (closer.from - line.from) };
  }

  if (text.slice(fence.open.from, fence.open.to) !== "```") return null;
  return from === text.length
    ? { from, to, insert: "`" + newline, caret: from + 1 + newline.length }
    : { from, to, insert: "`", caret: next + 1 };
}
