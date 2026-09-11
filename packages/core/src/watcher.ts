import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";

export type LineageEvent = { kind: "session-file"; filePath: string } | { kind: "vanished" };

/**
 * Watches one lineage dir for session-file activity (100 ms debounce).
 * Emits `session-file` for `*.jsonl` entries only — `.bak` orphans, the
 * `.draft-only-session` marker, and extension-less artifact dirs never match.
 * Watcher error / dir deleted → `vanished`. Returns a dispose function.
 */
export function watchLineageDir(absDir: string, onEvent: (e: LineageEvent) => void): () => void {
  let watcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let gone = false;
  const pending = new Set<string>();

  // Idempotent teardown: a vanished watcher must not keep its fd — on some
  // platforms a deleted dir never produces an 'error' event that would close
  // the handle, so vanish itself releases it.
  const close = () => {
    clearTimeout(timer);
    timer = undefined;
    watcher?.close();
    watcher = undefined;
  };

  const vanish = () => {
    if (gone) return;
    gone = true;
    close();
    onEvent({ kind: "vanished" });
  };

  const flush = () => {
    timer = undefined;
    if (gone) return;
    if (!fs.existsSync(absDir)) return vanish();
    const files = [...pending];
    pending.clear();
    for (const file of files) onEvent({ kind: "session-file", filePath: path.join(absDir, file) });
  };

  try {
    watcher = fs.watch(absDir, { persistent: false }, (_eventType, filename) => {
      if (gone || !filename) return;
      const name = filename.toString();
      if (!name.endsWith(".jsonl") || name.includes(".jsonl.")) return;
      pending.add(name);
      timer ??= setTimeout(flush, 100);
    });
    watcher.on("error", vanish);
  } catch {
    // Dir doesn't exist (yet or anymore) — report asynchronously so the
    // caller finishes wiring before the event lands.
    setImmediate(vanish);
  }

  return () => {
    gone = true;
    close();
  };
}

/**
 * Trailing debounce for gitdir churn (#498): a checkout moves HEAD via a
 * rename (several raw events), refs and logs move alongside it — one refresh
 * per burst is the answer, and each refresh costs only a local-refs listing.
 */
const GIT_CHURN_DEBOUNCE_MS = 150;

export interface WatchGitHeadOptions {
  /**
   * Called once when the gitdir vanished or the watch failed after it was
   * established; the watcher is already closed by then.
   */
  onGone?: () => void;
  /** git-runner test seam, same stance as branches.ts. */
  runGit?: (cwd: string, args: string[]) => Promise<string>;
}

/**
 * Watches one project checkout's git directory (#498). Resolves the HEAD path
 * with `git rev-parse --git-path HEAD` (worktree- and separate-gitdir-aware),
 * watches its directory, and fires onEvent on any churn with a trailing
 * debounce — HEAD rename-on-write makes file-level watches unreliable, and
 * dir churn costs one local-refs listing, no network. Rejects when the path
 * is not a repository; resolves a dispose function otherwise.
 */
export async function watchGitHead(
  projectCwd: string,
  onEvent: () => void,
  opts: WatchGitHeadOptions = {},
): Promise<() => void> {
  const headPath = (
    await (opts.runGit ?? git)(projectCwd, ["rev-parse", "--git-path", "HEAD"])
  ).trim();
  if (headPath === "") throw new Error(`git-path HEAD resolved empty for ${projectCwd}`);
  const dir = path.dirname(path.resolve(projectCwd, headPath));

  let watcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const close = () => {
    closed = true;
    clearTimeout(timer);
    timer = undefined;
    watcher?.close();
    watcher = undefined;
  };

  const gone = () => {
    if (closed) return;
    close();
    opts.onGone?.();
  };

  const flush = () => {
    timer = undefined;
    if (closed) return;
    // A deleted gitdir may never produce an 'error' event on every platform
    // (same stance as watchLineageDir): the flush checks and releases the fd.
    if (!fs.existsSync(dir)) {
      gone();
      return;
    }
    onEvent();
  };

  try {
    watcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
      if (closed || timer !== undefined || !filename) return;
      timer = setTimeout(flush, GIT_CHURN_DEBOUNCE_MS);
    });
    watcher.on("error", gone);
  } catch {
    // The gitdir vanished between the probe and the watch: nothing to watch.
    // Later refreshes keep answering from the last snapshot (#498).
    return () => {};
  }

  return close;
}
