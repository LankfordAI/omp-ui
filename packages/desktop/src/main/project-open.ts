import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

import type { ProjectOpenAvailability, ProjectOpenTarget } from "@omp-ui/core";
import { app, shell } from "electron";

const VSCODE_PROTOCOL_URL = "vscode://file/";

export interface ProjectOpenHost {
  getApplicationNameForProtocol(url: string): string;
  openExternal(url: string): Promise<void>;
  openPath(projectPath: string): Promise<string>;
  /** First PATH entry holding an executable `name` (exact filename,
   *  extension included on Windows), or null. */
  findExecutable(name: string): string | null;
  /** Short-lived launcher (macOS `open`, Windows `wt`): resolves on
   *  exit code 0, rejects on spawn error, nonzero exit, or signal. */
  runLauncher(file: string, args: string[], cwd: string): Promise<void>;
  /** Long-lived terminal process: detached + unref'd; resolves on the
   *  'spawn' event, rejects on 'error'. Never waits for exit. */
  spawnDetached(file: string, args: string[], cwd: string): Promise<void>;
}

const electronHost: ProjectOpenHost = {
  getApplicationNameForProtocol: (url) => app.getApplicationNameForProtocol(url),
  openExternal: (url) => shell.openExternal(url),
  openPath: (projectPath) => shell.openPath(projectPath),
  findExecutable: (name) => {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (dir === "") continue;
      const candidate = path.join(dir, name);
      try {
        if (!existsSync(candidate)) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  },
  // Executor form (not Promise.withResolvers): the node tsconfig lib is
  // ES2022, same convention as live-entry.ts.
  runLauncher: (file, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd, stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${file} exited with ${code ?? `signal ${signal}`}`));
      });
    }),
  spawnDetached: (file, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd, detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    }),
};

interface LinuxTerminal {
  name: string;
  args(projectPath: string): string[];
}

const LINUX_TERMINALS: readonly LinuxTerminal[] = [
  { name: "gnome-terminal", args: (p) => [`--working-directory=${p}`] },
  // GNOME's current default (Fedora 41+); the GNOME hint still names
  // gnome-terminal, and a miss there falls through to this entry.
  { name: "ptyxis", args: (p) => ["--new-window", `--working-directory=${p}`] },
  { name: "konsole", args: (p) => ["--workdir", p] },
  { name: "xfce4-terminal", args: (p) => [`--working-directory=${p}`] },
  { name: "alacritty", args: (p) => ["--working-directory", p] },
  { name: "kitty", args: (p) => ["--directory", p] },
  { name: "wezterm", args: (p) => ["start", "--cwd", p] },
  { name: "foot", args: (p) => [`--working-directory=${p}`] },
  // Debian's admin-configured wrapper: no portable workdir flag, so it
  // relies on the spawn cwd alone (last: weakest contract).
  { name: "x-terminal-emulator", args: () => [] },
];

const DESKTOP_HINTS: Record<string, string> = {
  GNOME: "gnome-terminal",
  KDE: "konsole",
  XFCE: "xfce4-terminal",
};

/** Builds a stable-VS-Code protocol URL without treating any path segment as URL syntax. */
export function vscodeProjectUrl(projectPath: string): string {
  let normalized = projectPath.replaceAll("\\", "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;

  const segments = normalized.split("/").map((segment, index) => {
    if (index === 1 && /^[A-Za-z]:$/.test(segment)) {
      return `${segment[0].toLowerCase()}:`;
    }
    return encodeURIComponent(segment);
  });

  // windowId=_blank opens the folder in a NEW window (VS Code >= 1.70);
  // older builds ignore the unknown param and reuse the active window.
  return `vscode://file${segments.join("/")}?windowId=_blank`;
}


export class ProjectOpener {
  private vsCodeAvailable: boolean | undefined;
  private terminalAvailable: boolean | undefined;

  constructor(
    private readonly host: ProjectOpenHost = electronHost,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  availability(): ProjectOpenAvailability {
    if (this.vsCodeAvailable === undefined) {
      try {
        this.vsCodeAvailable =
          this.host.getApplicationNameForProtocol(VSCODE_PROTOCOL_URL) !== "";
      } catch {
        this.vsCodeAvailable = false;
      }
    }
    if (this.terminalAvailable === undefined) {
      try {
        this.terminalAvailable =
          this.platform === "linux"
            ? this.resolveLinuxTerminal() !== null
            : true; // macOS Terminal.app and Windows ConHost always exist
      } catch {
        this.terminalAvailable = false;
      }
    }
    return { vsCode: this.vsCodeAvailable, terminal: this.terminalAvailable };
  }

  async open(projectPath: string, target: ProjectOpenTarget): Promise<void> {
    switch (target) {
      case "vscode":
        await this.openInVsCode(projectPath);
        return;
      case "files":
        await this.openInFiles(projectPath);
        return;
      case "terminal":
        await this.openInTerminal(projectPath);
        return;
      default:
        throw new Error(`Unknown project open target: ${String(target)}`);
    }
  }

  private resolveLinuxTerminal(): { file: string; terminal: LinuxTerminal } | null {
    const hinted = (this.env.XDG_CURRENT_DESKTOP ?? "")
      .split(":")
      .map((segment) => DESKTOP_HINTS[segment.toUpperCase()])
      .find((name) => name !== undefined);
    if (hinted !== undefined) {
      const terminal = LINUX_TERMINALS.find((t) => t.name === hinted)!;
      const file = this.host.findExecutable(terminal.name);
      if (file !== null) return { file, terminal };
    }
    for (const terminal of LINUX_TERMINALS) {
      const file = this.host.findExecutable(terminal.name);
      if (file !== null) return { file, terminal };
    }
    return null;
  }

  private async openInTerminal(projectPath: string): Promise<void> {
    try {
      if (this.platform === "darwin") {
        await this.host.runLauncher("open", ["-a", "Terminal", projectPath], projectPath);
        return;
      }
      if (this.platform === "win32") {
        if (this.host.findExecutable("wt.exe") !== null) {
          await this.host.runLauncher("wt.exe", ["-d", projectPath], projectPath);
          return;
        }
        // ConHost fallback: `start` opens a new console window whose
        // working directory is the spawn cwd. No quoted args, so the
        // `start` title-eats-first-quoted-arg trap never applies.
        await this.host.spawnDetached("cmd.exe", ["/c", "start", "cmd.exe"], projectPath);
        return;
      }
      const resolved = this.resolveLinuxTerminal();
      if (resolved === null) {
        throw new Error(
          `No terminal application is available to open "${projectPath}".`,
        );
      }
      // Known accepted gap: gnome-terminal is itself a client that exits
      // after messaging its server; a post-spawn server-side failure cannot
      // be observed. Spawn-event success is the honest boundary here.
      await this.host.spawnDetached(
        resolved.file,
        resolved.terminal.args(projectPath),
        projectPath,
      );
    } catch (cause) {
      // The cached probe is now suspect (terminal uninstalled, PATH
      // changed) — mirror the VS Code failure contract.
      this.terminalAvailable = undefined;
      if (
        cause instanceof Error &&
        cause.message.startsWith("No terminal application")
      ) {
        throw cause;
      }
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Could not open "${projectPath}" in a terminal: ${detail}.`, {
        cause,
      });
    }
  }

  private async openInVsCode(projectPath: string): Promise<void> {
    if (!this.availability().vsCode) {
      throw new Error(
        `VS Code is not available to open "${projectPath}". Open the project in Files instead.`,
      );
    }

    const url = vscodeProjectUrl(projectPath);
    let firstCause: unknown;
    try {
      await this.host.openExternal(url);
      return;
    } catch (cause) {
      firstCause = cause;
    }

    this.vsCodeAvailable = undefined;
    if (this.availability().vsCode) {
      try {
        await this.host.openExternal(url);
        return;
      } catch (cause) {
        this.vsCodeAvailable = undefined;
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `Could not open "${projectPath}" in VS Code: ${detail}. Open the project in Files instead.`,
          { cause },
        );
      }
    }

    this.vsCodeAvailable = undefined;
    const detail = firstCause instanceof Error ? firstCause.message : String(firstCause);
    throw new Error(
      `Could not open "${projectPath}" in VS Code: ${detail}. Open the project in Files instead.`,
      { cause: firstCause },
    );
  }

  private async openInFiles(projectPath: string): Promise<void> {
    let failure: string;
    try {
      failure = await this.host.openPath(projectPath);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Could not open "${projectPath}" in the system file manager: ${detail}.`,
        { cause },
      );
    }
    if (failure !== "") {
      throw new Error(
        `Could not open "${projectPath}" in the system file manager: ${failure}.`,
      );
    }
  }
}
