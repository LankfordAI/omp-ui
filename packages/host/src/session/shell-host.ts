import {
  CH,
  defaultShell,
  spawnOmpTui,
  spawnShell,
  type ConsoleProgram,
  type PtyHandle,
} from "@omp-ui/core";
import type { ChildrenLedger } from "../authority/children-ledger";

export interface ShellHostDependencies {
  getOmpPath: () => string | null;
  send: (channel: string, ...args: unknown[]) => void;
  /**
   * The dev/test spawn gate's model selector (docs/development.md). The handoff
   * TUI runs real turns, so a gated app instance gates this child too.
   */
  getOmpModelArg?: () => string | null;
  /** The children ledger (#450): console programs are children too. Absent in Electron main and tests. */
  ledger?: ChildrenLedger;
}

/** Owns console-drawer programs independently of live OMP session children. */
export class ShellHost {
  private readonly shells = new Map<string, { handle: PtyHandle; detachData: () => void }>();

  constructor(private readonly deps: ShellHostDependencies) {}

  launch(
    tabId: string,
    cwd: string,
    cols: number,
    rows: number,
    program: ConsoleProgram = "shell",
  ): void {
    this.kill(tabId);
    let executable: string;
    let handle: PtyHandle;
    if (program === "omp-tui") {
      executable = this.requireOmpPath();
      handle = spawnOmpTui({
        id: tabId,
        cwd,
        cols,
        rows,
        ompPath: executable,
        model: this.deps.getOmpModelArg?.() ?? undefined,
      });
    } else {
      executable = defaultShell().file;
      handle = spawnShell({ id: tabId, cwd, cols, rows });
    }
    const ledger = this.deps.ledger;
    // Before the handle is published: a crash here must still leave the child
    // findable. node-pty children lead their own group; ConPTY has none.
    ledger?.add({
      pid: handle.pid,
      pgid: process.platform === "win32" ? 0 : handle.pid,
      bootId: ledger.bootId(),
      procStartMs: Date.now(),
      executable,
      kind: "shell",
      tabId,
      lineageDir: "",
    });
    const detachData = handle.onData((data) => this.deps.send(CH.onShellData, tabId, data));
    this.shells.set(tabId, { handle, detachData });
    handle.onExit(({ exitCode }) => {
      ledger?.remove(handle.pid);
      const current = this.shells.get(tabId);
      if (!current || current.handle !== handle) return;
      this.shells.delete(tabId);
      current.detachData();
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
