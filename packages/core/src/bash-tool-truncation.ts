/** Renderer-safe facts from a bash tool result's details.meta, not the bash RPC response. */
export interface BashToolTruncation {
  truncation?: {
    /** Head and tail name the kept window; middle keeps both ends. */
    direction: "head" | "tail" | "middle";
    truncatedBy: "bytes" | "lines" | "middle";
    elidedBytes?: number;
    elidedLines?: number;
    /** Source line numbers, 1-indexed and inclusive. */
    headRange?: { start: number; end: number };
    tailRange?: { start: number; end: number };
  };
  columnTruncated?: {
    maxColumn: number;
    /** Older metadata omits the unit. Do not infer bytes or characters. */
    unit?: "bytes" | "chars";
    /** First-to-last cut source lines, not a count of cut lines. */
    lines?: { first: number; last: number };
    rawByteCap?: number;
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function shownRange(value: unknown): { start: number; end: number } | undefined {
  const range = record(value);
  const start = count(range?.start);
  const end = count(range?.end);
  return start !== undefined && start > 0 && end !== undefined && end >= start
    ? { start, end }
    : undefined;
}

function cutRange(value: unknown): { first: number; last: number } | undefined {
  const range = record(value);
  const first = count(range?.first);
  const last = count(range?.last);
  return first !== undefined && first > 0 && last !== undefined && last >= first
    ? { first, last }
    : undefined;
}

function parseTruncation(value: unknown): BashToolTruncation["truncation"] {
  const source = record(value);
  if (!source) return undefined;
  const { direction, truncatedBy } = source;
  if (direction !== "head" && direction !== "tail" && direction !== "middle") return undefined;
  if (truncatedBy !== "bytes" && truncatedBy !== "lines" && truncatedBy !== "middle") return undefined;

  const parsed: NonNullable<BashToolTruncation["truncation"]> = { direction, truncatedBy };
  const elidedBytes = count(source.elidedBytes);
  const elidedLines = count(source.elidedLines);
  const headRange = shownRange(source.headRange);
  const tailRange = shownRange(source.tailRange);
  if (elidedBytes !== undefined) parsed.elidedBytes = elidedBytes;
  if (elidedLines !== undefined) parsed.elidedLines = elidedLines;
  if (headRange !== undefined) parsed.headRange = headRange;
  if (tailRange !== undefined) parsed.tailRange = tailRange;
  return parsed;
}

function parseColumnTruncated(value: unknown): BashToolTruncation["columnTruncated"] {
  const source = record(value);
  const maxColumn = count(source?.maxColumn);
  if (!source || maxColumn === undefined || maxColumn === 0) return undefined;

  const parsed: NonNullable<BashToolTruncation["columnTruncated"]> = { maxColumn };
  const lines = cutRange(source.lines);
  const rawByteCap = count(source.rawByteCap);
  if (source.unit === "bytes" || source.unit === "chars") parsed.unit = source.unit;
  if (lines !== undefined) parsed.lines = lines;
  if (rawByteCap !== undefined && rawByteCap > 0) parsed.rawByteCap = rawByteCap;
  return parsed;
}

/**
 * Read omp's tool-result meta.truncation and meta.limits.columnTruncated.
 * Each key needs its required fields; malformed optional facts are omitted
 * independently. Missing metadata needs no version gate. Unknown keys and
 * artifact references are dropped, and no counts are derived from ranges.
 * This parser leaves the result text, including recovery notices, untouched.
 */
export function parseBashToolTruncation(details: unknown): BashToolTruncation | undefined {
  const meta = record(record(details)?.meta);
  if (!meta) return undefined;
  const truncation = parseTruncation(meta.truncation);
  const columnTruncated = parseColumnTruncated(record(meta.limits)?.columnTruncated);
  if (!truncation && !columnTruncated) return undefined;
  const parsed: BashToolTruncation = {};
  if (truncation) parsed.truncation = truncation;
  if (columnTruncated) parsed.columnTruncated = columnTruncated;
  return parsed;
}
