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
 * The close loop proper. Linux enumerates /proc/self/fd (exact); elsewhere a
 * ulimit-bounded brute close (macOS has no /proc; closing an unopened fd is a
 * harmless, silenced error). argv is forwarded via "$@" — never
 * string-interpolated — so paths with spaces and empty args survive verbatim.
 *
 * MUST stay free of single quotes: FD_SWEEP_SCRIPT embeds this body inside
 * '…' for the bash re-exec below (hence "" not '' in the limit case).
 */
const SWEEP_BODY = [
  "if [ -d /proc/self/fd ]; then",
  "  for fd in /proc/self/fd/*; do",
  "    n=${fd##*/}",
  '    case $n in 0|1|2) ;; *) eval "exec $n>&-" 2>/dev/null ;; esac',
  "  done",
  "else",
  "  limit=$(ulimit -n 2>/dev/null)",
  '  case $limit in ""|*[!0-9]*) limit=4096 ;; esac',
  "  i=3",
  '  while [ "$i" -lt "$limit" ]; do eval "exec $i>&-" 2>/dev/null; i=$((i+1)); done',
  "fi",
  'exec "$@"',
].join("\n");

/**
 * POSIX sh: close every inherited fd above stderr, then replace this shell
 * with the real command.
 *
 * `exec N>&-` with N >= 10 is POSIX (IO_NUMBER is "one or more digits") but
 * dash rejects it: it parses `exec 10>&-` as `exec 10` plus a redirection,
 * PATH-searches "10", and — exec being a special builtin — kills the whole
 * script with 127 before the real command ever runs. On dash-as-/bin/sh
 * systems (Debian/Ubuntu) that turned the sweep into a spawn-breaker the
 * moment any inherited fd hit double digits, which is precisely the Electron
 * scenario the sweep exists for.
 *
 * So: probe multi-digit redirection support in a throwaway subshell (dup, not
 * close, so success has no side effect; failure is confined to the subshell).
 * Shells that pass (bash, busybox ash, macOS sh) run the sweep in place.
 * Shells that fail re-exec into bash — guaranteed present on every
 * dash-as-sh distro (bash is Essential on Debian/Ubuntu). If neither works,
 * close the single-digit fds (safe everywhere, verified non-fatal on dash
 * even for unopened fds) and exec anyway: a partial sweep must never cost a
 * session spawn.
 */
export const FD_SWEEP_SCRIPT = [
  'if (eval "exec 22>&2") 2>/dev/null; then',
  SWEEP_BODY,
  "fi",
  "if command -v bash >/dev/null 2>&1; then",
  `  exec bash -c '${SWEEP_BODY}' omp-fd-sweep "$@"`,
  "fi",
  'for n in 3 4 5 6 7 8 9; do eval "exec $n>&-" 2>/dev/null; done',
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
