import * as fs from "node:fs";
import * as path from "node:path";
import * as pty from "node-pty";
import { batched } from "./pty-batch";

export interface PtyHandle {
  readonly id: string;
  onData(cb: (data: Buffer) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
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
    // omp may be a runtime shim (e.g. #!/usr/bin/env bun) — a .desktop/AppImage
    // launch can lack its dir on PATH, so expose the resolved binary's dir to
    // the child regardless of the parent environment.
    env: {
      ...process.env,
      PATH: [path.dirname(opts.ompPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    },
    encoding: null, // raw Buffers, not decoded strings
  });

  // Batched in core (5 ms coalescing) so every transport inherits it.
  return batched({
    id: opts.id,
    // node-pty's typings declare `onData: IEvent<string>` even with
    // `encoding: null` — the runtime emits Buffers, so bridge the known
    // typing gap via `unknown` (harmless if the types are ever fixed).
    onData: (cb) => (proc.onData as unknown as pty.IEvent<Buffer>)(cb),
    onExit: (cb) => proc.onExit(cb),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: () => proc.kill(),
  });
}
