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

export const LAUNCHD_LABEL = "ai.lankford.omp-ui.host";

export interface LaunchdDeps {
  run: RunCommand;
  fs: SupervisorFs;
  home: string;
  /** The `gui/<uid>` domain the agent is bootstrapped into. */
  uid: number;
}

/**
 * `~/Library/LaunchAgents/ai.lankford.omp-ui.host.plist`: login-to-logout
 * lifetime with no elevation (#456). Launchd has no user-level linger; the
 * CLI states that limit instead of installing a LaunchDaemon.
 */
export class LaunchdAgentSupervisor implements Supervisor {
  readonly id = "launchd-agent";
  readonly definitionPath: string;

  constructor(private readonly deps: LaunchdDeps) {
    this.definitionPath = path.posix.join(deps.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  }

  render(opts: RenderOpts): string {
    const s = (v: string): string => `<string>${xmlEscape(v)}</string>`;
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "\t<key>Label</key>",
      `\t${s(LAUNCHD_LABEL)}`,
      "\t<key>ProgramArguments</key>",
      "\t<array>",
      `\t\t${s(opts.execPath)}`,
      `\t\t${s("serve")}`,
      "\t</array>",
      "\t<key>EnvironmentVariables</key>",
      "\t<dict>",
      "\t\t<key>OMP_UI_DATA_DIR</key>",
      `\t\t${s(opts.dataRoot)}`,
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
      `\t${s(path.posix.join(opts.logDir, "host.stdout.log"))}`,
      "\t<key>StandardErrorPath</key>",
      `\t${s(path.posix.join(opts.logDir, "host.stderr.log"))}`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
  }

  parse(existing: string): { ours: boolean; execStart: string | null } {
    const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(existing);
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(existing);
    let execStart: string | null = null;
    if (args) {
      const words = [...args[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => xmlUnescape(m[1]));
      if (words.length > 0) execStart = words.join(" ");
    }
    return { ours: label !== null && xmlUnescape(label[1]) === LAUNCHD_LABEL, execStart };
  }

  async install(opts: RenderOpts): Promise<void> {
    const { run, fs } = this.deps;
    const existing = await fs.readFile(this.definitionPath);
    if (existing !== null && !this.parse(existing).ours) throw foreignDefinition(this.definitionPath);
    const rendered = this.render(opts);
    if (existing !== rendered) {
      await fs.mkdir(path.posix.dirname(this.definitionPath));
      await fs.writeFile(this.definitionPath, rendered, 0o644);
      // A changed definition only takes effect after the loaded one leaves.
      if (existing !== null) await run("launchctl", ["bootout", this.service()]);
    }
    const bootstrap = await run("launchctl", ["bootstrap", this.domain(), this.definitionPath]);
    if (bootstrap.code !== 0) {
      // Already bootstrapped is convergence, not failure; anything else is.
      const loaded = await run("launchctl", ["print", this.service()]);
      if (loaded.code !== 0) must(bootstrap, `launchctl bootstrap ${this.domain()}`);
      must(await run("launchctl", ["kickstart", this.service()]), `launchctl kickstart ${this.service()}`);
    }
  }

  async status(): Promise<SupervisorStatus> {
    const existing = await this.deps.fs.readFile(this.definitionPath);
    if (existing === null) return { kind: "absent" };
    const printed = await this.deps.run("launchctl", ["print", this.service()]);
    const state = /^\s*state = (\S+)/m.exec(printed.stdout)?.[1];
    return {
      kind: "installed",
      running: printed.code === 0 && (state === undefined || state === "running"),
      foreign: !this.parse(existing).ours,
      path: this.definitionPath,
      detail: state ?? (printed.code === 0 ? "loaded" : "not loaded"),
    };
  }

  async uninstall(opts: UninstallOpts): Promise<void> {
    const { run, fs } = this.deps;
    const existing = await fs.readFile(this.definitionPath);
    if (existing !== null) {
      if (!this.parse(existing).ours) throw foreignDefinition(this.definitionPath);
      await run("launchctl", ["bootout", this.service()]);
      const loaded = await run("launchctl", ["print", this.service()]);
      if (loaded.code === 0) throw new Error(`launchctl bootout ${this.service()} failed: still loaded`);
      await fs.rm(this.definitionPath, { recursive: false });
    }
    if (opts.purgeData) await fs.rm(opts.dataRoot, { recursive: true });
  }

  private domain(): string {
    return `gui/${this.deps.uid}`;
  }

  private service(): string {
    return `${this.domain()}/${LAUNCHD_LABEL}`;
  }
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
