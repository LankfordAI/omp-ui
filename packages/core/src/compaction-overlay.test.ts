import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compactionMethodOverlayPath,
  writeCompactionMethodOverlay,
} from "./compaction-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeCompactionMethodOverlay", () => {
  it("promotes the preferred method and preserves configured fallback order", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-compaction-test-"));
    dirs.push(dir);
    const file = writeCompactionMethodOverlay(dir, "soft", ["remote", "soft", "shake"]);
    expect(file).toBe(compactionMethodOverlayPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe(
      'compaction:\n  methodOrder:\n    - "soft"\n    - "remote"\n    - "shake"\n',
    );
  });

  it("removes an old overlay when the preference is cleared", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-compaction-test-"));
    dirs.push(dir);
    writeCompactionMethodOverlay(dir, "soft", []);
    expect(writeCompactionMethodOverlay(dir, null, [])).toBeNull();
    expect(fs.existsSync(compactionMethodOverlayPath(dir))).toBe(false);
  });
});
