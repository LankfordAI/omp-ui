// The subprocess half of the anonymized-share contract (issue #834): runs
// `omp anonymize <sessionFile> -o <outDir>` against the resolved binary.
// Main-process only (mirrors collab-cli.ts) — the renderer never shells out,
// and redaction stays entirely omp-side: omp-ui never re-implements it.
import { execFile } from "node:child_process";
import type { AnonymizeSessionResult } from "./types";

/** One CLI invocation outcome, captured without throwing on nonzero exit. */
export interface AnonymizeCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Test seam: run the bundled omp with argv. Defaults to child_process.execFile. */
export type AnonymizeCliExec = (ompPath: string, argv: readonly string[]) => Promise<AnonymizeCliResult>;

export interface AnonymizeDeps {
  /** Test seam replacing the subprocess. */
  exec?: AnonymizeCliExec;
}

// Sessions with subagents take seconds to redact; 60 s is the ceiling.
const DEFAULT_TIMEOUT_MS = 60_000;

const defaultExec: AnonymizeCliExec = (ompPath, argv) =>
  // Executor form (not Promise.withResolvers): core's tsconfig lib is ES2022.
  new Promise((resolve) => {
    execFile(
      ompPath,
      [...argv],
      // NO_COLOR/FORCE_COLOR=0 keep the refusal scrape plain text
      // (omp-settings.ts:99-110): an inherited FORCE_COLOR would colorize
      // stderr past the "^error:" strip and surface escape codes verbatim.
      {
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
      (err, stdout, stderr) => {
        // execFile errors carry the exit code (or a spawn failure as a string);
        // both are outcomes, not throws — the caller reads the contract.
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
        resolve({ stdout, stderr, code });
      },
    );
  });

/**
 * Writes the anonymized copy of `sessionFile` into `outDir`:
 * `omp anonymize <file> -o <dir>`. Every value rides as one argv element —
 * never shell text. Gzipped inputs must be un-gzipped by the caller first:
 * omp rejects `.jsonl.gz` with exit 2 (verified live against omp/18.8.9).
 * Nonzero exit surfaces omp's own stderr message, the contract every
 * omp-version gate in this repo already relies on.
 */
export async function anonymizeSession(
  ompPath: string,
  sessionFile: string,
  outDir: string,
  deps: AnonymizeDeps = {},
): Promise<AnonymizeSessionResult> {
  const result = await (deps.exec ?? defaultExec)(ompPath, ["anonymize", sessionFile, "-o", outDir]);
  if (result.code === 0) return { ok: true, path: outDir, message: null };
  const text = result.stderr.trim().replace(/^error:\s*/i, "");
  return { ok: false, path: null, message: text.length > 0 ? text : "omp anonymize failed" };
}
