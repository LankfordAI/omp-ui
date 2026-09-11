import * as fs from "node:fs";
import * as path from "node:path";

/** One generation is kept beside the live file, so a log caps at ~2 MiB. */
const MAX_LOG_BYTES = 1024 * 1024;

/**
 * Append one ISO-timestamped line to a bounded log under userData/logs.
 * Rotates once at 1 MiB (name → name.old, truncating name). Never throws —
 * logging must not crash the main process.
 */
export function appendMainLog(logDir: string, name: string, line: string): void {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, name);
    const entry = `${new Date().toISOString()} ${line}\n`;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // First write.
    }
    if (size + Buffer.byteLength(entry) > MAX_LOG_BYTES) {
      try {
        fs.renameSync(file, path.join(logDir, `${name}.old`));
      } catch {
        // Nothing to rotate — append anyway.
      }
    }
    fs.appendFileSync(file, entry);
  } catch {
    // Telemetry never takes the app down (issue #184).
  }
}
