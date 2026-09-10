import { describe, expect, it } from "vitest";
import { HOST_LAUNCHD_LABEL, HOST_WINDOWS_TASK, hostLaunchCommands, systemdRunArgs } from "./host-launch";

const OPTS = { execPath: "/home/u/.local/bin/omp-ui", dataRoot: "/home/u/.local/share/omp-ui", logDir: "/home/u/.local/share/omp-ui/logs" };

describe("hostLaunchCommands", () => {
  it("linux submits one transient user unit under the service's reserved name", () => {
    expect(hostLaunchCommands("linux", OPTS)).toEqual([{ cmd: "systemd-run", args: systemdRunArgs(OPTS) }]);
    expect(systemdRunArgs(OPTS)).toContain("--unit=omp-ui-host");
    expect(systemdRunArgs(OPTS).slice(-2)).toEqual([OPTS.execPath, "serve"]);
  });

  it("darwin submits under the LaunchAgent label so `service install` replaces, not races, it", () => {
    const [cmd] = hostLaunchCommands("darwin", OPTS)!;
    expect(cmd.cmd).toBe("launchctl");
    expect(cmd.args.slice(0, 3)).toEqual(["submit", "-l", HOST_LAUNCHD_LABEL]);
    expect(cmd.args.slice(-2)).toEqual([OPTS.execPath, "serve"]);
  });

  it("win32 registers the task under the Scheduled Task path with a never-firing trigger, then runs it", () => {
    const cmds = hostLaunchCommands("win32", { ...OPTS, execPath: "C:\\Users\\u\\AppData\\Local\\omp-ui-host\\bin\\omp-ui.exe" })!;
    expect(cmds.map((c) => c.cmd)).toEqual(["schtasks", "schtasks"]);
    expect(cmds[0].args).toEqual(expect.arrayContaining(["/Create", "/TN", HOST_WINDOWS_TASK, "/SC", "ONCE"]));
    expect(cmds[0].args[cmds[0].args.indexOf("/TR") + 1]).toBe('"C:\\Users\\u\\AppData\\Local\\omp-ui-host\\bin\\omp-ui.exe" serve');
    expect(cmds[1].args).toEqual(["/Run", "/TN", HOST_WINDOWS_TASK]);
  });

  it("an unsupported platform has no supervisor to submit to", () => {
    expect(hostLaunchCommands("freebsd", OPTS)).toBeNull();
  });
});
