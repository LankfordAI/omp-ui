import { describe, expect, it } from "vitest";
import { defaultShell, normalizePtyKillSignal, ompTuiArgs, ptyChunkToBuffer } from "./pty";

describe("defaultShell", () => {
  it("uses COMSPEC without shell arguments on Windows", () => {
    expect(defaultShell("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [],
    });
  });

  it("falls back to cmd.exe when COMSPEC is absent", () => {
    expect(defaultShell("win32", {})).toEqual({ file: "cmd.exe", args: [] });
  });

  it("preserves the Unix login-shell invocation", () => {
    expect(defaultShell("linux", { SHELL: "/bin/zsh" })).toEqual({
      file: "/bin/zsh",
      args: ["-l"],
    });
  });
});

describe("ompTuiArgs", () => {
  it("runs the handoff TUI in the tab's cwd without a session", () => {
    expect(ompTuiArgs("/w")).toEqual(["--cwd", "/w", "--no-session"]);
  });

  it("keeps the handoff out of the tab's lineage", () => {
    // ADR-0003: a --session-dir or --resume here would make the errand a
    // sibling of the tab's own session.
    const args = ompTuiArgs("/w");
    expect(args).not.toContain("--session-dir");
    expect(args.some((arg) => arg.startsWith("--resume"))).toBe(false);
  });

  it("carries the dev/test spawn gate's selector as --model", () => {
    expect(ompTuiArgs("/w", "p/m:low")).toEqual([
      "--cwd",
      "/w",
      "--no-session",
      "--model",
      "p/m:low",
    ]);
  });
});

describe("normalizePtyKillSignal", () => {
  it("drops Unix signals for ConPTY termination", () => {
    expect(normalizePtyKillSignal("SIGKILL", "win32")).toBeUndefined();
    expect(normalizePtyKillSignal(undefined, "win32")).toBeUndefined();
  });

  it("forwards requested signals on Unix", () => {
    expect(normalizePtyKillSignal("SIGKILL", "linux")).toBe("SIGKILL");
    expect(normalizePtyKillSignal(undefined, "darwin")).toBeUndefined();
  });
});

describe("ptyChunkToBuffer", () => {
  it("encodes Windows string output as UTF-8", () => {
    expect(ptyChunkToBuffer("ConPTY ✓")).toEqual(Buffer.from("ConPTY ✓", "utf8"));
  });

  it("preserves raw Unix buffers", () => {
    const chunk = Buffer.from([0, 0xff, 0x41]);
    expect(ptyChunkToBuffer(chunk)).toBe(chunk);
  });
});
