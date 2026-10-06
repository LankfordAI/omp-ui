type EditKind = "equal" | "delete" | "insert";

interface Edit {
  kind: EditKind;
  before: number;
  after: number;
  count: number;
}

interface Range {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  equal?: boolean;
}

interface Frontier {
  forward: Int32Array;
  reverse: Int32Array;
}

function lines(text: string): string[] {
  if (text === "") return [];
  const result = text.split("\n");
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].endsWith("\r")) result[i] = result[i].slice(0, -1);
  }
  if (result[result.length - 1] === "") result.pop();
  return result;
}

/** Find the crossing of the forward and reverse Myers frontiers. */
function bisect(
  a: string[],
  b: string[],
  range: Range,
  frontier: Frontier,
): { before: number; after: number } | null {
  const { aStart, aEnd, bStart, bEnd } = range;
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD + 1;
  const size = 2 * maxD + 3;
  const { forward, reverse } = frontier;
  forward.fill(-1, 0, size);
  reverse.fill(-1, 0, size);
  forward[offset + 1] = 0;
  reverse[offset + 1] = 0;
  const delta = n - m;
  const odd = delta % 2 !== 0;
  let forwardStart = 0;
  let forwardEnd = 0;
  let reverseStart = 0;
  let reverseEnd = 0;

  for (let d = 0; d <= maxD; d++) {
    for (let k = -d + forwardStart; k <= d - forwardEnd; k += 2) {
      const slot = offset + k;
      let x = k === -d || (k !== d && forward[slot - 1] < forward[slot + 1])
        ? forward[slot + 1]
        : forward[slot - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x++;
        y++;
      }
      forward[slot] = x;
      if (x > n) {
        forwardEnd += 2;
      } else if (y > m) {
        forwardStart += 2;
      } else if (odd) {
        const other = offset + delta - k;
        if (other >= 0 && other < size && reverse[other] !== -1 && x >= n - reverse[other]) {
          return { before: aStart + x, after: bStart + y };
        }
      }
    }

    for (let k = -d + reverseStart; k <= d - reverseEnd; k += 2) {
      const slot = offset + k;
      let x = k === -d || (k !== d && reverse[slot - 1] < reverse[slot + 1])
        ? reverse[slot + 1]
        : reverse[slot - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aEnd - x - 1] === b[bEnd - y - 1]) {
        x++;
        y++;
      }
      reverse[slot] = x;
      if (x > n) {
        reverseEnd += 2;
      } else if (y > m) {
        reverseStart += 2;
      } else if (!odd) {
        const other = offset + delta - k;
        if (other >= 0 && other < size && forward[other] !== -1 && forward[other] >= n - x) {
          const before = forward[other];
          return { before: aStart + before, after: bStart + before - (delta - k) };
        }
      }
    }
  }
  return null;
}

function edits(a: string[], b: string[]): Edit[] {
  const result: Edit[] = [];
  const pending: Range[] = [{ aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length }];
  let frontier: Frontier | undefined;
  let checkShared = true;
  while (pending.length > 0) {
    const range = pending.pop()!;
    let { aStart, aEnd, bStart, bEnd } = range;
    if (range.equal) {
      result.push({ kind: "equal", before: aStart, after: bStart, count: aEnd - aStart });
      continue;
    }

    const prefix = aStart;
    const afterPrefix = bStart;
    while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
      aStart++;
      bStart++;
    }
    if (aStart > prefix) {
      result.push({ kind: "equal", before: prefix, after: afterPrefix, count: aStart - prefix });
    }
    const suffix = aEnd;
    const afterSuffix = bEnd;
    while (aStart < aEnd && bStart < bEnd && a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--;
      bEnd--;
    }
    if (aEnd < suffix) {
      pending.push({ aStart: aEnd, aEnd: suffix, bStart: bEnd, bEnd: afterSuffix, equal: true });
    }
    if (aStart === aEnd) {
      if (bStart < bEnd) result.push({ kind: "insert", before: aStart, after: bStart, count: bEnd - bStart });
      continue;
    }
    if (bStart === bEnd) {
      result.push({ kind: "delete", before: aStart, after: bStart, count: aEnd - aStart });
      continue;
    }

    // A wholesale replacement needs no frontier search. In particular, it must
    // not take quadratic time or store a quadratic history for unrelated files.
    if (checkShared) {
      checkShared = false;
      const shorter = aEnd - aStart <= bEnd - bStart ? a : b;
      const shorterStart = shorter === a ? aStart : bStart;
      const shorterEnd = shorter === a ? aEnd : bEnd;
      const longer = shorter === a ? b : a;
      const longerStart = shorter === a ? bStart : aStart;
      const longerEnd = shorter === a ? bEnd : aEnd;
      const shared = new Set<string>();
      for (let i = shorterStart; i < shorterEnd; i++) shared.add(shorter[i]);
      let found = false;
      for (let i = longerStart; i < longerEnd && !found; i++) found = shared.has(longer[i]);
      if (!found) {
        result.push({ kind: "delete", before: aStart, after: bStart, count: aEnd - aStart });
        result.push({ kind: "insert", before: aEnd, after: bStart, count: bEnd - bStart });
        continue;
      }
    }

    if (frontier === undefined) {
      const size = 2 * Math.ceil((aEnd - aStart + bEnd - bStart) / 2) + 3;
      frontier = { forward: new Int32Array(size), reverse: new Int32Array(size) };
    }
    const split = bisect(a, b, { aStart, aEnd, bStart, bEnd }, frontier);
    if (split === null || (split.before === aStart && split.after === bStart)
      || (split.before === aEnd && split.after === bEnd)) {
      result.push({ kind: "delete", before: aStart, after: bStart, count: aEnd - aStart });
      result.push({ kind: "insert", before: aEnd, after: bStart, count: bEnd - bStart });
    } else {
      pending.push({ aStart: split.before, aEnd, bStart: split.after, bEnd });
      pending.push({ aStart, aEnd: split.before, bStart, bEnd: split.after });
    }
  }

  // A Myers path can insert before deleting. Display each replacement with
  // deletions first, without changing either side's original line numbers.
  const ordered: Edit[] = [];
  for (let i = 0; i < result.length;) {
    if (result[i].kind === "equal") {
      ordered.push(result[i++]);
      continue;
    }
    const start = i;
    while (i < result.length && result[i].kind !== "equal") i++;
    for (let j = start; j < i; j++) if (result[j].kind === "delete") ordered.push(result[j]);
    for (let j = start; j < i; j++) if (result[j].kind === "insert") ordered.push(result[j]);
  }
  return ordered;
}

/** Numbered, header-free line diff consumed by the existing omp diff renderer. */
export function lineDiff(before: string, after: string, context = 3): string {
  if (before === after) return "";
  const a = lines(before);
  const b = lines(after);
  const changes = edits(a, b);
  const padding = Number.isFinite(context) ? Math.max(0, Math.floor(context)) : 3;
  let total = 0;
  for (const edit of changes) total += edit.count;
  const hunks: { start: number; end: number }[] = [];
  let row = 0;
  for (let i = 0; i < changes.length;) {
    if (changes[i].kind === "equal") {
      row += changes[i++].count;
      continue;
    }
    const start = Math.max(0, row - padding);
    while (i < changes.length && changes[i].kind !== "equal") row += changes[i++].count;
    const end = Math.min(total, row + padding);
    const previous = hunks[hunks.length - 1];
    if (previous !== undefined && start <= previous.end) previous.end = end;
    else hunks.push({ start, end });
  }
  if (hunks.length === 0) return "";

  const output: string[] = [];
  let editIndex = 0;
  let editRow = 0;
  for (const hunk of hunks) {
    if (output.length > 0) output.push("@@");
    while (editIndex < changes.length && editRow + changes[editIndex].count <= hunk.start) {
      editRow += changes[editIndex++].count;
    }
    let index = editIndex;
    let position = editRow;
    while (index < changes.length && position < hunk.end) {
      const edit = changes[index];
      const start = Math.max(0, hunk.start - position);
      const end = Math.min(edit.count, hunk.end - position);
      const deleted = edit.kind === "delete";
      const source = deleted ? a : b;
      const lineStart = deleted ? edit.before : edit.after;
      const marker = deleted ? "-" : edit.kind === "insert" ? "+" : " ";
      for (let i = start; i < end; i++) output.push(`${marker}${lineStart + i + 1}|${source[lineStart + i]}`);
      position += edit.count;
      index++;
    }
  }
  return output.join("\n");
}
