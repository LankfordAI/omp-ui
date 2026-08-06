import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Full-fidelity session fork (issue #83): copies a session `.jsonl` into a new
 * lineage dir under a fresh session id, ready for `--resume`. omp's own
 * `branch` RPC rewinds to the fork point's PARENT and switches the live
 * process in place — the wrong semantics for a "branch this session" button,
 * which must preserve the source session and keep every message, including
 * the last one. A copied file gives exactly that: entries keep their
 * id/parentId chain (self-contained per file), and the header's
 * `parentSession` keeps omp's lineage-tree linkage pointing at the source.
 *
 * Artifacts (the sibling extension-less dirs) are NOT copied: their entries
 * reference the source lineage by absolute path, which stays valid because
 * the source session is preserved.
 */

/**
 * Writes the fork next to `destLineageDir` and returns the new file's path.
 * Throws on a missing session header or an unparseable line — a corrupt fork
 * must never reach `--resume`.
 */
export async function forkSessionFile(
  sourceFile: string,
  destLineageDir: string,
  newSessionId: string,
  now: Date = new Date(),
): Promise<string> {
  const raw = await fs.promises.readFile(sourceFile, "utf8");
  // A live session can be mid-append: drop a torn tail line rather than ship it.
  const whole = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  const lines = whole
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "session") {
        entry.id = newSessionId;
        entry.timestamp = now.toISOString();
        entry.parentSession = sourceFile;
      }
      return JSON.stringify(entry);
    });
  if (!lines.some((line) => line.includes('"type":"session"'))) {
    throw new Error(`session file ${sourceFile} has no session header`);
  }
  await fs.promises.mkdir(destLineageDir, { recursive: true });
  // omp's filename clock: `2026-08-06T04-51-50-649Z` — ISO with `:` and `.` flattened.
  const forked = path.join(
    destLineageDir,
    `${now.toISOString().replace(/:/g, "-").replace(".", "-")}_${newSessionId}.jsonl`,
  );
  await fs.promises.writeFile(forked, `${lines.join("\n")}\n`, "utf8");
  return forked;
}
