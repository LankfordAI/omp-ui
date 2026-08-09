import { describe, expect, it } from "vitest";
import { defaultShell, normalizePtyKillSignal, ptyChunkToBuffer } from "./pty";

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
