import * as path from "node:path";
import { xmlEscape, xmlUnescape } from "./macos-launchd";
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

export const WINDOWS_TASK_NAME = "\\LankfordAI\\omp-ui Host";
const TASK_DESCRIPTION = "omp-ui persistent host";

export interface WindowsTaskDeps {
  run: RunCommand;
  fs: SupervisorFs;
  /** Login name of the interactive principal; qualified by `userDomain` when known. */
  user: string;
  userDomain: string | undefined;
  /** Where the task XML lives between render and `schtasks /Create /XML`. */
  tmpDir: string;
  pid: number;
}

/**
 * `\LankfordAI\omp-ui Host`: a current-user, at-logon Scheduled Task with an
 * interactive token and least privilege (#456) — alive only while that user
 * is logged on; no Session 0 or service claim. Task Scheduler is the only
 * store, so every definition read/write is a `schtasks` round trip.
 */
export class WindowsTaskSupervisor implements Supervisor {
  readonly id = "windows-task";
  readonly definitionPath = WINDOWS_TASK_NAME;

  constructor(private readonly deps: WindowsTaskDeps) {}

  render(opts: RenderOpts): string {
    const principal = this.deps.userDomain ? `${this.deps.userDomain}\\${this.deps.user}` : this.deps.user;
    return [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      "  <RegistrationInfo>",
      `    <Description>${TASK_DESCRIPTION}</Description>`,
      `    <URI>${xmlEscape(WINDOWS_TASK_NAME)}</URI>`,
      "  </RegistrationInfo>",
      "  <Triggers>",
      "    <LogonTrigger>",
      "      <Enabled>true</Enabled>",
      `      <UserId>${xmlEscape(principal)}</UserId>`,
      "    </LogonTrigger>",
      "  </Triggers>",
      "  <Principals>",
      '    <Principal id="Author">',
      `      <UserId>${xmlEscape(principal)}</UserId>`,
      "      <LogonType>InteractiveToken</LogonType>",
      "      <RunLevel>LeastPrivilege</RunLevel>",
      "    </Principal>",
      "  </Principals>",
      "  <Settings>",
      "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "    <AllowHardTerminate>true</AllowHardTerminate>",
      "    <StartWhenAvailable>true</StartWhenAvailable>",
      "    <AllowStartOnDemand>true</AllowStartOnDemand>",
      "    <Enabled>true</Enabled>",
      "    <Hidden>false</Hidden>",
      "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
      "    <WakeToRun>false</WakeToRun>",
      "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "    <Priority>7</Priority>",
      "    <RestartOnFailure>",
      "      <Interval>PT1M</Interval>",
      "      <Count>5</Count>",
      "    </RestartOnFailure>",
      "  </Settings>",
      '  <Actions Context="Author">',
      "    <Exec>",
      `      <Command>${xmlEscape(opts.execPath)}</Command>`,
      "      <Arguments>serve</Arguments>",
      "    </Exec>",
      "  </Actions>",
      "</Task>",
      "",
    ].join("\r\n");
  }

  parse(existing: string): { ours: boolean; execStart: string | null } {
    const description = /<Description>([^<]*)<\/Description>/.exec(existing);
    const command = /<Command>([^<]*)<\/Command>/.exec(existing);
    const args = /<Arguments>([^<]*)<\/Arguments>/.exec(existing);
    let execStart: string | null = null;
    if (command) {
      execStart = xmlUnescape(command[1]);
      if (args && args[1] !== "") execStart += ` ${xmlUnescape(args[1])}`;
    }
    return { ours: description !== null && xmlUnescape(description[1]) === TASK_DESCRIPTION, execStart };
  }

  async install(opts: RenderOpts): Promise<void> {
    const { run, fs } = this.deps;
    const existing = await this.queryXml();
    if (existing !== null && !this.parse(existing).ours) throw foreignDefinition(WINDOWS_TASK_NAME);
    const file = path.win32.join(this.deps.tmpDir, `omp-ui-host-${this.deps.pid}.task.xml`);
    // Task Scheduler's native import encoding; the declaration above says so.
    await fs.writeFile(file, Buffer.from(`\ufeff${this.render(opts)}`, "utf16le"), 0o600);
    try {
      must(
        await run("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", file, "/F"]),
        "schtasks /Create",
      );
    } finally {
      await fs.rm(file, { recursive: false });
    }
    // /Create only registers; the logon trigger fires next logon. Start now.
    must(await run("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]), "schtasks /Run");
  }

  async status(): Promise<SupervisorStatus> {
    const existing = await this.queryXml();
    if (existing === null) return { kind: "absent" };
    const listed = await this.deps.run("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"]);
    const state = /^Status:\s*(.+?)\s*$/m.exec(listed.stdout)?.[1];
    return {
      kind: "installed",
      running: listed.code === 0 && state === "Running",
      foreign: !this.parse(existing).ours,
      path: WINDOWS_TASK_NAME,
      detail: state ?? (listed.code === 0 ? "unknown" : listed.stderr.trim() || "unknown"),
    };
  }

  async uninstall(opts: UninstallOpts): Promise<void> {
    const existing = await this.queryXml();
    if (existing !== null) {
      if (!this.parse(existing).ours) throw foreignDefinition(WINDOWS_TASK_NAME);
      must(await this.deps.run("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]), "schtasks /Delete");
    }
    if (opts.purgeData) await this.deps.fs.rm(opts.dataRoot, { recursive: true });
  }

  /** The registered definition, or null when no task sits at our path. */
  private async queryXml(): Promise<string | null> {
    const queried = await this.deps.run("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME, "/XML"]);
    return queried.code === 0 ? queried.stdout : null;
  }
}
