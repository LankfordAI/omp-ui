import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FD_SWEEP_SCRIPT, withFdSweep } from "./fd-sweep";

/** dash is the shell that rejects multi-digit fd redirections (Debian/Ubuntu /bin/sh). */
const dashPath = ["/usr/bin/dash", "/bin/dash"].find((p) => fs.existsSync(p));

/**
 * Runs the sweep wrapper under `shell` with fds 3 and 12 leaked into the
 * child (stdio slot 12 exercises the multi-digit redirection that kills
 * dash), asserting both get closed and a space-bearing arg survives exec.
 */
function runSweptProbe(shell: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-sweep-"));
  const payload = path.join(dir, "payload");
  fs.writeFileSync(payload, "x");
  // stdio slots hand the child these fds with CLOEXEC cleared by libuv —
  // the same inheritance mechanism as Electron's cache handles.
  const low = fs.openSync(payload, "r");
  const high = fs.openSync(payload, "r");
  // Probe by stat: `[ -e ... ]` opens no fd, unlike a /proc/self/fd/*
  // glob, whose opendir would itself occupy a free slot at readdir time.
  const probe = [
    "-c",
    'printf "%s|" "$1"; for n in 3 12; do if [ -e /proc/self/fd/$n ]; then printf "%s:OPEN|" $n; else printf "%s:CLOSED|" $n; fi; done; echo end',
    "inner",
    "a b",
  ];
  const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe", low];
  while (stdio.length < 12) stdio.push("ignore");
  stdio.push(high); // fd 12
  try {
    // Control: without the sweep the child sees both leaked fds — proves
    // this harness reproduces the inheritance defect at all.
    const control = execFileSync("/bin/sh", probe, { stdio, encoding: "utf8" });
    expect(control.trim()).toBe("a b|3:OPEN|12:OPEN|end");

    const cmd = withFdSweep("/bin/sh", probe);
    return execFileSync(shell, cmd.args, { stdio, encoding: "utf8" }).trim();
  } finally {
    fs.closeSync(low);
    fs.closeSync(high);
  }
}

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

  it("embeds no single quotes in the sweep body (bash re-exec quoting invariant)", () => {
    // FD_SWEEP_SCRIPT wraps the close loop in '…' for `exec bash -c '…'`;
    // a single quote inside the body would truncate that argument.
    const bashArg = FD_SWEEP_SCRIPT.match(/exec bash -c '([^]*?)' omp-fd-sweep/);
    expect(bashArg).not.toBeNull();
    expect(bashArg![1]).not.toContain("'");
  });

  it.skipIf(process.platform !== "linux")(
    "closes inherited fds above stderr — including double-digit fds — before exec (live kernel check)",
    () => {
      expect(runSweptProbe("/bin/sh")).toBe("a b|3:CLOSED|12:CLOSED|end");
    },
  );

  it.skipIf(process.platform !== "linux" || !dashPath)(
    "survives dash's single-digit-only fd redirections via the bash re-exec (issue #185 CI regression)",
    () => {
      expect(runSweptProbe(dashPath!)).toBe("a b|3:CLOSED|12:CLOSED|end");
    },
  );
});
