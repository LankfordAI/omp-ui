/**
 * How a client starts the persistent host when none is live (issue #442 §9):
 * it submits the platform supervisor's reserved on-demand identity and then
 * probes `host.json`. The client never `spawn()`s the host binary itself — the
 * supervisor owns the process, so the client's exit cannot take the host with
 * it, and a later `omp-ui service install` promotes the same identity instead
 * of racing a second host.
 */

export const HOST_SYSTEMD_UNIT = "omp-ui-host";
export const HOST_LAUNCHD_LABEL = "ai.lankford.omp-ui.host";
export const HOST_WINDOWS_TASK = "\\LankfordAI\\omp-ui Host";

export interface HostLaunchOpts {
  /** Absolute path of the `omp-ui` host executable. */
  execPath: string;
  dataRoot: string;
  /** Where a supervisor without a journal captures stdout/stderr. */
  logDir: string;
}

export interface HostLaunchCommand {
  cmd: string;
  args: string[];
}

/** The `systemd-run` argv for the transient user unit; shared with the host's own supervisor adapter. */
export function systemdRunArgs(opts: HostLaunchOpts): string[] {
  return [
    "--user",
    `--unit=${HOST_SYSTEMD_UNIT}`,
    "--property=Restart=no",
    "--collect",
    `--setenv=OMP_UI_DATA_DIR=${opts.dataRoot}`,
    "--",
    opts.execPath,
    "serve",
  ];
}

/**
 * The command sequence that submits the on-demand identity, in order; every
 * command must exit 0. `null` on a platform with no supervisor.
 *
 * - Linux: one transient `systemd-run --user` unit under the service's name.
 * - macOS: `launchctl submit` under the LaunchAgent's label (login-to-logout,
 *   like the installed agent; `service install` replaces it with the plist).
 * - Windows: register the on-demand task under the Scheduled Task's path
 *   (`/SC ONCE` never fires by itself) and run it in the interactive session.
 */
export function hostLaunchCommands(platform: NodeJS.Platform, opts: HostLaunchOpts): HostLaunchCommand[] | null {
  switch (platform) {
    case "linux":
      return [{ cmd: "systemd-run", args: systemdRunArgs(opts) }];
    case "darwin": {
      const log = `${opts.logDir}/host.log`;
      return [
        {
          cmd: "launchctl",
          args: ["submit", "-l", HOST_LAUNCHD_LABEL, "-o", log, "-e", log, "--", opts.execPath, "serve"],
        },
      ];
    }
    case "win32":
      return [
        {
          cmd: "schtasks",
          args: [
            "/Create",
            "/TN",
            HOST_WINDOWS_TASK,
            "/SC",
            "ONCE",
            "/ST",
            "00:00",
            "/RL",
            "LIMITED",
            "/F",
            "/TR",
            `"${opts.execPath}" serve`,
          ],
        },
        { cmd: "schtasks", args: ["/Run", "/TN", HOST_WINDOWS_TASK] },
      ];
    default:
      return null;
  }
}
