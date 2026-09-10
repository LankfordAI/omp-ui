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

/** Distinguishes concurrent durable writes of one path within a process. */
let durableWriteSeq = 0;

/**
 * Durable replace: same-directory temp → fsync(temp) → rename → fsync(dir),
 * so the new contents survive a power cut once this returns — not just a
 * process crash, which is all `writeTextAtomic` defends against. `mode`
 * applies to the temp before rename; omitted, an existing file keeps its
 * mode and a new file gets 0o600 (host state is private by default). The
 * directory fsync is skipped on Windows when opening the directory throws
 * (EISDIR/EPERM/EACCES — NTFS has no directory fsync). On any failure the
 * temp is removed and the original error propagates.
 */
export function writeTextDurably(filePath: string, text: string, mode?: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const fileMode = mode ?? (fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : 0o600);
  durableWriteSeq += 1;
  const temporaryPath = `${filePath}.tmp-${process.pid}-${durableWriteSeq}`;
  try {
    const fd = fs.openSync(temporaryPath, "w", fileMode);
    try {
      const bytes = Buffer.from(text, "utf8");
      let written = 0;
      while (written < bytes.length) {
        written += fs.writeSync(fd, bytes, written, bytes.length - written);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // openSync's mode is umask-masked; chmod makes it exact.
    try {
      fs.chmodSync(temporaryPath, fileMode);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the write/rename error; cleanup is best effort.
    }
    throw error;
  }
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
