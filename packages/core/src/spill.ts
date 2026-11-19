import { compareVersions } from "./semver";

/**
 * OMP 19 moved truncated tool output to session spill files: spill `N` is the
 * plain file `<N>.log` at the session's `local://` root
 * (`<sessionFile without .jsonl>/local`), referenced as `local://N.log`. The
 * tool result's output metadata carries the spill id only when mirroring
 * succeeded — `meta.truncation.artifactId`, `meta.limits.columnTruncated.artifactId`,
 * or `meta.minimized.artifactId` (upstream `packages/tui/src/tools/output-meta.ts`).
 *
 * Pre-19 sessions reference the legacy `artifact://<id>` store instead and OMP 19
 * does not migrate those files, so a card from a below-gate harness shows an
 * unavailable state; nothing guesses a path for them.
 *
 * Renderer-safe: no Node imports, so the transcript projection, the cards, and
 * main share one gate and one tolerant parser.
 */
export const SPILL_READ_MIN_OMP = "19.0.0";

/** Unknown version is below the gate: only omp 19+ spells `local://N.log` spills. */
export function supportsSpillRead(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, SPILL_READ_MIN_OMP) >= 0;
}

/**
 * Hard bound on bytes one spill read returns. Spill files themselves run to
 * omp's own 16 MiB artifact cap; a read past this bound sets `truncated` and
 * the viewer says so instead of loading a megabyte-scale slab.
 */
export const SPILL_READ_MAX_BYTES = 1024 * 1024;

/** One spill a tool result references, as the card's action sees it. */
export interface SpillReference {
  /** Numeric spill id; file `local://<id>.log` at the owning session's local root. */
  id: number;
  /** omp's artifact cap cut the saved file (`artifactElidedBytes > 0`): the
   *  spill holds a head/tail sample, not the complete output. */
  sample: boolean;
}

/** Result of one confined spill read on the owning host. */
export type SpillReadResult =
  | { status: "ok"; text: string; /** True when the file exceeds {@link SPILL_READ_MAX_BYTES}. */ truncated: boolean }
  /** The session, its spill root, or this spill file is not on the host. */
  | { status: "missing" }
  /** The session predates omp 19: its raw output lives in the legacy
   *  `artifact://` store, which omp 19 does not migrate and nothing resolves. */
  | { status: "legacy" };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** A spill id: digits only. Legacy ids were numeric too, so this shape alone
 *  never distinguishes schemes — the harness gate decides which one opens. */
function spillId(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

function sampleFlag(source: Record<string, unknown>): boolean {
  const elided = source.artifactElidedBytes;
  return typeof elided === "number" && Number.isFinite(elided) && elided > 0;
}

/**
 * Tolerant read of the spill a bash/tool result's `details.meta` references.
 * The three carriers name one spill per result when they appear together; the
 * first that holds a valid id wins: truncation, then the column cap, then the
 * minimizer. Any deviation (missing meta, non-digit id) yields undefined —
 * an absent action, never a guessed one. `meta.artifactError` (save failed,
 * no artifactId anywhere) therefore also yields undefined.
 */
export function parseSpillReference(details: unknown): SpillReference | undefined {
  const meta = record(record(details)?.meta);
  if (!meta) return undefined;
  const carriers = [record(meta.truncation), record(record(meta.limits)?.columnTruncated), record(meta.minimized)];
  for (const carrier of carriers) {
    if (!carrier) continue;
    const id = spillId(carrier.artifactId);
    if (id !== undefined) return { id, sample: sampleFlag(carrier) };
  }
  return undefined;
}
