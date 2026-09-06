import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Replaces a text file through a same-directory temporary file, so readers
 * observe either the previous complete contents or the new complete contents.
 * An explicit `mode` applies to a CREATED file; replacing an existing file
 * preserves its current mode through the temp-and-rename.
 */
export function writeTextAtomic(filePath: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  const fileMode = mode ?? (fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : undefined);
  try {
    fs.writeFileSync(temporaryPath, text, fileMode === undefined ? undefined : { mode: fileMode });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the write/rename error; cleanup is best effort.
    }
    throw error;
  }
}
