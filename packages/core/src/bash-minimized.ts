/**
 * omp 18.16 stamps provenance on a minimized bash result at
 * `details.meta.minimized` (upstream `MinimizedMeta`: `{ filter, inputBytes,
 * outputBytes, artifactId }`) when the output minimizer rewrites the payload.
 * Older omp never writes the field, so its absence simply means no card
 * decoration — there is no version gate to consult.
 *
 * `artifactId` names the `artifact://` spill the full output lives in; the
 * card deliberately never surfaces it, so parsing drops it.
 *
 * Renderer-safe: no Node imports, so transcript projection and main share one
 * tolerant parser.
 */
export interface BashMinimized {
  filter: string;
  inputBytes: number;
  outputBytes: number;
}

/** Byte counts arrive as JSON numbers; anything non-integer or negative is a foreign shape. */
function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Tolerant read of a bash tool result's `details.meta.minimized`: returns the
 * provenance when the shape holds, undefined on any deviation — missing or
 * non-object `details`/`meta`/`minimized`, an empty or non-string `filter`, or
 * byte counts that are absent, non-numeric, negative, or non-finite. Extra
 * keys (including `artifactId`) are ignored.
 */
export function parseBashMinimized(details: unknown): BashMinimized | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const meta = (details as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const minimized = (meta as Record<string, unknown>).minimized;
  if (typeof minimized !== "object" || minimized === null) return undefined;
  const record = minimized as Record<string, unknown>;
  if (typeof record.filter !== "string" || record.filter === "") return undefined;
  if (!isByteCount(record.inputBytes) || !isByteCount(record.outputBytes)) return undefined;
  return { filter: record.filter, inputBytes: record.inputBytes, outputBytes: record.outputBytes };
}
