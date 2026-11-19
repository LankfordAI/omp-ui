import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { compareVersions } from "./semver";
import { SPILL_READ_MIN_OMP } from "./spill";

/**
 * Whether a saved session transcript was ever run on a spill-capable harness
 * (omp 19+, the version that moved raw tool output to `local://N.log` files).
 * omp persists its runtime version in every `model_change` entry's
 * `runtime.version` (probe against 18.22.2 and 19.0.0: line 3 onward), so a
 * transcript's version picture is bounded by reading its head — no full-file
 * scan. A resumed session gains newer entries, so ANY version at or above the
 * gate counts as spill-capable; only a transcript whose observed versions are
 * all below it is legacy (`artifact://`, unmigrated). A transcript with no
 * readable runtime version is not called legacy: the caller just tries the
 * spill read and reports missing files honestly.
 */
const HEAD_BYTES = 256 * 1024;

interface Scan {
  version: string | null;
  capable: boolean;
}

function scanLines(text: string): Scan {
  let version: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"runtime"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; runtime?: { version?: unknown } };
      const v = entry.type === "model_change" ? entry.runtime?.version : undefined;
      if (typeof v === "string" && v.length > 0) version = v;
    } catch {
      // A line that is not a whole JSON entry (chunk boundary) carries no verdict.
    }
  }
  return { version, capable: version !== null && compareVersions(version, SPILL_READ_MIN_OMP) >= 0 };
}

/** Reads at most {@link HEAD_BYTES} decoded bytes; gzipped archives stream through gunzip and stop early. */
export async function transcriptSpillCapable(transcriptPath: string): Promise<Scan> {
  const source = fs.createReadStream(transcriptPath);
  const stream = transcriptPath.endsWith(".gz") ? source.pipe(zlib.createGunzip()) : source;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      chunks.push(bytes);
      size += bytes.length;
      if (size >= HEAD_BYTES) break;
    }
  } catch {
    return { version: null, capable: true };
  } finally {
    stream.destroy();
    source.destroy();
  }
  const scan = scanLines(Buffer.concat(chunks, size).toString("utf8"));
  // Never seen a runtime version: not evidence of a legacy harness.
  return scan.version === null ? { version: null, capable: true } : scan;
}

/** The session's spill root from its transcript path (active `.jsonl` / archived `.jsonl.gz`). */
export function spillRootForTranscript(transcriptPath: string): string {
  const stem = transcriptPath.endsWith(".jsonl.gz")
    ? transcriptPath.slice(0, -".jsonl.gz".length)
    : transcriptPath.endsWith(".jsonl")
      ? transcriptPath.slice(0, -".jsonl".length)
      : null;
  return stem === null ? "" : path.join(stem, "local");
}
