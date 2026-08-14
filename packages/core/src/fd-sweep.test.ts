import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FD_SWEEP_SCRIPT, withFdSweep } from "./fd-sweep";

describe("withFdSweep", () => {
  it("is identity on Windows (ConPTY is unaffected)", () => {
    expect(withFdSweep("C:\\omp.exe", ["--cwd", "C:\\p"], "win32")).toEqual({
      file: "C:\\omp.exe",
      args: ["--cwd", "C:\\p"],
    });
  });

  it("wraps Unix commands in the sh sweep, forwarding argv verbatim", () => {
    const cmd = withFdSweep("/opt/omp dir/omp", ["--session-dir", "/tmp/a b", ""], "linux");
    expect(cmd.file).toBe("/bin/sh");
    expect(cmd.args).toEqual([
      "-c",
      FD_SWEEP_SCRIPT,
      "omp-fd-sweep",
      "/opt/omp dir/omp",
      "--session-dir",
      "/tmp/a b",
      "",
    ]);
  });

  it.skipIf(process.platform !== "linux")(
    "closes inherited fds above stderr before exec (live kernel check)",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-sweep-"));
      const payload = path.join(dir, "payload");
      fs.writeFileSync(payload, "x");
      // stdio slot 3 hands the child this fd with CLOEXEC cleared by libuv —
      // the same inheritance mechanism as Electron's cache handles.
      const leaked = fs.openSync(payload, "r");
      // Probe by stat: `[ -e ... ]` opens no fd, unlike a /proc/self/fd/*
      // glob, whose opendir would itself occupy fd 3 at readdir time.
      const probe = [
        "-c",
        'printf "%s|" "$1"; if [ -e /proc/self/fd/3 ]; then echo OPEN; else echo CLOSED; fi',
        "inner",
        "a b",
      ];
      try {
        // Control: without the sweep the child sees the leaked fd — proves
        // this harness reproduces the inheritance defect at all.
        const control = execFileSync("/bin/sh", probe, {
          stdio: ["ignore", "pipe", "pipe", leaked],
          encoding: "utf8",
        });
        expect(control.trim()).toBe("a b|OPEN");

        const cmd = withFdSweep("/bin/sh", probe);
        const swept = execFileSync(cmd.file, cmd.args, {
          stdio: ["ignore", "pipe", "pipe", leaked],
          encoding: "utf8",
        });
        // Space-bearing arg survived the shim; the leaked fd did not.
        expect(swept.trim()).toBe("a b|CLOSED");
      } finally {
        fs.closeSync(leaked);
      }
    },
  );
});
