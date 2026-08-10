import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function fixtureCommand(name: string, source: string): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-"));
  cleanups.push(cwd);
  const bin = path.join(cwd, "bin");
  fs.mkdirSync(bin);
  const command = path.join(bin, `git-${name}`);
  fs.writeFileSync(command, `#!${process.execPath}\n${source}\n`);
  fs.chmodSync(command, 0o755);
  return {
    cwd,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
  };
}

describe("git", () => {
  it("normalizes trimmed stderr into a plain Error message", async () => {
    const fixture = fixtureCommand(
      "fixture-fail",
      'process.stderr.write("  normalized failure  \\n\\n"); process.exit(7);',
    );

    let failure: unknown;
    try {
      await git(fixture.cwd, ["fixture-fail"], { env: fixture.env });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("normalized failure");
    expect(Object.prototype.hasOwnProperty.call(failure, "code")).toBe(false);
  });

  it("reports the command and configured deadline when Git times out", async () => {
    // This integration exercises child_process's real timeout; fake timers cannot drive the OS process.
    const fixture = fixtureCommand(
      "fixture-hang",
      'process.chdir(require("node:os").tmpdir()); setTimeout(() => process.exit(0), 100);',
    );

    await expect(
      git(fixture.cwd, ["fixture-hang"], { timeoutMs: 20, env: fixture.env }),
    ).rejects.toThrow("git fixture-hang timed out after 20 ms");
  });
});
