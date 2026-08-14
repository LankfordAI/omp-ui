/**
 * Issue #185 — Electron/Chromium opens cache and storage handles without
 * O_CLOEXEC (GPUCache, DawnWebGPUCache/DawnGraphiteCache, Session Storage
 * leveldb, v8_context_snapshot.bin, the AppImage mount). Every child spawned
 * by the main process pins ~15–25 of those fds for its whole lifetime.
 * Node cannot fcntl fds it does not own, and closing or flagging them in the
 * parent would corrupt Chromium's caches or break its own helper-process
 * inheritance — so the sweep runs in the child, between spawn and exec,
 * where it only ever touches its own inherited table.
 */

/** A command plus argv, ready for child_process.spawn or node-pty. */
export interface SpawnCommand {
  file: string;
  args: string[];
}

/**
 * POSIX sh: close every inherited fd above stderr, then replace this shell
 * with the real command. Linux enumerates /proc/self/fd (exact); elsewhere a
 * ulimit-bounded brute close (macOS has no /proc; closing an unopened fd is a
 * harmless, silenced error). argv is forwarded via "$@" — never
 * string-interpolated — so paths with spaces and empty args survive verbatim.
 */
export const FD_SWEEP_SCRIPT = [
  "if [ -d /proc/self/fd ]; then",
  "  for fd in /proc/self/fd/*; do",
  "    n=${fd##*/}",
  '    case $n in 0|1|2) ;; *) eval "exec $n>&-" 2>/dev/null ;; esac',
  "  done",
  "else",
  "  limit=$(ulimit -n 2>/dev/null)",
  "  case $limit in ''|*[!0-9]*) limit=4096 ;; esac",
  "  i=3",
  '  while [ "$i" -lt "$limit" ]; do eval "exec $i>&-" 2>/dev/null; i=$((i+1)); done',
  "fi",
  'exec "$@"',
].join("\n");

/**
 * Wraps `file args` in the fd sweep on Unix. Identity on Windows: ConPTY and
 * Windows handle inheritance do not share this defect (issue evidence is
 * Linux; pty.ts already special-cases ConPTY elsewhere).
 */
export function withFdSweep(
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): SpawnCommand {
  if (platform === "win32") return { file, args: [...args] };
  return { file: "/bin/sh", args: ["-c", FD_SWEEP_SCRIPT, "omp-fd-sweep", file, ...args] };
}
