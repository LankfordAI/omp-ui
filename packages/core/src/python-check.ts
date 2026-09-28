import { execFile } from "node:child_process";
import os from "node:os";
import type { PythonCheckSnapshot } from "./types";

// The `omp setup python --check` probe (issue #671). Lives apart from
// omp-settings.ts because its runner must keep stdout on a failing exit:
// the check answers "unavailable" with valid JSON AND exit code 1 (verified,
// omp 18.4.0), which execOmpConfigRunner would drop into a rejection.

/** One omp probe: resolves code/stdout/stderr; rejects only when the
 *  process could not be run at all (a spawn failure has a string err.code). */
export type OmpProbeRunner = (
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const execOmpProbeRunner: (ompPath: string) => OmpProbeRunner =
  (ompPath) => (args, opts) =>
    // Executor form on purpose: execFile's callback API is the resolver, and
    // core's tsconfig lib predates Promise.withResolvers (ES2024).
    new Promise((resolve, reject) => {
      execFile(
        ompPath,
        [...args],
        { cwd: opts.cwd, env: opts.env, timeout: 15_000, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err !== null && typeof err.code === "number") {
            resolve({ code: err.code, stdout, stderr });
          } else if (err === null) {
            resolve({ code: 0, stdout, stderr });
          } else {
            reject(err);
          }
        },
      );
    });

/** Asks one interpreter for its version line; null when it cannot answer.
 *  CPython 3 prints to stdout, 2.x to stderr — whichever carries a line wins. */
export type InterpreterVersionReader = (interpreterPath: string) => Promise<string | null>;

export const execInterpreterVersion: InterpreterVersionReader = (interpreterPath) =>
  new Promise((resolve) => {
    execFile(interpreterPath, ["--version"], { timeout: 5_000 }, (_err, stdout, stderr) => {
      const line = `${stdout}${stderr}`.trim().split("\n")[0] ?? "";
      resolve(line === "" ? null : line);
    });
  });

function parseProbe(stdout: string): { available: boolean; pythonPath: string | null } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || !("available" in raw)) return null;
  const available = raw.available;
  if (typeof available !== "boolean") return null;
  const path = "pythonPath" in raw ? raw.pythonPath : undefined;
  return {
    available,
    pythonPath: typeof path === "string" && path !== "" ? path : null,
  };
}

/**
 * omp's own verdict on whether its eval tool can run Python. Never throws:
 * every failure — missing binary, rejected spawn, unparseable stdout —
 * answers status "error" so the checklist stays honest and actionable.
 */
export async function checkPythonSetup(
  { ompPath }: { ompPath: string | null },
  // Guarded before `run` is reached; the empty fallback path is never invoked.
  run: OmpProbeRunner = execOmpProbeRunner(ompPath ?? ""),
  readVersion: InterpreterVersionReader = execInterpreterVersion,
): Promise<PythonCheckSnapshot> {
  const failed = (error: string): PythonCheckSnapshot => ({
    status: "error",
    pythonPath: null,
    version: null,
    error,
  });
  if (ompPath === null) return failed("omp binary not found");
  let out: { code: number; stdout: string; stderr: string };
  try {
    // The live env and a neutral cwd: the probe must reflect the user's real
    // global config and PATH, so pristineEnvironment is deliberately not used.
    out = await run(["setup", "python", "--check", "--json"], { cwd: os.tmpdir(), env: process.env });
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  const probe = parseProbe(out.stdout);
  if (probe === null) {
    return failed(
      out.stderr.trim() !== ""
        ? out.stderr.trim()
        : `omp setup python --check exited ${out.code} without an answer`,
    );
  }
  const version =
    probe.available && probe.pythonPath !== null ? await readVersion(probe.pythonPath) : null;
  return {
    status: probe.available ? "ok" : "unavailable",
    pythonPath: probe.pythonPath,
    version,
    error: null,
  };
}
