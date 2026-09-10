import * as path from "node:path";
import {
  foreignDefinition,
  must,
  type RenderOpts,
  type RunCommand,
  type Supervisor,
  type SupervisorFs,
  type SupervisorStatus,
  type UninstallOpts,
} from "./types";

export const SYSTEMD_UNIT_NAME = "omp-ui-host.service";
const UNIT_DESCRIPTION = "omp-ui persistent host";

export interface SystemdDeps {
  run: RunCommand;
  fs: SupervisorFs;
  home: string;
  /** Login name `loginctl enable-linger` and `show-user` act on. */
  user: string;
}

/**
 * `~/.config/systemd/user/omp-ui-host.service`: boot and logout survival
 * through required user lingering (#456). `install` proves `Linger=yes`
 * rather than reporting a weaker service as boot-capable.
 */
export class SystemdUserSupervisor implements Supervisor {
  readonly id = "systemd-user";
  readonly definitionPath: string;

  constructor(private readonly deps: SystemdDeps) {
    this.definitionPath = path.posix.join(deps.home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
  }

  render(opts: RenderOpts): string {
    const exec = systemdQuote(unitExecPath(opts.execPath, this.deps.home));
    return [
      "[Unit]",
      `Description=${UNIT_DESCRIPTION}`,
      "StartLimitIntervalSec=60",
      "StartLimitBurst=5",
      "",
      "[Service]",
      `ExecStart=${exec} serve`,
      "Restart=on-failure",
      "RestartSec=5",
      // The update handover (issue #442 §10.2) launches the replacement inside this
      // cgroup and then exits the main process: only that process may be reaped.
      "KillMode=process",
      `Environment=${systemdQuote(`OMP_UI_DATA_DIR=${opts.dataRoot}`)}`,
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }

  parse(existing: string): { ours: boolean; execStart: string | null } {
    let ours = false;
    let execStart: string | null = null;
    for (const raw of existing.split("\n")) {
      const line = raw.trim();
      if (line === `Description=${UNIT_DESCRIPTION}`) ours = true;
      else if (execStart === null && line.startsWith("ExecStart=")) {
        execStart = line.slice("ExecStart=".length).trim();
      }
    }
    return { ours, execStart };
  }

  async install(opts: RenderOpts): Promise<void> {
    const { run, fs, user } = this.deps;
    const existing = await fs.readFile(this.definitionPath);
    if (existing !== null && !this.parse(existing).ours) throw foreignDefinition(this.definitionPath);
    const rendered = this.render(opts);
    if (existing !== rendered) {
      await fs.mkdir(path.posix.dirname(this.definitionPath));
      await fs.writeFile(this.definitionPath, rendered, 0o644);
    }
    must(await run("systemctl", ["--user", "daemon-reload"]), "systemctl --user daemon-reload");
    must(await run("loginctl", ["enable-linger", user]), "loginctl enable-linger");
    const linger = await run("loginctl", ["show-user", user, "-p", "Linger"]);
    if (linger.code !== 0 || !/^Linger=yes$/m.test(linger.stdout)) {
      throw new Error("linger not enabled");
    }
    must(
      await run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME]),
      `systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`,
    );
  }

  async status(): Promise<SupervisorStatus> {
    const existing = await this.deps.fs.readFile(this.definitionPath);
    if (existing === null) return { kind: "absent" };
    const active = await this.deps.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT_NAME]);
    const detail = active.stdout.trim() || active.stderr.trim() || "unknown";
    return {
      kind: "installed",
      running: active.code === 0 && detail === "active",
      foreign: !this.parse(existing).ours,
      path: this.definitionPath,
      detail,
    };
  }

  async uninstall(opts: UninstallOpts): Promise<void> {
    const { run, fs } = this.deps;
    const existing = await fs.readFile(this.definitionPath);
    if (existing !== null) {
      if (!this.parse(existing).ours) throw foreignDefinition(this.definitionPath);
      must(
        await run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME]),
        `systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`,
      );
      await fs.rm(this.definitionPath, { recursive: false });
      must(await run("systemctl", ["--user", "daemon-reload"]), "systemctl --user daemon-reload");
    }
    if (opts.purgeData) await fs.rm(opts.dataRoot, { recursive: true });
  }
}

/** `%h/.local/bin/...` when the binary sits under the stable command dir; absolute otherwise. */
function unitExecPath(execPath: string, home: string): string {
  const stableDir = path.posix.join(home, ".local", "bin") + "/";
  return execPath.startsWith(stableDir) ? `%h/${execPath.slice(home.length + 1)}` : execPath;
}

/** systemd's double-quoted word syntax, applied only when the bare word would split. */
function systemdQuote(value: string): string {
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}
