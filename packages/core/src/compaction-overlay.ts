import * as fs from "node:fs";
import * as path from "node:path";

const OVERLAY_NAME = "omp-ui-compaction.yml";

export function compactionMethodOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

export function writeCompactionMethodOverlay(
  lineageDir: string,
  preferred: string | null,
  configuredOrder: readonly string[],
): string | null {
  const file = compactionMethodOverlayPath(lineageDir);
  if (preferred === null) {
    try {
      fs.rmSync(file);
    } catch {
      // Absent is the requested state.
    }
    return null;
  }
  const order = [preferred, ...configuredOrder.filter((id) => id !== preferred)];
  fs.mkdirSync(lineageDir, { recursive: true });
  fs.writeFileSync(
    file,
    `compaction:\n  methodOrder:\n${order.map((id) => `    - ${quote(id)}\n`).join("")}`,
    "utf8",
  );
  return file;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
