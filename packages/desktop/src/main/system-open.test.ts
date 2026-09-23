import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A real spawn here would open the developer's browser. node:child_process
// exports are non-configurable (no spyOn), so the module mock swaps spawn and
// keeps the rest real, as watcher.test.ts does for fs.watch.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

// system-open.ts touches only electron's `shell`; stub it and capture calls.
const shellMock = {
  openExternal: vi.fn(async () => {}),
  openPath: vi.fn(async () => ""),
};
vi.mock("electron", () => ({ shell: shellMock }));

const { openExternal, openPath } = await import("./system-open");
const spawnMock = vi.mocked(spawn);

/** A child as node reports it: 'spawn', or `error`, on a later tick; never an exit. */
function fakeChild(error?: Error): ChildProcess {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  setImmediate(() => (error ? child.emit("error", error) : child.emit("spawn")));
  return child as unknown as ChildProcess;
}

/** The launches spawn saw, as [file, args] pairs. */
function launches(): [string, readonly string[]][] {
  return spawnMock.mock.calls.map(([file, args]) => [file, args]);
}

beforeEach(() => {
  spawnMock.mockImplementation(() => fakeChild());
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("system-open on Linux", () => {
  // The AppImage runtime exists only on Linux, and withoutAppImageRuntime()
  // leaves other hosts' environments alone, so the strip is observable only here.
  it.runIf(process.platform === "linux")(
    "hands a URL to xdg-open from the pre-AppImage environment (#635)",
    async () => {
      const mount = "/tmp/.mount_omp-uiTEST00";
      vi.stubEnv("APPDIR", mount);
      vi.stubEnv("APPIMAGE", "/home/u/omp-ui.AppImage");
      vi.stubEnv("ARGV0", "/home/u/omp-ui.AppImage");
      vi.stubEnv("OWD", "/home/u");
      vi.stubEnv("PATH", `${mount}:${mount}/usr/sbin:/usr/bin`);
      vi.stubEnv("LD_LIBRARY_PATH", `${mount}/usr/lib`);

      await openExternal("https://a.dev/x", "linux");

      expect(launches()).toEqual([["xdg-open", ["https://a.dev/x"]]]);
      const options = spawnMock.mock.calls[0]![2];
      expect(options).toMatchObject({ cwd: homedir(), detached: true, stdio: "ignore" });
      const env = options.env!;
      for (const name of ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH"]) {
        expect(env[name]).toBeUndefined();
      }
      expect(env.PATH).toBe("/usr/bin");
      expect(shellMock.openExternal).not.toHaveBeenCalled();
    },
  );

  it("hands a mailto URL to xdg-email, as Electron's own launch does", async () => {
    await openExternal("MAILTO:a@b.dev", "linux");
    expect(launches()).toEqual([["xdg-email", ["MAILTO:a@b.dev"]]]);
  });

  it("opens the exact path through xdg-open and rejects when xdg-open cannot start", async () => {
    const file = '/work/a "quoted" export.html';
    await openPath(file, "linux");
    expect(launches()).toEqual([["xdg-open", [file]]]);

    spawnMock.mockImplementationOnce(() => fakeChild(new Error("spawn xdg-open ENOENT")));
    await expect(openPath(file, "linux")).rejects.toThrow("spawn xdg-open ENOENT");
  });
});

describe("system-open off Linux", () => {
  it("keeps Electron's shell and rejects on an openPath failure string", async () => {
    await openExternal("https://a.dev", "darwin");
    expect(shellMock.openExternal.mock.calls).toEqual([["https://a.dev"]]);

    await openPath("/work/export.html", "darwin");
    shellMock.openPath.mockResolvedValueOnce("No application is associated");
    await expect(openPath("C:\\work\\export.html", "win32")).rejects.toThrow(
      "No application is associated",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
