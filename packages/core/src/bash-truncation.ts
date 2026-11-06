/** Renderer-safe provenance from omp's bash RPC response or recorded bashExecution metadata. */
export interface BashTruncation {
  elidedBytes?: number;
  elidedLines?: number;
  columnDroppedBytes?: number;
  columnTruncatedLines?: number;
  /** Artifact line numbers, not positions in the inline head/tail preview. */
  columnTruncatedRange?: { first: number; last: number };
  /** Per-line limit in UTF-8 bytes. */
  columnMax?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function lineRange(value: unknown): BashTruncation["columnTruncatedRange"] {
  const range = record(value);
  const first = count(range?.first);
  const last = count(range?.last);
  return first !== undefined && first > 0 && last !== undefined && last >= first
    ? { first, last }
    : undefined;
}

/**
 * omp 18.17's BashResult carries six optional OutputSummary fields directly.
 * Recorded bashExecution messages instead keep elision in meta.truncation and
 * the column limit/range in meta.limits.columnTruncated. That persisted shape
 * omits columnDroppedBytes and columnTruncatedLines, so never infer those counts
 * from a range. Older runtimes and malformed fields need no version gate.
 * Each valid field survives independently; unknown and invalid fields are
 * ignored. Zero-only counters do not report a cut. Artifact references never
 * enter the renderer's provenance fact.
 */
export function parseBashTruncation(value: unknown): BashTruncation | undefined {
  const source = record(value);
  if (!source) return undefined;
  const meta = record(source.meta);
  const truncation = record(meta?.truncation);
  const columns = record(record(meta?.limits)?.columnTruncated);
  // Older metadata can use UTF-16 characters. Do not relabel that cap as bytes.
  const byteColumns = columns?.unit === "bytes" ? columns : undefined;
  const parsed: BashTruncation = {};
  const elidedBytes = count(source.elidedBytes) ?? count(truncation?.elidedBytes);
  const elidedLines = count(source.elidedLines) ?? count(truncation?.elidedLines);
  const columnDroppedBytes = count(source.columnDroppedBytes);
  const columnTruncatedLines = count(source.columnTruncatedLines);
  const columnTruncatedRange = lineRange(source.columnTruncatedRange) ?? lineRange(byteColumns?.lines);
  const columnMax = count(source.columnMax) ?? count(byteColumns?.maxColumn);
  if (elidedBytes !== undefined) parsed.elidedBytes = elidedBytes;
  if (elidedLines !== undefined) parsed.elidedLines = elidedLines;
  if (columnDroppedBytes !== undefined) parsed.columnDroppedBytes = columnDroppedBytes;
  if (columnTruncatedLines !== undefined) parsed.columnTruncatedLines = columnTruncatedLines;
  if (columnTruncatedRange !== undefined) parsed.columnTruncatedRange = columnTruncatedRange;
  if (columnMax !== undefined) parsed.columnMax = columnMax;
  return columnTruncatedRange !== undefined ||
    (elidedBytes ?? 0) > 0 || (elidedLines ?? 0) > 0 ||
    (columnDroppedBytes ?? 0) > 0 || (columnTruncatedLines ?? 0) > 0 || (columnMax ?? 0) > 0
    ? parsed
    : undefined;
}
