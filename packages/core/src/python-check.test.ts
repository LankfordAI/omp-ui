import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { resolveOmpBinary } from "./paths";
import { checkPythonSetup, type InterpreterVersionReader, type OmpProbeRunner } from "./python-check";

const OMP = "/x/omp";

const PASS_JSON =
  '{"available":true,"pythonPath":"/usr/bin/python","usingManagedEnv":false,"managedEnvPath":"/home/a/.omp/python-env"}';
const FAIL_JSON =
  '{"available":false,"pythonPath":"/opt/py","usingManagedEnv":false,"managedEnvPath":"/home/a/.omp/python-env"}';

interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ProbeCall {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** A runner that never spawns; records args and opts, may reject instead. */
function fakeRunner(result: ProbeResult | Error): OmpProbeRunner & { calls: ProbeCall[] } {
  const run = async (
    args: readonly string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<ProbeResult> => {
    run.calls.push({ args, cwd: opts.cwd, env: opts.env });
    if (result instanceof Error) throw result;
    return result;
  };
  run.calls = [] as ProbeCall[];
  return run;
}

/** A version reader that never spawns; records the paths it was asked about. */
function fakeVersion(line: string | null): InterpreterVersionReader & { seen: string[] } {
  const read: InterpreterVersionReader & { seen: string[] } = async (interpreterPath) => {
    read.seen.push(interpreterPath);
    return line;
  };
  read.seen = [];
  return read;
}

describe("checkPythonSetup", () => {
  it("reports ok with the version on a passing probe", async () => {
    const run = fakeRunner({ code: 0, stdout: PASS_JSON, stderr: "" });
    const readVersion = fakeVersion("Python 3.12.11");
    expect(await checkPythonSetup({ ompPath: OMP }, run, readVersion)).toEqual({
      status: "ok",
      pythonPath: "/usr/bin/python",
      version: "Python 3.12.11",
      error: null,
    });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.args).toEqual(["setup", "python", "--check", "--json"]);
    // The probe reflects the user's real global config and PATH: live env,
    // neutral cwd — never pristineEnvironment.
    expect(run.calls[0]?.env).toBe(process.env);
    expect(run.calls[0]?.cwd).toBe(os.tmpdir());
    expect(readVersion.seen).toEqual(["/usr/bin/python"]);
  });

  it("reports unavailable from stdout at exit 1 and never asks for a version", async () => {
    const run = fakeRunner({ code: 1, stdout: FAIL_JSON, stderr: "" });
    const readVersion = fakeVersion("Python 3.12.11");
    expect(await checkPythonSetup({ ompPath: OMP }, run, readVersion)).toEqual({
      status: "unavailable",
      pythonPath: "/opt/py",
      version: null,
      error: null,
    });
    expect(readVersion.seen).toEqual([]);
  });

  it("reports ok without a version when the interpreter cannot answer", async () => {
    const run = fakeRunner({ code: 0, stdout: PASS_JSON, stderr: "" });
    expect(
      await checkPythonSetup({ ompPath: OMP }, run, async () => null),
    ).toEqual({ status: "ok", pythonPath: "/usr/bin/python", version: null, error: null });
  });

  it.each([
    { code: 0, label: "exit 0" },
    { code: 1, label: "exit 1" },
  ])("answers error with stderr when stdout is garbage at $label", async ({ code }) => {
    const run = fakeRunner({ code, stdout: "not json", stderr: "unknown flag: --check" });
    expect(await checkPythonSetup({ ompPath: OMP }, run, async () => null)).toEqual({
      status: "error",
      pythonPath: null,
      version: null,
      error: "unknown flag: --check",
    });
  });

  it("answers error without stderr instead of the bare exit code", async () => {
    const run = fakeRunner({ code: 2, stdout: "", stderr: "" });
    const snap = await checkPythonSetup({ ompPath: OMP }, run, async () => null);
    expect(snap.status).toBe("error");
    expect(snap.error).toContain("exited 2");
  });

  it("answers error with the spawn message when the runner rejects", async () => {
    const run = fakeRunner(new Error("spawn EACCES"));
    expect(await checkPythonSetup({ ompPath: OMP }, run, async () => null)).toEqual({
      status: "error",
      pythonPath: null,
      version: null,
      error: "spawn EACCES",
    });
  });

  it("spawns nothing without an omp binary", async () => {
    const run = fakeRunner({ code: 0, stdout: PASS_JSON, stderr: "" });
    expect(await checkPythonSetup({ ompPath: null }, run, async () => null)).toEqual({
      status: "error",
      pythonPath: null,
      version: null,
      error: "omp binary not found",
    });
    expect(run.calls).toEqual([]);
  });

  it("parity with the live omp binary — skipped when there is none", async () => {
    const ompPath = resolveOmpBinary();
    if (ompPath === null) return;
    // Pins the CLI contract verified on omp 18.4.0: the probe answers with
    // parseable JSON at either exit code, so omp's verdict — never "error".
    const snap = await checkPythonSetup({ ompPath });
    expect(["ok", "unavailable"]).toContain(snap.status);
  }, 30_000);
});
