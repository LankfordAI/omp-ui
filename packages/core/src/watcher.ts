import * as fs from "node:fs";
import * as path from "node:path";

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
