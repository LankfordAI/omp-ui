import * as fs from "node:fs";

/**
 * Shared plumbing for the per-lineage artifacts omp-ui generates at spawn:
 * the `--config` YAML overlays (advisor, model, compaction) and the `-e`
 * extensions (plan, advisor-stats, mcp-status). Every artifact lives inside
 * the session's own lineage dir, so the dir is created with it, and the file
 * dies with the lineage.
 *
 * omp loads these files strictly: a missing or malformed overlay/extension is
 * a hard startup error, so every write lands synchronously before spawn —
 * never lazily.
 */

/**
 * Creates `lineageDir` when absent, writes `content` (utf8) to `file`, and
 * returns `file` — the path to pass to omp as `--config` or `-e`.
 */
export function writeLineageArtifact(lineageDir: string, file: string, content: string): string {
  fs.mkdirSync(lineageDir, { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/**
 * The "no artifact" state for a per-lineage writer: delete `file`. Absent is
 * success — the artifact was never written, or an earlier call already
 * removed it.
 */
export function removeLineageArtifact(file: string): void {
  try {
    fs.rmSync(file);
  } catch {
    // Absent is the requested state.
  }
}

/**
 * Double-quote with backslash escaping — the one YAML string form that can
 * carry anything. Overlay values are user-influenced (model ids, method
 * names), so they are quoted rather than trusted.
 */
export function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
