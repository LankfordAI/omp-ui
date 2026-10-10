import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ptySpawn = vi.fn((...args: unknown[]) => {
  void args;
  return {
    pid: 4242,
    onData: () => ({ dispose: () => {} }),
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
});
vi.mock("node-pty", () => ({ spawn: (...args: unknown[]) => ptySpawn(...args) as never }));

const dirs: string[] = [];

afterEach(() => {
  ptySpawn.mockClear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

import { defaultShell, normalizePtyKillSignal, ompTuiArgs, ptyChunkToBuffer, spawnOmp } from "./pty";

function spawnOmpArgs(opts: Omit<Parameters<typeof spawnOmp>[0], "lineageDir">): string[] {
  const lineageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-lineage-"));
  dirs.push(lineageDir);
  spawnOmp({ ...opts, lineageDir });
  // Unix routes through the fd-sweep wrapper: the real argv is the tail
  // after the omp-fd-sweep sentinel (argv[1] is the omp path itself).
  const argv = ptySpawn.mock.lastCall![1] as string[];
  const sweep = argv.indexOf("omp-fd-sweep");
  return sweep === -1 ? argv : argv.slice(sweep + 2);
}

describe("spawnOmp args", () => {
  const base = {
    id: "tab-1",
    cwd: "/proj",
    ompPath: "/bin/omp",
    cols: 80,
    rows: 24,
  } as const;

  it("appends --append-system-prompt after --resume for a carryover seed (#824)", () => {
    const args = spawnOmpArgs({
      ...base,
      resumeSessionId: "abc-123",
      appendSystemPromptFile: "/lineage/carryover-context.md",
    });
    expect(args.slice(0, 2)).toEqual(["--cwd", "/proj"]);
    expect(args.slice(4)).toEqual([
      "--resume=abc-123",
      "--append-system-prompt",
      "/lineage/carryover-context.md",
    ]);
  });

  it("leaves the argv unchanged without the seed", () => {
    const args = spawnOmpArgs({ ...base, resumeSessionId: "abc-123" });
    expect(args).toEqual([
      "--cwd",
      "/proj",
      "--session-dir",
      expect.stringContaining("pty-lineage-"),
      "--resume=abc-123",
    ]);
  });
});

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
