import {
  CH,
  spawnOmpTui,
  spawnShell,
  type ConsoleProgram,
  type PtyHandle,
} from "@omp-ui/core";

export interface ShellHostDependencies {
  getOmpPath: () => string | null;
  send: (channel: string, ...args: unknown[]) => void;
  /**
   * The dev/test spawn gate's model selector (docs/development.md). The handoff
   * TUI runs real turns, so a gated app instance gates this child too.
   */
  getOmpModelArg?: () => string | null;
}

/**
 * How long a killed console program gets to exit on the hangup before SIGKILL.
 * A shell that ignores SIGHUP (`trap '' HUP`, a zsh `TRAPHUP`) keeps running
 * while omp-ui holds its PTY open, and node-pty's SIGTERM never ends an
 * interactive zsh — the same trap fleet terminals escalate past (issue #1004).
 */
const KILL_GRACE_MS = 2_000;

interface HostedShell {
  handle: PtyHandle;
  detachData: () => void;
  /** Armed by kill; forces the end if the program outlives the hangup. */
  escalation: NodeJS.Timeout | undefined;
}

/** Owns console-drawer programs independently of live OMP session children. */
export class ShellHost {
  private readonly shells = new Map<string, HostedShell>();

  constructor(private readonly deps: ShellHostDependencies) {}

  launch(
    tabId: string,
    cwd: string,
    cols: number,
    rows: number,
    program: ConsoleProgram = "shell",
  ): void {
    this.kill(tabId);
    const handle =
      program === "omp-tui"
        ? spawnOmpTui({
            id: tabId,
            cwd,
            cols,
            rows,
            ompPath: this.requireOmpPath(),
            model: this.deps.getOmpModelArg?.() ?? undefined,
          })
        : spawnShell({ id: tabId, cwd, cols, rows });
    const detachData = handle.onData((data) => this.deps.send(CH.onShellData, tabId, data));
    const hosted: HostedShell = { handle, detachData, escalation: undefined };
    this.shells.set(tabId, hosted);
    handle.onExit(({ exitCode }) => {
      // A killed program's exit still disarms its own escalation.
      clearTimeout(hosted.escalation);
      if (this.shells.get(tabId) !== hosted) return;
      this.shells.delete(tabId);
      hosted.detachData();
      this.deps.send(CH.onShellExit, tabId, exitCode);
    });
  }

  write(tabId: string, data: string): void {
    this.shells.get(tabId)?.handle.write(data);
  }

  resize(tabId: string, cols: number, rows: number): void {
    this.shells.get(tabId)?.handle.resize(cols, rows);
  }

  kill(tabId: string): void {
    const shell = this.shells.get(tabId);
    if (!shell) return;
    this.shells.delete(tabId);
    // Detach before kill so final output cannot reach a successor or closed drawer.
    shell.detachData();
    shell.handle.kill();
    // ConPTY's kill already terminates; it has no signal to escalate to.
    if (process.platform === "win32") return;
    // Unref'd: a quit never waits on it, and the exiting app closes the PTY,
    // which ends even a hangup-ignoring shell.
    shell.escalation = setTimeout(() => shell.handle.kill("SIGKILL"), KILL_GRACE_MS);
    shell.escalation.unref();
  }

  killAll(): void {
    for (const tabId of [...this.shells.keys()]) this.kill(tabId);
  }

  private requireOmpPath(): string {
    const ompPath = this.deps.getOmpPath();
    if (ompPath) return ompPath;
    throw new Error(
      "omp binary not found (looked in $OMP_UI_OMP_PATH, PATH, ~/.bun/bin, /usr/local/bin, ~/.local/bin)",
    );
  }
}
