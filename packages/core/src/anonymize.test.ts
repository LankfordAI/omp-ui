import { describe, expect, it } from "vitest";
import {
  anonymizeSession,
  type AnonymizeCliExec,
  type AnonymizeCliResult,
} from "./anonymize";

function fakeExec(result: AnonymizeCliResult): { exec: AnonymizeCliExec; argvs: string[][] } {
  const argvs: string[][] = [];
  const exec: AnonymizeCliExec = (_ompPath, argv) => {
    argvs.push([...argv]);
    return Promise.resolve(result);
  };
  return { exec, argvs };
}

const EXIT0: AnonymizeCliResult = { stdout: "", stderr: "", code: 0 };

describe("anonymizeSession (issue #834)", () => {
  it("runs the redaction subcommand with the file and out dir as argv", async () => {
    const { exec, argvs } = fakeExec(EXIT0);
    await expect(
      anonymizeSession("/bin/omp", "/s/session.jsonl", "/s/anon", { exec }),
    ).resolves.toEqual({ ok: true, path: "/s/anon", message: null });
    expect(argvs).toEqual([["anonymize", "/s/session.jsonl", "-o", "/s/anon"]]);
  });

  it("surfaces omp's stderr refusal with the leading error stripped", async () => {
    const { exec } = fakeExec({
      stdout: "",
      stderr: "Error: not a valid session file\n",
      code: 2,
    });
    await expect(
      anonymizeSession("/bin/omp", "/s/session.jsonl.gz", "/s/anon", { exec }),
    ).resolves.toEqual({
      ok: false,
      path: null,
      message: "not a valid session file",
    });
  });

  it("falls back to a generic message when stderr is empty", async () => {
    const { exec } = fakeExec({ stdout: "", stderr: "   ", code: 1 });
    await expect(
      anonymizeSession("/bin/omp", "/s/session.jsonl", "/s/anon", { exec }),
    ).resolves.toEqual({ ok: false, path: null, message: "omp anonymize failed" });
  });

  it("reports failure on a null exit code (killed process)", async () => {
    const { exec } = fakeExec({ stdout: "", stderr: "", code: null });
    await expect(
      anonymizeSession("/bin/omp", "/s/session.jsonl", "/s/anon", { exec }),
    ).resolves.toEqual({ ok: false, path: null, message: "omp anonymize failed" });
  });
});
