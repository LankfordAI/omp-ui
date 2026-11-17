import * as os from "node:os";
import { describe, expect, it, vi } from "vitest";

// Real core (CH constants, terminalLoginExplanation, the fd-sweep wrapper);
// only the PTY transport is fake — same shape as packages/core/src/pty.test.ts.
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

import { ShellHost } from "./shell-host";

/** The argv after the fd-sweep sentinel (argv[1] is the real program path). */
function realArgv(): string[] {
  const argv = ptySpawn.mock.lastCall![1] as string[];
  const sweep = argv.indexOf("omp-fd-sweep");
  return sweep === -1 ? argv : argv.slice(sweep + 2);
}

function host(overrides: Partial<ConstructorParameters<typeof ShellHost>[0]> = {}): ShellHost {
  return new ShellHost({
    getOmpPath: () => "/bin/omp",
    send: vi.fn(),
    ...overrides,
  });
}

describe("ShellHost omp-login program (#1197)", () => {
  it("spawns `omp login <providerId>` for a roster-listed provider", () => {
    ptySpawn.mockClear();
    host({ listTerminalLoginProviderIds: () => ["google-antigravity"] }).launch(
      "provider-login:google-antigravity",
      "/renderer-chosen/cwd",
      80,
      24,
      { program: "omp-login", providerId: "google-antigravity" },
    );
    expect(realArgv()).toEqual(["login", "google-antigravity"]);
    // The child runs in the home directory: the renderer's cwd never steers it.
    const options = ptySpawn.mock.lastCall![2] as { cwd: string };
    expect(options.cwd).toBe(os.homedir());
  });

  it("rejects a provider id main's roster does not list", () => {
    ptySpawn.mockClear();
    expect(() =>
      host({ listTerminalLoginProviderIds: () => ["google-antigravity"] }).launch(
        "provider-login:x",
        "/tmp",
        80,
        24,
        { program: "omp-login", providerId: "openai-codex" },
      ),
    ).toThrow("omp login openai-codex");
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  it("rejects every omp-login when the host has no roster at all", () => {
    ptySpawn.mockClear();
    expect(() =>
      host().launch("provider-login:x", "/tmp", 80, 24, {
        program: "omp-login",
        providerId: "google-antigravity",
      }),
    ).toThrow();
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  it("leaves a live shell running when the login spawn is refused", () => {
    ptySpawn.mockClear();
    const h = host({ listTerminalLoginProviderIds: () => [] });
    h.launch("tab-1", "/tmp", 80, 24); // the login shell
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(() =>
      h.launch("tab-1", "/tmp", 80, 24, { program: "omp-login", providerId: "evil" }),
    ).toThrow();
    // Kill-before-validate would have taken the shell down; it must not.
    expect(ptySpawn).toHaveBeenCalledTimes(1);
  });
});
