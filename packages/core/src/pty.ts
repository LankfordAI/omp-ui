import * as fs from "node:fs";
import * as pty from "node-pty";
import { ompChildEnv } from "./omp-process";
import { batched } from "./pty-batch";

export interface PtyHandle {
  readonly id: string;
  /** Returns an unsubscribe — teardown must detach so a dying process cannot deliver into its successor. */
  onData(cb: (data: Buffer) => void): () => void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Default is adapter-owned. Unix signals are forwarded; ConPTY is terminate-only. */
  kill(signal?: string): void;
}

/** ConPTY has no Unix-signal escalation; its kill operation only terminates. */
export function normalizePtyKillSignal(
  signal: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return platform === "win32" ? undefined : signal;
}

/** node-pty ignores `encoding: null` on Windows and emits UTF-8 strings. */
export function ptyChunkToBuffer(data: string | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
}

/** Batched in core (5 ms coalescing) so every transport inherits it. */
function adapt(id: string, proc: pty.IPty): PtyHandle {
  return batched({
    id,
    onData: (cb) => {
      const disposable = proc.onData((data) => cb(ptyChunkToBuffer(data)));
      return () => disposable.dispose();
    },
    onExit: (cb) => proc.onExit(cb),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: (signal) => proc.kill(normalizePtyKillSignal(signal)),
  });
}

export function spawnOmp(opts: {
  id: string;
  cwd: string;
  /** Absolute lineage dir (ADR-0003), passed to omp as --session-dir. */
  lineageDir: string;
  ompPath: string;
  resumeSessionId?: string;
  cols: number;
  rows: number;
  advisor?: boolean;
  /** Extra `--config` overlays — the advisor-model pin (see advisor-overlay.ts). */
  configOverlays?: string[];
}): PtyHandle {
  const args = ["--cwd", opts.cwd, "--session-dir", opts.lineageDir];
  if (opts.resumeSessionId) args.push(`--resume=${opts.resumeSessionId}`);
  if (opts.advisor) args.push("--advisor");
  for (const overlay of opts.configOverlays ?? []) args.push("--config", overlay);

  fs.mkdirSync(opts.lineageDir, { recursive: true });

  const proc = pty.spawn(opts.ompPath, args, {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: ompChildEnv(opts.ompPath),
    encoding: null, // raw Buffers, not decoded strings
  });

  return adapt(opts.id, proc);
}

/** Default console shell; Windows intentionally stays on COMSPEC for this preview. */
export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  return platform === "win32"
    ? { file: env.COMSPEC ?? "cmd.exe", args: [] }
    : { file: env.SHELL ?? "/bin/bash", args: ["-l"] };
}

/** The user's login shell for the console drawer's terminal (issue #42). */
export function spawnShell(opts: {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
}): PtyHandle {
  const { file, args } = defaultShell();
  const proc = pty.spawn(file, args, {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: { ...process.env },
    encoding: null, // raw Buffers, same as spawnOmp
  });
  return adapt(opts.id, proc);
}
