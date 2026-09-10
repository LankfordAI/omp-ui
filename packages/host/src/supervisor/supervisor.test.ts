import { describe, expect, it } from "vitest";
import { selectSupervisor, systemdRunArgs, type RunResult, type SupervisorFs } from "./index";

interface Fakes {
  fs: SupervisorFs & { files: Map<string, string | Uint8Array>; dirs: string[]; removed: string[] };
  run: ((cmd: string, args: string[]) => Promise<RunResult>) & { calls: string[] };
  /** Scripts the result of one exact command line; unscripted commands succeed silently. */
  script(line: string, result: Partial<RunResult>): void;
}

function fakes(): Fakes {
  const files = new Map<string, string | Uint8Array>();
  const dirs: string[] = [];
  const removed: string[] = [];
  const scripts = new Map<string, Partial<RunResult>>();
  const calls: string[] = [];
  const run = Object.assign(
    async (cmd: string, args: string[]): Promise<RunResult> => {
      const line = `${cmd} ${args.join(" ")}`;
      calls.push(line);
      return { code: 0, stdout: "", stderr: "", ...scripts.get(line) };
    },
    { calls },
  );
  return {
    fs: {
      files,
      dirs,
      removed,
      async readFile(p) {
        const data = files.get(p);
        if (data === undefined) return null;
        return typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      },
      async writeFile(p, data) {
        files.set(p, data);
      },
      async mkdir(p) {
        dirs.push(p);
      },
      async rm(p, opts) {
        removed.push(p);
        for (const key of [...files.keys()]) {
          if (key === p || (opts.recursive && key.startsWith(`${p}/`))) files.delete(key);
        }
      },
    },
    run,
    script: (line, result) => void scripts.set(line, result),
  };
}

const LINUX_OPTS = {
  execPath: "/home/ada/.local/bin/omp-ui",
  dataRoot: "/home/ada/.local/share/omp-ui",
  logDir: "/home/ada/.local/share/omp-ui/logs",
};

describe("systemd user supervisor", () => {
  const UNIT = "/home/ada/.config/systemd/user/omp-ui-host.service";
  const make = (f: Fakes) =>
    selectSupervisor({ run: f.run, fs: f.fs, home: "/home/ada", platform: "linux", user: "ada" });

  it("renders the exact owned unit with %h for the stable command path", () => {
    const sup = make(fakes());
    expect(sup.id).toBe("systemd-user");
    expect(sup.definitionPath).toBe(UNIT);
    expect(sup.render(LINUX_OPTS)).toBe(
      "[Unit]\nDescription=omp-ui persistent host\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n" +
        "[Service]\nExecStart=%h/.local/bin/omp-ui serve\nRestart=on-failure\nRestartSec=5\nKillMode=process\n" +
        "Environment=OMP_UI_DATA_DIR=/home/ada/.local/share/omp-ui\n\n[Install]\nWantedBy=default.target\n",
    );
  });

  it("keeps an absolute ExecStart off the stable dir and quotes paths that would split", () => {
    const unit = make(fakes()).render({
      execPath: "/opt/omp ui/bin/omp-ui",
      dataRoot: "/srv/omp data",
      logDir: "/srv/omp data/logs",
    });
    expect(unit).toContain('ExecStart="/opt/omp ui/bin/omp-ui" serve\n');
    expect(unit).toContain('Environment="OMP_UI_DATA_DIR=/srv/omp data"\n');
  });

  it("parses ours by the Description line and reports ExecStart; a foreign unit is not ours", () => {
    const sup = make(fakes());
    expect(sup.parse(sup.render(LINUX_OPTS))).toEqual({ ours: true, execStart: "%h/.local/bin/omp-ui serve" });
    expect(sup.parse("[Unit]\nDescription=someone else\n[Service]\nExecStart=/bin/other\n")).toEqual({
      ours: false,
      execStart: "/bin/other",
    });
    expect(sup.parse("")).toEqual({ ours: false, execStart: null });
  });

  it("install writes 0644, reloads, enables linger and proves it, then enables --now", async () => {
    const f = fakes();
    f.script("loginctl show-user ada -p Linger", { stdout: "Linger=yes\n" });
    const sup = make(f);
    await sup.install(LINUX_OPTS);
    expect(f.fs.dirs).toEqual(["/home/ada/.config/systemd/user"]);
    expect(f.fs.files.get(UNIT)).toBe(sup.render(LINUX_OPTS));
    expect(f.run.calls).toEqual([
      "systemctl --user daemon-reload",
      "loginctl enable-linger ada",
      "loginctl show-user ada -p Linger",
      "systemctl --user enable --now omp-ui-host.service",
    ]);
  });

  it("install refuses when linger cannot be proven and never enables the unit", async () => {
    const f = fakes();
    f.script("loginctl show-user ada -p Linger", { stdout: "Linger=no\n" });
    await expect(make(f).install(LINUX_OPTS)).rejects.toThrow("linger not enabled");
    expect(f.run.calls).not.toContain("systemctl --user enable --now omp-ui-host.service");
  });

  it("install converges: identical content is not rewritten, foreign content is refused", async () => {
    const f = fakes();
    f.script("loginctl show-user ada -p Linger", { stdout: "Linger=yes\n" });
    const sup = make(f);
    f.fs.files.set(UNIT, sup.render(LINUX_OPTS));
    let writes = 0;
    const write = f.fs.writeFile;
    f.fs.writeFile = async (...args) => {
      writes += 1;
      await write(...args);
    };
    await sup.install(LINUX_OPTS);
    expect(writes).toBe(0);

    f.fs.files.set(UNIT, "[Unit]\nDescription=my own thing\n");
    await expect(sup.install(LINUX_OPTS)).rejects.toThrow(`foreign supervisor definition at ${UNIT}`);
  });

  it("install surfaces a failing systemctl with its stderr", async () => {
    const f = fakes();
    f.script("systemctl --user daemon-reload", { code: 1, stderr: "Failed to connect to bus\n" });
    await expect(make(f).install(LINUX_OPTS)).rejects.toThrow(
      "systemctl --user daemon-reload failed (exit 1): Failed to connect to bus",
    );
  });

  it("status: absent without the unit file; installed reads is-active; foreign flagged", async () => {
    const f = fakes();
    const sup = make(f);
    expect(await sup.status()).toEqual({ kind: "absent" });

    f.fs.files.set(UNIT, sup.render(LINUX_OPTS));
    f.script("systemctl --user is-active omp-ui-host.service", { stdout: "active\n" });
    expect(await sup.status()).toEqual({ kind: "installed", running: true, foreign: false, path: UNIT, detail: "active" });

    f.script("systemctl --user is-active omp-ui-host.service", { code: 3, stdout: "failed\n" });
    f.fs.files.set(UNIT, "[Unit]\nDescription=other\n");
    expect(await sup.status()).toEqual({ kind: "installed", running: false, foreign: true, path: UNIT, detail: "failed" });
  });

  it("uninstall disables --now, removes, reloads; purge removes the named data root; absent is success", async () => {
    const f = fakes();
    const sup = make(f);
    f.fs.files.set(UNIT, sup.render(LINUX_OPTS));
    await sup.uninstall({ purgeData: true, dataRoot: LINUX_OPTS.dataRoot });
    expect(f.run.calls).toEqual([
      "systemctl --user disable --now omp-ui-host.service",
      "systemctl --user daemon-reload",
    ]);
    expect(f.fs.removed).toEqual([UNIT, LINUX_OPTS.dataRoot]);

    f.run.calls.length = 0;
    await sup.uninstall({ purgeData: false });
    expect(f.run.calls).toEqual([]);
  });

  it("uninstall preserves a foreign definition and stops before removing when disable fails", async () => {
    const f = fakes();
    const sup = make(f);
    f.fs.files.set(UNIT, "[Unit]\nDescription=other\n");
    await expect(sup.uninstall({ purgeData: false })).rejects.toThrow("foreign supervisor definition");
    expect(f.fs.files.has(UNIT)).toBe(true);

    f.fs.files.set(UNIT, sup.render(LINUX_OPTS));
    f.script("systemctl --user disable --now omp-ui-host.service", { code: 1, stderr: "busy" });
    await expect(sup.uninstall({ purgeData: false })).rejects.toThrow("disable --now");
    expect(f.fs.files.has(UNIT)).toBe(true);
  });

  it("systemdRunArgs names the reserved transient identity with the data root", () => {
    expect(systemdRunArgs(LINUX_OPTS)).toEqual([
      "--user",
      "--unit=omp-ui-host",
      "--property=Restart=no",
      "--collect",
      "--setenv=OMP_UI_DATA_DIR=/home/ada/.local/share/omp-ui",
      "--",
      "/home/ada/.local/bin/omp-ui",
      "serve",
    ]);
  });
});

const MAC_OPTS = {
  execPath: "/Users/ada/.local/bin/omp-ui",
  dataRoot: "/Users/ada/Library/Application Support/omp-ui",
  logDir: "/Users/ada/Library/Application Support/omp-ui/logs",
};

describe("launchd agent supervisor", () => {
  const PLIST = "/Users/ada/Library/LaunchAgents/ai.lankford.omp-ui.host.plist";
  const SERVICE = "gui/501/ai.lankford.omp-ui.host";
  const make = (f: Fakes) =>
    selectSupervisor({ run: f.run, fs: f.fs, home: "/Users/ada", platform: "darwin", uid: 501 });

  it("renders the exact plist with escaped paths and log files under logDir", () => {
    const sup = make(fakes());
    expect(sup.id).toBe("launchd-agent");
    expect(sup.definitionPath).toBe(PLIST);
    expect(sup.render({ ...MAC_OPTS, dataRoot: "/Users/ada/A&B", logDir: "/Users/ada/A&B/logs" })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "\t<key>Label</key>",
        "\t<string>ai.lankford.omp-ui.host</string>",
        "\t<key>ProgramArguments</key>",
        "\t<array>",
        "\t\t<string>/Users/ada/.local/bin/omp-ui</string>",
        "\t\t<string>serve</string>",
        "\t</array>",
        "\t<key>EnvironmentVariables</key>",
        "\t<dict>",
        "\t\t<key>OMP_UI_DATA_DIR</key>",
        "\t\t<string>/Users/ada/A&amp;B</string>",
        "\t</dict>",
        "\t<key>RunAtLoad</key>",
        "\t<true/>",
        "\t<key>KeepAlive</key>",
        "\t<dict>",
        "\t\t<key>SuccessfulExit</key>",
        "\t\t<false/>",
        "\t</dict>",
        "\t<key>ThrottleInterval</key>",
        "\t<integer>10</integer>",
        "\t<key>StandardOutPath</key>",
        "\t<string>/Users/ada/A&amp;B/logs/host.stdout.log</string>",
        "\t<key>StandardErrorPath</key>",
        "\t<string>/Users/ada/A&amp;B/logs/host.stderr.log</string>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
  });

  it("parses ours by Label and joins ProgramArguments; a foreign label is not ours", () => {
    const sup = make(fakes());
    expect(sup.parse(sup.render(MAC_OPTS))).toEqual({ ours: true, execStart: "/Users/ada/.local/bin/omp-ui serve" });
    const foreign =
      "<plist><dict><key>Label</key><string>com.other.agent</string><key>ProgramArguments</key>" +
      "<array><string>/usr/bin/other</string></array></dict></plist>";
    expect(sup.parse(foreign)).toEqual({ ours: false, execStart: "/usr/bin/other" });
    expect(sup.parse("<plist/>")).toEqual({ ours: false, execStart: null });
  });

  it("install writes then bootstraps into gui/<uid>", async () => {
    const f = fakes();
    const sup = make(f);
    await sup.install(MAC_OPTS);
    expect(f.fs.dirs).toEqual(["/Users/ada/Library/LaunchAgents"]);
    expect(f.fs.files.get(PLIST)).toBe(sup.render(MAC_OPTS));
    expect(f.run.calls).toEqual([`launchctl bootstrap gui/501 ${PLIST}`]);
  });

  it("install treats an already-bootstrapped agent as converged and kickstarts it", async () => {
    const f = fakes();
    f.script(`launchctl bootstrap gui/501 ${PLIST}`, { code: 37, stderr: "Bootstrap failed: 37: Operation already in progress" });
    const sup = make(f);
    f.fs.files.set(PLIST, sup.render(MAC_OPTS));
    await sup.install(MAC_OPTS);
    expect(f.run.calls).toEqual([
      `launchctl bootstrap gui/501 ${PLIST}`,
      `launchctl print ${SERVICE}`,
      `launchctl kickstart ${SERVICE}`,
    ]);
  });

  it("install boots out a changed definition first and fails when bootstrap fails for real", async () => {
    const f = fakes();
    const sup = make(f);
    f.fs.files.set(PLIST, sup.render({ ...MAC_OPTS, dataRoot: "/Users/ada/old" }));
    f.script(`launchctl bootstrap gui/501 ${PLIST}`, { code: 5, stderr: "Bootstrap failed: 5: Input/output error" });
    f.script(`launchctl print ${SERVICE}`, { code: 113 });
    await expect(sup.install(MAC_OPTS)).rejects.toThrow("launchctl bootstrap gui/501 failed (exit 5)");
    expect(f.run.calls[0]).toBe(`launchctl bootout ${SERVICE}`);
    expect(f.fs.files.get(PLIST)).toBe(sup.render(MAC_OPTS));
  });

  it("status reads launchctl print state", async () => {
    const f = fakes();
    const sup = make(f);
    expect(await sup.status()).toEqual({ kind: "absent" });
    f.fs.files.set(PLIST, sup.render(MAC_OPTS));
    f.script(`launchctl print ${SERVICE}`, { stdout: `${SERVICE} = {\n\tactive count = 1\n\tstate = running\n}\n` });
    expect(await sup.status()).toEqual({ kind: "installed", running: true, foreign: false, path: PLIST, detail: "running" });
    f.script(`launchctl print ${SERVICE}`, { stdout: `${SERVICE} = {\n\tstate = waiting\n}\n` });
    expect((await sup.status()) as object).toMatchObject({ running: false, detail: "waiting" });
    f.script(`launchctl print ${SERVICE}`, { code: 113, stderr: "Could not find service" });
    expect((await sup.status()) as object).toMatchObject({ running: false, detail: "not loaded" });
  });

  it("uninstall boots out, verifies unloaded, removes the plist; still loaded is an error", async () => {
    const f = fakes();
    const sup = make(f);
    f.fs.files.set(PLIST, sup.render(MAC_OPTS));
    f.script(`launchctl print ${SERVICE}`, { code: 113 });
    await sup.uninstall({ purgeData: false });
    expect(f.run.calls).toEqual([`launchctl bootout ${SERVICE}`, `launchctl print ${SERVICE}`]);
    expect(f.fs.files.has(PLIST)).toBe(false);

    f.fs.files.set(PLIST, sup.render(MAC_OPTS));
    f.script(`launchctl print ${SERVICE}`, { code: 0, stdout: "state = running" });
    await expect(sup.uninstall({ purgeData: false })).rejects.toThrow("still loaded");
    expect(f.fs.files.has(PLIST)).toBe(true);
  });
});

const WIN_OPTS = {
  execPath: "C:\\Users\\ada\\AppData\\Local\\omp-ui-host\\bin\\omp-ui.exe",
  dataRoot: "C:\\Users\\ada\\AppData\\Local\\omp-ui",
  logDir: "C:\\Users\\ada\\AppData\\Local\\omp-ui\\logs",
};

describe("windows task supervisor", () => {
  const TN = "\\LankfordAI\\omp-ui Host";
  const QUERY_XML = `schtasks /Query /TN ${TN} /XML`;
  const make = (f: Fakes) =>
    selectSupervisor({
      run: f.run,
      fs: f.fs,
      home: "C:\\Users\\ada",
      platform: "win32",
      user: "ada",
      env: { USERDOMAIN: "WORKSTATION" },
      tmpDir: "C:\\Temp",
    });

  it("renders the exact Task Scheduler XML for the current user at logon", () => {
    const sup = make(fakes());
    expect(sup.id).toBe("windows-task");
    expect(sup.definitionPath).toBe(TN);
    expect(sup.render(WIN_OPTS)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        "  <RegistrationInfo>",
        "    <Description>omp-ui persistent host</Description>",
        "    <URI>\\LankfordAI\\omp-ui Host</URI>",
        "  </RegistrationInfo>",
        "  <Triggers>",
        "    <LogonTrigger>",
        "      <Enabled>true</Enabled>",
        "      <UserId>WORKSTATION\\ada</UserId>",
        "    </LogonTrigger>",
        "  </Triggers>",
        "  <Principals>",
        '    <Principal id="Author">',
        "      <UserId>WORKSTATION\\ada</UserId>",
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
        "      <Command>C:\\Users\\ada\\AppData\\Local\\omp-ui-host\\bin\\omp-ui.exe</Command>",
        "      <Arguments>serve</Arguments>",
        "    </Exec>",
        "  </Actions>",
        "</Task>",
        "",
      ].join("\r\n"),
    );
  });

  it("parses ours by Description and joins Command + Arguments", () => {
    const sup = make(fakes());
    expect(sup.parse(sup.render(WIN_OPTS))).toEqual({ ours: true, execStart: `${WIN_OPTS.execPath} serve` });
    expect(sup.parse("<Task><RegistrationInfo><Description>x</Description></RegistrationInfo><Actions><Exec><Command>C:\\o.exe</Command></Exec></Actions></Task>")).toEqual({
      ours: false,
      execStart: "C:\\o.exe",
    });
  });

  it("install writes UTF-16 XML to a temp file, creates with /F, removes the file, then runs the task", async () => {
    const f = fakes();
    f.script(QUERY_XML, { code: 1, stderr: "ERROR: The system cannot find the file specified." });
    const sup = make(f);
    await sup.install(WIN_OPTS);
    const create = f.run.calls[1];
    const file = create.match(/\/XML (.+) \/F$/)?.[1];
    expect(file).toMatch(/^C:\\Temp\\omp-ui-host-\d+\.task\.xml$/);
    expect(f.run.calls).toEqual([QUERY_XML, `schtasks /Create /TN ${TN} /XML ${file} /F`, `schtasks /Run /TN ${TN}`]);
    expect(f.fs.removed).toEqual([file]);
  });

  it("install stores the XML as BOM-prefixed UTF-16LE", async () => {
    const f = fakes();
    f.script(QUERY_XML, { code: 1 });
    let written: Uint8Array | string | undefined;
    f.fs.writeFile = async (_p, data) => {
      written = data;
    };
    const sup = make(f);
    await sup.install(WIN_OPTS);
    expect(Buffer.from(written as Uint8Array).toString("utf16le")).toBe(`\ufeff${sup.render(WIN_OPTS)}`);
  });

  it("install refuses a foreign task at the reserved path and removes the temp file when /Create fails", async () => {
    const f = fakes();
    f.script(QUERY_XML, { code: 0, stdout: "<Task><RegistrationInfo><Description>theirs</Description></RegistrationInfo></Task>" });
    await expect(make(f).install(WIN_OPTS)).rejects.toThrow(`foreign supervisor definition at ${TN}`);

    const g = fakes();
    const file = `C:\\Temp\\omp-ui-host-${process.pid}.task.xml`;
    g.script(QUERY_XML, { code: 1 });
    g.script(`schtasks /Create /TN ${TN} /XML ${file} /F`, { code: 1, stderr: "ERROR: Access is denied." });
    await expect(make(g).install(WIN_OPTS)).rejects.toThrow("schtasks /Create failed (exit 1): ERROR: Access is denied.");
    expect(g.fs.removed).toEqual([file]);
    expect(g.fs.files.size).toBe(0);
    expect(g.run.calls).not.toContain(`schtasks /Run /TN ${TN}`);
  });

  it("status: absent when /Query fails; running from the verbose LIST Status line", async () => {
    const f = fakes();
    const sup = make(f);
    f.script(QUERY_XML, { code: 1 });
    expect(await sup.status()).toEqual({ kind: "absent" });

    f.script(QUERY_XML, { code: 0, stdout: sup.render(WIN_OPTS) });
    f.script(`schtasks /Query /TN ${TN} /FO LIST /V`, {
      stdout: `\r\nFolder: \\LankfordAI\r\nHostName:      ADA-PC\r\nTaskName:      ${TN}\r\nStatus:        Running\r\nLogon Mode:    Interactive only\r\n`,
    });
    expect(await sup.status()).toEqual({ kind: "installed", running: true, foreign: false, path: TN, detail: "Running" });

    f.script(`schtasks /Query /TN ${TN} /FO LIST /V`, { stdout: `TaskName: ${TN}\r\nStatus: Ready\r\n` });
    expect((await sup.status()) as object).toMatchObject({ running: false, detail: "Ready" });
  });

  it("uninstall deletes only an owned task; absent is success; purge removes the data root", async () => {
    const f = fakes();
    const sup = make(f);
    f.script(QUERY_XML, { code: 0, stdout: sup.render(WIN_OPTS) });
    await sup.uninstall({ purgeData: true, dataRoot: WIN_OPTS.dataRoot });
    expect(f.run.calls).toEqual([QUERY_XML, `schtasks /Delete /TN ${TN} /F`]);
    expect(f.fs.removed).toEqual([WIN_OPTS.dataRoot]);

    f.run.calls.length = 0;
    f.script(QUERY_XML, { code: 1 });
    await sup.uninstall({ purgeData: false });
    expect(f.run.calls).toEqual([QUERY_XML]);

    f.script(QUERY_XML, { code: 0, stdout: "<Task><RegistrationInfo><Description>theirs</Description></RegistrationInfo></Task>" });
    await expect(sup.uninstall({ purgeData: false })).rejects.toThrow("foreign supervisor definition");
  });
});

describe("selectSupervisor on an unsupported platform", () => {
  it("answers unsupported status and rejects install/uninstall", async () => {
    const f = fakes();
    const sup = selectSupervisor({ run: f.run, fs: f.fs, home: "/home/ada", platform: "freebsd" });
    expect(sup.id).toBe("unsupported");
    expect(await sup.status()).toEqual({ kind: "unsupported", reason: "unsupported platform: freebsd" });
    await expect(sup.install(LINUX_OPTS)).rejects.toThrow("unsupported platform: freebsd");
    await expect(sup.uninstall({ purgeData: false })).rejects.toThrow("unsupported platform: freebsd");
    expect(f.run.calls).toEqual([]);
  });
});
