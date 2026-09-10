import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { SystemdUserSupervisor } from "./linux-systemd";
import { LaunchdAgentSupervisor } from "./macos-launchd";
import type { Supervisor, SupervisorDeps, SupervisorFs, SupervisorStatus } from "./types";
import { WindowsTaskSupervisor } from "./windows-task";

export { SYSTEMD_UNIT_NAME, SystemdUserSupervisor, systemdRunArgs, type SystemdDeps } from "./linux-systemd";
export { LAUNCHD_LABEL, LaunchdAgentSupervisor, type LaunchdDeps } from "./macos-launchd";
export { WINDOWS_TASK_NAME, WindowsTaskSupervisor, type WindowsTaskDeps } from "./windows-task";
export type {
  RenderOpts,
  RunCommand,
  RunResult,
  Supervisor,
  SupervisorDeps,
  SupervisorFs,
  SupervisorId,
  SupervisorStatus,
  UninstallOpts,
} from "./types";

/** The supervisor owning this platform's reserved identity; `unsupported` elsewhere. */
export function selectSupervisor(deps: SupervisorDeps): Supervisor {
  const fs = deps.fs ?? nodeSupervisorFs;
  switch (deps.platform) {
    case "linux":
      return new SystemdUserSupervisor({
        run: deps.run,
        fs,
        home: deps.home,
        user: deps.user ?? os.userInfo().username,
      });
    case "darwin": {
      const uid = deps.uid ?? process.getuid?.();
      if (uid === undefined) throw new Error("launchd supervisor needs a uid");
      return new LaunchdAgentSupervisor({ run: deps.run, fs, home: deps.home, uid });
    }
    case "win32":
      return new WindowsTaskSupervisor({
        run: deps.run,
        fs,
        user: deps.user ?? os.userInfo().username,
        userDomain: (deps.env ?? process.env).USERDOMAIN,
        tmpDir: deps.tmpDir ?? os.tmpdir(),
        pid: process.pid,
      });
    default:
      return new UnsupportedSupervisor(deps.platform);
  }
}

class UnsupportedSupervisor implements Supervisor {
  readonly id = "unsupported";
  readonly definitionPath = "";

  constructor(private readonly platform: NodeJS.Platform) {}

  render(): string {
    throw this.error();
  }

  parse(): { ours: boolean; execStart: string | null } {
    return { ours: false, execStart: null };
  }

  install(): Promise<void> {
    return Promise.reject(this.error());
  }

  status(): Promise<SupervisorStatus> {
    return Promise.resolve({ kind: "unsupported", reason: this.error().message });
  }

  uninstall(): Promise<void> {
    return Promise.reject(this.error());
  }

  private error(): Error {
    return new Error(`unsupported platform: ${this.platform}`);
  }
}

const nodeSupervisorFs: SupervisorFs = {
  async readFile(p) {
    try {
      return await fsp.readFile(p, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async writeFile(p, data, mode) {
    await fsp.writeFile(p, data, { mode });
    // writeFile's mode is umask-masked and ignored for an existing file; chmod makes it exact.
    if (process.platform !== "win32") await fsp.chmod(p, mode);
  },
  async mkdir(p) {
    await fsp.mkdir(p, { recursive: true });
  },
  rm(p, opts) {
    return fsp.rm(p, { recursive: opts.recursive, force: true });
  },
};
