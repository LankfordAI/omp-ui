import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Replaces a text file through a same-directory temporary file, so readers
 * observe either the previous complete contents or the new complete contents.
 */
export function writeTextAtomic(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, text);
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
